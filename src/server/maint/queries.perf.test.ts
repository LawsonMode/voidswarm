// OWNER: SERVER MODERATION (LAN task B8a). Acceptance at 1M chat lines (docs/LAN-EDITION-proposal.md §11.6, §5.16):
//  - T-ADM-7: a `log` search returns within 50 ms, from the worker;
//  - T-PERF-2: for each panel read (search, context, rooms, stats, reveal, conduct, a streamed export) the main
//    thread's event-loop delay stays at p99 < 5 ms and max < 20 ms while it runs in the worker — with the game
//    thread writing chat meanwhile — and the game thread's own point queries (ban checks, /log, /whois, a report
//    snapshot) and chat writes stay inside the same budget.
// The game connection runs as recommended (GAME_THREAD_STORE_OPTIONS: walAutoCheckpoint 0, txRows 1, flushBudgetMs 3) with
// the worker checkpointing every second (QUERY_OPS 'wal.checkpoint'). The database is left as the v4 migration leaves
// it (the FTS 'rebuild' only), then gets the start-up tidy through the worker's real op ('fts.optimize', what
// MaintService.startupTidy runs before the listener opens). PRECONDITION: before that tidy, FTS5's merges inside the
// game thread's chat commits took up to ~110 ms at 1M lines, so the tidy must run after the v4 migration (the
// migration itself leaves mod_meta.fts_dirty unset: see the B8a report's handoff). The fixture also holds the worst
// cases: one student with a seventh of the log, a review-only tag on ~30% of lines, a lobby with ~30% of it.
// The acceptance run is local (`npm test`): 1,000,000 rows (the database takes ~15 s to build and tidy and ~500 MB of
// temp space). On CI (CI=true: the Pages build's shared runners) the default is 250,000 rows and the budgets double,
// so a busy runner does not block a deploy; VS_PERF_ROWS sets the row count anywhere (VS_PERF_ROWS=1000000 on CI).
// Under the full parallel `npm test` the other files load every core: a run over budget is tried again after a pause
// (best of up to 6), and the game-thread timings carry a load gauge (pure computation timed between the calls) whose
// preemption in a run that never fit is allowed on top of the budget (verifier round 2; ~0 on a quiet machine).
// The last block is the running server's other state (verifier round 2): an index grown line by line and never
// optimized (no purge yet: the first 90 days, 'forever' retention). There FTS5's automerge inside a 1-line game
// commit took 20-45 ms (up to ~300 ms) every few dozen commits, so the game connection runs with automerge off and the
// worker merges (ModStore ftsMerge 'worker', 'wal.checkpoint'). 250,000 lines (~17 s to build; CI 100,000;
// VS_PERF_ORGANIC_ROWS sets it). It measures the PRODUCTION configuration (no test override), so it stays red while
// the §6.5 guard (db/guard.ts ftsConfigSnapshot) compares the FTS merge settings: the store may then not turn automerge
// off (ModStore ftsMergeTunable), and T-PERF-2 is not met on such an index.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatLogEntry } from '../../shared/room/moderation';
import { ftsMergeTunable, GAME_THREAD_STORE_OPTIONS, INLINE_STORE_OPTIONS, ModStore } from '../moderation/store';
import type { MaintClient } from './client';
import type { ChatLogRow, LogPage } from './queries';
import { markIndexDirty } from './erase';
import { buildBigLog, startQueryWorker, type BigLog } from './queries.testutil';
import { open } from './testutil';
import { tmpData, type TmpData } from './testutil';

const ROWS = Math.max(10_000, Number(process.env.VS_PERF_ROWS) || (process.env.CI ? 250_000 : 1_000_000));
const ORGANIC_ROWS = Math.max(10_000, Number(process.env.VS_PERF_ORGANIC_ROWS) || (process.env.CI ? 100_000 : 250_000));
const SLOW = process.env.CI ? 2 : 1;
const SEARCH_MS = 50 * SLOW;
const LOOP_P99_MS = 5 * SLOW;
const LOOP_MAX_MS = 20 * SLOW;
const DAY = 86_400_000;
const END = Date.UTC(2026, 8, 28, 20, 0, 0);

let t: TmpData;
let big: BigLog;
let worker: MaintClient;
let store: ModStore;
let ckpt: ReturnType<typeof setInterval> | null = null;

beforeAll(async () => {
  t = tmpData('vs-perf-');
  big = buildBigLog(t.db, { rows: ROWS, end: END });
  worker = await startQueryWorker(t);
  // the start-up tidy (MaintService.startupTidy: fts_dirty set → 'fts.optimize' in the worker)
  const raw = open(t.db);
  try { markIndexDirty(raw, 1); } finally { raw.close(); }
  const tidy = await worker.call<{ ms: number; tidied: number }>('fts.optimize', undefined, { timeoutMs: 120_000 });
  expect(tidy.tidied).toBe(1);
  store = new ModStore(t.db, { log: () => {}, busyTimeoutMs: 250, ...GAME_THREAD_STORE_OPTIONS });
  // the recommended upkeep: the worker checkpoints, the game thread never does
  ckpt = setInterval(() => { void worker.call('wal.checkpoint', { mode: 'passive' }).catch(() => undefined); }, 1000);
  await worker.call('log.search', { q: 'warm up the cache' });
}, 300_000);

afterAll(async () => {
  if (ckpt) clearInterval(ckpt);
  try { store?.close(); } catch { /* closed */ }
  try { await worker?.close(); } catch { /* closed */ }
  t?.cleanup();
});

let seq = 0;
const line = (): ChatLogEntry => {
  seq++;
  return {
    time: END + seq, roomId: 'r1', roomName: 'Flag Run', roomUid: 'bootLive:r1', channel: 'all', team: -1, playerId: 7, name: 'Pilot7',
    accountId: 'acc-7', address: '10.0.7.0', original: `live line ${seq} nice shot`, shown: `live line ${seq} nice shot`, action: seq % 50 ? 'pass' : 'mask',
    hits: seq % 50 ? [] : ['profanity:x'], display: seq % 50 ? 'as-typed' : 'substituted',
  };
};

/** Run `fn` while a 60 Hz "game tick" writes a chat line each tick; the main thread's event-loop delay meanwhile. */
async function whileGameRuns<T>(fn: () => Promise<T>): Promise<{ value: T; p99: number; max: number; flushMax: number }> {
  const h = monitorEventLoopDelay({ resolution: 1 });
  let flushMax = 0;
  const tick = setInterval(() => {
    store.logChat(line());
    const t0 = performance.now();
    try { store.flush(); } catch { /* busy: stays buffered */ }
    flushMax = Math.max(flushMax, performance.now() - t0);
  }, 16);
  h.enable();
  try {
    const value = await fn();
    await new Promise((r) => setTimeout(r, 20));
    return { value, p99: h.percentile(99) / 1e6, max: h.max / 1e6, flushMax };
  } finally {
    h.disable();
    clearInterval(tick);
  }
}

/**
 * A run over budget is tried again after this pause (up to RETRIES more times): under the full parallel `npm test`
 * the other test files load every core for a while, and a preempted thread loses a whole scheduler quantum (5-10 ms
 * on Windows) whatever the code does. The pause lets such a burst pass instead of measuring it again at once.
 */
const RETRY_PAUSE_MS = 750;
const RETRIES = 5;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const overBudget = (r: { p99: number; max: number }): number => Math.max(r.p99 / LOOP_P99_MS, r.max / LOOP_MAX_MS);

/** Best of up to 1 + RETRIES runs, pausing between them (a busy machine must not fail a budget a quiet one keeps). */
async function best<T extends { p99: number; max: number }>(run: () => Promise<T>): Promise<T> {
  let out = await run();
  for (let k = 0; k < RETRIES && overBudget(out) >= 1; k++) {
    await sleep(RETRY_PAUSE_MS);
    const next = await run();
    if (overBudget(next) < overBudget(out)) out = next;
  }
  return out;
}

/**
 * The load gauge: pure computation (no allocation, no I/O) timed between the calls a budget is about, each chunk as
 * long as one call. On a quiet machine its worst chunk is its median; the excess of its worst over its median is what
 * the scheduler took from this thread in that run (preemption by the rest of the suite), not the code under test.
 */
let spinSink = 0;
function spin(units: number): void {
  let x = spinSink;
  for (let i = 0; i < units; i++) x = (x * 1103515245 + 12345) % 2147483648;
  spinSink = x;
}
let spinPerMsCache = 0;
/** Gauge loop turns per ms on this machine (the fastest of 20 tries, so a loaded moment does not skew it). */
function spinPerMs(): number {
  if (spinPerMsCache) return spinPerMsCache;
  let fastest = Infinity;
  for (let k = 0; k < 20; k++) {
    const t0 = performance.now();
    spin(200_000);
    fastest = Math.min(fastest, performance.now() - t0);
  }
  spinPerMsCache = 200_000 / Math.max(1e-3, fastest);
  return spinPerMsCache;
}
const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);
const pct = (xs: number[], p: number): number => { const s = sorted(xs); return s[Math.min(s.length - 1, Math.floor(s.length * p))]!; };

async function timed<T>(f: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await f();
  return { ms: performance.now() - t0, value };
}

describe(`T-ADM-7: log searches at ${ROWS.toLocaleString('en-US')} rows, from the worker`, () => {
  // Every search answers within the budget; all but the marked worst cases (a filter that matches nothing over a
  // scope of 100k+ lines: the worker stops at its 35 ms budget with an empty partial page the "Older" button
  // continues, pinned by the next test) answer COMPLETE: the page filled, or the matches ran out.
  const PARTIAL_OK = new Set([
    'a tag and a word', 'that student and a word nobody typed', 'that student, the common tag and a word nobody typed',
    'that tag and a word nobody typed', 'that tag and a channel it never has', 'a lobby with ~30% of the log and a word nobody typed',
    'a common word and a rare filter',
  ]);
  const searches: [string, () => Record<string, unknown>][] = [
    ['a common word', () => ({ q: 'the' })],
    ['a phrase', () => ({ q: 'nice shot' })],
    ['a rare token', () => ({ q: big.rareToken })],
    ['no match at all', () => ({ q: 'zzqxv' })],
    ['a phrase in the last 7 days', () => ({ q: 'hold the', since: END - 7 * DAY })],
    ['a phrase long ago (Sep 1)', () => ({ q: 'retreat', since: Date.UTC(2026, 8, 1), until: Date.UTC(2026, 8, 1, 23) })],
    ['a phrase by one student', () => ({ q: 'heal', accountId: 'acc-42' })],
    ['a phrase by a guest callsign', () => ({ q: 'push back', player: 'Guest260' })],
    ['shown text only (moderator)', () => ({ q: 'gg, pil', searchIn: 'shown' })],
    ['a tag and a word', () => ({ tag: 'PROFANITY', q: 'laser' })],
    ['a 2-letter search (7 days, LIKE)', () => ({ q: 'ok' })],
    ['a 2-letter search on a day long ago (LIKE, the 7 days before its end)', () => ({ q: 'ok', since: Date.UTC(2026, 8, 1), until: Date.UTC(2026, 8, 1, 23) })],
    ['one room', () => ({ roomUid: big.roomUids[5] })],
    ['one room and a rare word', () => ({ roomUid: big.roomUids[5], q: 'repair ammo' })],
    ['team chat, flagged, today', () => ({ channel: 'team', action: 'flagged', since: END - DAY })],
    ['the newest page', () => ({})],
    // the worst cases (verifier round 1): heavy students, common tags, huge rooms, long common phrases
    ['one student with a seventh of the log', () => ({ accountId: big.heavyAccount })],
    ['that student by callsign (callsign + account indexes)', () => ({ player: big.heavyName })],
    ['that student, a page far back', () => ({ accountId: big.heavyAccount, before: Math.floor(ROWS / 2) })],
    ['that student and a word nobody typed', () => ({ accountId: big.heavyAccount, q: 'zzqxv' })],
    ['that student, the common tag and a word nobody typed', () => ({ accountId: big.heavyAccount, tag: big.commonTag, q: 'zzqxv' })],
    ['a review tag on ~30% of lines', () => ({ tag: big.commonTag })],
    ['that tag and a word nobody typed', () => ({ tag: big.commonTag, q: 'zzqxv' })],
    ['that tag and a channel it never has', () => ({ tag: big.commonTag, channel: 'announce' })],
    ['a lobby with ~30% of the log and a word nobody typed', () => ({ roomUid: big.bigRoomUid, q: 'zzqxv' })],
    ['a common word and a rare filter', () => ({ q: 'the', channel: 'announce' })],
    ['a phrase of common trigrams', () => ({ q: 'the the the' })],
    ['a long phrase of common words (100 characters)', () => ({ q: 'the a to and pilot go left right nice shot gg flag base zone help me here now wait come on team red' })],
    ['an average student, shown text only', () => ({ accountId: 'acc-42', q: 'gg, pil', searchIn: 'shown' })],
  ];
  it('every worst case named above is one of the searches', () => {
    for (const name of PARTIAL_OK) expect(searches.map(([n]) => n)).toContain(name);
  });
  for (const [name, args] of searches) {
    const partialOk = PARTIAL_OK.has(name);
    it(`${name}: within ${SEARCH_MS} ms${partialOk ? ' (a partial page allowed)' : ', complete'}`, async () => {
      let ms = Infinity;
      let page: LogPage | null = null;
      // best of 3 (the rest of the suite shares the CPU): the fastest answer, and a complete one where required
      for (let k = 0; k < 3 && (ms >= SEARCH_MS || (!partialOk && page!.partial)); k++) {
        const r = await timed(() => worker.call<LogPage>('log.search', { ...args(), limit: 100 }));
        if (r.ms < ms || (!partialOk && page!.partial && !r.value.partial)) { ms = r.ms; page = r.value; }
      }
      const text = `${name}: ${ms.toFixed(1)} ms (${page?.plan}, ${page?.lines.length} rows${page?.partial ? ', partial' : ''})`;
      if (process.env.VS_PERF_REPORT) console.log(text);
      expect(ms, text).toBeLessThan(SEARCH_MS);
      if (!partialOk) {
        expect(page!.partial, text).toBe(false);
        expect(page!.lines.length === 100 || page!.nextBefore === null, text).toBe(true);
      } else expect(page!.lines.length > 0 || page!.nextBefore === null || page!.partial, text).toBe(true);
    }, 30_000);
  }

  it('partial pages continue to the same answer as one exact scan (a whole-log text, a heavy student, a common tag)', async () => {
    for (const q of [{ q: 'zzqxv' }, { accountId: big.heavyAccount, q: 'zzqxv' }, { tag: big.commonTag, channel: 'announce' }, { roomUid: big.bigRoomUid, q: 'zzqxv' }]) {
      let before: number | null | undefined;
      let beforeTs: number | null | undefined;
      let calls = 0;
      do {
        const r = await timed(() => worker.call<LogPage>('log.search', { ...q, before: before ?? undefined, beforeTs: beforeTs ?? undefined }));
        expect(r.value.lines).toEqual([]);
        expect(r.ms, JSON.stringify(q)).toBeLessThan(SEARCH_MS * 2);
        before = r.value.nextBefore;
        beforeTs = r.value.nextBeforeTs;
        calls++;
      } while (before !== null && calls < 200);
      expect(before, JSON.stringify(q)).toBeNull();
    }
  }, 120_000);
});

describe(`T-PERF-2: the main thread stays free while the panel reads run (${ROWS.toLocaleString('en-US')} rows)`, () => {
  const endpoints: [string, () => Promise<unknown>][] = [
    ['log (text search)', () => worker.call('log.search', { q: 'nice shot', limit: 100 })],
    ['log (all filters, 1000 rows)', () => worker.call('log.search', { since: END - 30 * DAY, channel: 'all', action: 'pass', limit: 1000 })],
    ['log (a rare filter over the whole log)', () => worker.call('log.search', { display: 'withheld', limit: 100 })],
    ['log (the heavy student and a word nobody typed)', () => worker.call('log.search', { accountId: big.heavyAccount, q: 'zzqxv', limit: 100 })],
    ['log (a long phrase of common words)', () => worker.call('log.search', { q: 'the a to and pilot go left right nice shot gg flag base zone help me here now', limit: 100 })],
    ['log/context', () => worker.call('log.context', { id: Math.floor(ROWS / 2), before: 50, after: 50 })],
    ['log/rooms (everything)', () => worker.call('log.rooms', { limit: 1000 })],
    ['log/rooms (7 days)', () => worker.call('log.rooms', { since: END - 7 * DAY })],
    ['log/stats (fresh)', () => worker.call('log.stats', { fresh: true, days: 400 })],
    ['log/reveal (100 ids)', () => worker.call('log.reveal', { ids: big.taggedIds.slice(0, 100) })],
    ['log/reveal (one student)', () => worker.call('log.reveal', { accountId: 'acc-9', limit: 500 })],
    ['conduct (tally)', () => worker.call('conduct.tally', { ranges: { today: { sinceDay: Math.floor(END / DAY) }, week: { sinceDay: Math.floor(END / DAY) - 6 }, all: {} } })],
    ['log/export (a week, streamed)', async () => {
      let n = 0;
      for await (const rows of worker.stream<ChatLogRow>('log.export', { since: END - 7 * DAY, includeOriginal: true })) n += rows.length;
      expect(n).toBeGreaterThan(ROWS / 20);
      return n;
    }],
  ];
  for (const [name, run] of endpoints) {
    it(`${name}: loop delay p99 < ${LOOP_P99_MS} ms, max < ${LOOP_MAX_MS} ms`, async () => {
      const r = await best(() => whileGameRuns(async () => { for (let k = 0; k < 3; k++) await run(); }));
      if (process.env.VS_PERF_REPORT) console.log(`${name}: loop p99 ${r.p99.toFixed(2)} max ${r.max.toFixed(2)} ms; slowest chat write ${r.flushMax.toFixed(2)} ms`);
      expect(r.p99, `${name}: p99 ${r.p99.toFixed(2)} ms`).toBeLessThan(LOOP_P99_MS);
      expect(r.max, `${name}: max ${r.max.toFixed(2)} ms (slowest chat write ${r.flushMax.toFixed(2)} ms)`).toBeLessThan(LOOP_MAX_MS);
    }, 120_000);
  }

  it('the game thread\'s own point queries and chat writes stay inside the budget (p99 < 5 ms, max < 20 ms each)', async () => {
    const now = END;
    const heavyHistory = store.listActions({ limit: 1000, targetAccountId: big.heavyAccount });
    expect(heavyHistory.actions).toHaveLength(1000);
    const heavyMid = heavyHistory.actions[999]!;
    const calls: [string, (i: number) => unknown][] = [
      ['recentChat (account, 20)', (i) => store.recentChat({ accountId: big.accounts[i % 250]! }, 20)],
      ['recentChat (guest callsign)', (i) => store.recentChat({ nameKey: `guest${250 + (i % 50)}` }, 20)],
      ['recentChat (callsign + its address)', (i) => { const s = 250 + (i % 50); return store.recentChat({ nameKey: `guest${s}`, address: `10.0.${s % 256}.${s % 7}` }, 20); }],
      // the worst case: an address the callsign never used (every one of its newest lines is looked at)
      ['recentChat (callsign + another address)', (i) => store.recentChat({ nameKey: `guest${250 + (i % 50)}`, address: '10.9.9.9' }, 20)],
      ['recentChat (address)', (i) => store.recentChat({ address: `10.0.${i % 256}.${i % 7}` }, 20)],
      ['recentChat (the student with a seventh of the log)', () => store.recentChat({ accountId: big.heavyAccount }, 20)],
      ['addressesOf (that student)', () => store.addressesOf({ accountId: big.heavyAccount })],
      ['flaggedCount (that student, 24 h)', () => store.flaggedCount({ accountId: big.heavyAccount }, now - DAY)],
      ['lastSeenByName', (i) => store.lastSeenByName(`guest${250 + (i % 50)}`)],
      ['addressesOf (account)', (i) => store.addressesOf({ accountId: big.accounts[i % 250]! })],
      ['addressesOf (guest)', (i) => store.addressesOf({ nameKey: `guest${250 + (i % 50)}` })],
      ['flaggedCount (24 h)', (i) => store.flaggedCount({ accountId: big.accounts[i % 250]! }, now - DAY)],
      ['liveBans (ban checks)', () => store.liveBans(now)],
      ['listActions (whois, account)', (i) => store.listActions({ limit: 20, targetAccountId: big.accounts[i % 250]! })],
      ['listActions (whois, guest)', (i) => store.listActions({ limit: 20, targetName: `Guest${250 + (i % 50)}`, targetAddress: `10.0.${250 + (i % 50)}.1` })],
      // the worst cases: a fifth of the audit trail about one student, and about one guest; a page deep in it
      ['listActions (whois, the student with a fifth of the audit trail)', () => store.listActions({ limit: 20, targetAccountId: big.heavyAccount })],
      ['listActions (whois, the guest with a fifth of it)', () => store.listActions({ limit: 20, targetName: big.heavyAuditGuest.name, targetAddress: big.heavyAuditGuest.address })],
      ['listActions (that student, a page deep in the history)', () => store.listActions({ limit: 20, targetAccountId: big.heavyAccount, before: heavyMid.id, beforeTs: heavyMid.ts })],
      ['accountByUsername', (i) => store.accountByUsername(`Pilot${i % 250}`)],
      ['listReports', () => store.listReports({ status: 'open', limit: 50 })],
      ['a chat write (1 line)', () => { store.logChat(line()); store.flush(); }],
      ['a chat write (a 50-line burst, one budgeted flush call)', () => { for (let k = 0; k < 50; k++) store.logChat(line()); store.flush(); }],
    ];
    const report: string[] = [];
    const results: { p99: number; max: number; slack: number; text: string }[] = [];
    const perMs = spinPerMs();
    for (const [name, call] of calls) {
      for (let i = 0; i < 5; i++) call(i); // warm
      const probe: number[] = [];
      for (let i = 0; i < 9; i++) { const t0 = performance.now(); call(i); probe.push(performance.now() - t0); }
      const gaugeUnits = Math.max(1, Math.round(Math.max(0.1, pct(probe, 0.5)) * perMs));
      // Runs of 200 calls, each followed by one gauge chunk as long as a call; best of up to 1 + RETRIES runs with a
      // pause between them (the rest of the suite shares the CPU; a real blow-up fails every run).
      let bestRun: { p50: number; p99: number; max: number; jitter: number } | null = null;
      for (let run = 0; run <= RETRIES && (!bestRun || overBudget(bestRun) >= 1); run++) {
        if (run > 0) await sleep(RETRY_PAUSE_MS);
        const ms: number[] = [];
        const gauge: number[] = [];
        for (let i = 0; i < 200; i++) {
          let t0 = performance.now();
          call(i);
          ms.push(performance.now() - t0);
          t0 = performance.now();
          spin(gaugeUnits);
          gauge.push(performance.now() - t0);
        }
        const r = { p50: pct(ms, 0.5), p99: pct(ms, 0.99), max: pct(ms, 1), jitter: Math.max(0, pct(gauge, 1) - pct(gauge, 0.5)) };
        if (!bestRun || overBudget(r) < overBudget(bestRun)) bestRun = r;
      }
      const { p50, p99, max, jitter } = bestRun!;
      // A run that never fit on a loaded machine: what the scheduler took from this thread in that same run (the
      // gauge's worst chunk over its median) is allowed on top; on a quiet machine that is ~0 and the budget is exact.
      const slack = overBudget(bestRun!) >= 1 ? jitter : 0;
      report.push(`${name}: p50 ${p50.toFixed(3)} p99 ${p99.toFixed(3)} max ${max.toFixed(3)} ms`
        + (slack ? ` (machine loaded in every run: the gauge lost up to ${slack.toFixed(2)} ms to preemption, allowed on top)` : ''));
      results.push({ p99, max, slack, text: report.at(-1)! });
    }
    store.flushAll();
    if (process.env.VS_PERF_REPORT) console.log(report.join('\n'));
    for (const r of results) {
      expect(r.p99, r.text).toBeLessThan(LOOP_P99_MS + r.slack);
      expect(r.max, r.text).toBeLessThan(LOOP_MAX_MS + r.slack);
    }
  }, 300_000);
});

describe(`T-PERF-2: 1-line chat commits on an index grown line by line, never optimized (${ORGANIC_ROWS.toLocaleString('en-US')} rows)`, () => {
  let o: TmpData;
  let ow: MaintClient;
  let os: ModStore;
  let upkeep: ReturnType<typeof setInterval> | null = null;
  let merged = 0;
  const segments = (): number => {
    const raw = open(o.db);
    try { return Number((raw.prepare('SELECT count(DISTINCT segid) AS n FROM chat_fts_idx').get() as { n: number }).n); } finally { raw.close(); }
  };

  beforeAll(async () => {
    o = tmpData('vs-perf-organic-');
    buildBigLog(o.db, { rows: ORGANIC_ROWS, end: END, organicTxRows: 100, actions: 1000 });
    ow = await startQueryWorker(o);
    // The production configuration, no override: where the §6.5 guard still compares the FTS merge settings
    // (ftsMergeTunable() false), the game connection keeps FTS5's inline merges and the flush budget below fails.
    os = new ModStore(o.db, { log: () => {}, busyTimeoutMs: 250, ...GAME_THREAD_STORE_OPTIONS });
    // the per-second upkeep: merges, then the checkpoint
    upkeep = setInterval(() => {
      void ow.call<{ merge: { steps: number } | null }>('wal.checkpoint', { mode: 'passive' }).then((r) => { merged += r.merge?.steps ?? 0; }, () => undefined);
    }, 1000);
  }, 300_000);

  afterAll(async () => {
    if (upkeep) clearInterval(upkeep);
    try { os?.close(); } catch { /* closed */ }
    try { await ow?.close(); } catch { /* closed */ }
    o?.cleanup();
  });

  it('the production game connection runs with automerge off (GAME_THREAD_STORE_OPTIONS: the worker merges)', () => {
    // Needs the §6.5 guard to leave chat_fts_config's automerge (0-16) and crisismerge (2-64) out of its comparison
    // (db/guard.ts ftsConfigSnapshot, B3; the B8a handoff): until then FTS5 merges inside 1-line game commits (20-45 ms,
    // up to ~300 ms, on this index), which T-PERF-2 does not allow. Deliberately red until it lands, never skipped.
    expect(ftsMergeTunable(), 'db/guard.ts ftsConfigSnapshot still compares the FTS merge settings (automerge, crisismerge): T-PERF-2 fails on a grown index').toBe(true);
    expect(os.ftsMergeMode()).toBe('worker');
  });

  it(`60 Hz chat plus a 20-line burst a second for 15 s: every flush call p99 < ${LOOP_P99_MS} ms, max < ${LOOP_MAX_MS} ms; the worker keeps the index merged`, async () => {
    const before = segments();
    const ms: number[] = [];
    let busy = 0;
    let n = 0;
    const next = (): ChatLogEntry => {
      n++;
      return {
        time: END + 3_600_000 + n * 50, roomId: 'r2', roomName: 'Hot Point', roomUid: 'bootOrg:r2', channel: n % 5 ? 'all' : 'team', team: n % 5 ? -1 : 1,
        playerId: n % 30, name: `Pilot${n % 30}`, accountId: `acc-${n % 30}`, address: '10.0.2.0', original: `organic ${n} hold the base push left`,
        shown: `organic ${n} hold the base push left`, action: 'pass', hits: [], display: 'as-typed',
      };
    };
    await new Promise<void>((resolve) => {
      let ticks = 0;
      const tick = setInterval(() => {
        ticks++;
        os.logChat(next());
        if (ticks % 60 === 0) for (let k = 0; k < 20; k++) os.logChat(next());
        const t0 = performance.now();
        try { os.flush(); } catch { busy++; }
        ms.push(performance.now() - t0);
        if (ticks >= 900) { clearInterval(tick); resolve(); }
      }, 16);
    });
    os.flushAll({ waitMs: 1000 });
    ms.sort((a, b) => a - b);
    const p99 = ms[Math.floor(ms.length * 0.99)]!;
    const max = ms[ms.length - 1]!;
    // The last second's commits (up to ~80 one-line segments) may not have met an upkeep yet: one more worker merge
    // (what the next per-second upkeep does), then the count.
    const last = await ow.call<{ steps: number; pending: boolean }>('fts.merge', { maxMs: 2000 });
    const after = segments();
    const text = `organic (FTS merges: ${os.ftsMergeMode()}): ${n} lines in ${ms.length} flush calls, p50 ${ms[Math.floor(ms.length / 2)]!.toFixed(2)} `
      + `p99 ${p99.toFixed(2)} max ${max.toFixed(2)} ms, ${ms.filter((x) => x >= LOOP_MAX_MS).length} at or over ${LOOP_MAX_MS} ms; `
      + `busy ${busy}; segments ${before} → ${after}; worker merge steps ${merged} (+${last.steps} at the end)`;
    if (process.env.VS_PERF_REPORT) console.log(text);
    expect(p99, text).toBeLessThan(LOOP_P99_MS);
    expect(max, text).toBeLessThan(LOOP_MAX_MS);
    expect(merged, text).toBeGreaterThan(0);
    // ~1,200 one-line commits would leave ~1,200 segments unmerged: the worker keeps the count near where it began
    expect(last.pending, text).toBe(false);
    expect(after, text).toBeLessThan(before + 32);
  }, 120_000);

  it('text searches on this index (many segments) still answer within the budget, from the worker', async () => {
    for (const q of [{ q: 'nice shot' }, { q: 'quasarvoxel' }, { q: 'the' }, { q: 'hold the base push left' }, { tag: 'GANG', q: 'laser' }]) {
      let ms = Infinity;
      let page: LogPage | null = null;
      for (let k = 0; k < 3 && ms >= SEARCH_MS; k++) {
        const r = await timed(() => ow.call<LogPage>('log.search', { ...q, limit: 100 }));
        if (r.ms < ms) { ms = r.ms; page = r.value; }
      }
      const text = `organic ${JSON.stringify(q)}: ${ms.toFixed(1)} ms (${page?.plan}, ${page?.lines.length} rows${page?.partial ? ', partial' : ''})`;
      if (process.env.VS_PERF_REPORT) console.log(text);
      expect(ms, text).toBeLessThan(SEARCH_MS);
    }
  }, 60_000);

  it('production: GAME_THREAD_STORE_OPTIONS alone turns the game connection automerge off, INLINE_STORE_OPTIONS back on', () => {
    // red, not skipped, until the §6.5 guard change lands (see the first test of this block)
    expect(ftsMergeTunable(), 'db/guard.ts ftsConfigSnapshot still compares the FTS merge settings').toBe(true);
    const s = new ModStore(o.db, { log: () => {}, ...INLINE_STORE_OPTIONS });
    try { expect(s.ftsMergeMode()).toBe('inline'); } finally { s.close(); }
    const g = new ModStore(o.db, { log: () => {}, ...GAME_THREAD_STORE_OPTIONS });
    try { expect(g.ftsMergeMode()).toBe('worker'); } finally { g.close(); }
  });
});
