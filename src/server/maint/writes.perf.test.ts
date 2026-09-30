// OWNER: SERVER MODERATION (LAN task B8b). T-PERF-3 (docs/LAN-EDITION-proposal.md §11.6, §5.16): a 200k-row purge in
// the maintenance worker keeps the game thread's auth writes at p99 < 50 ms and loses no chat lines.
// The fixture is B8a's synthetic school-year log (queries.testutil.ts buildBigLog) at 260k lines, left as the v4
// migration leaves it and then tidied ('fts.optimize', the start-up tidy). While the worker purges the oldest ~200k
// lines (the host's recorded purge: 'purge.chat'), the game thread
//  - writes an auth row every 10 ms on its own connection (busy_timeout 5000, like AuthStore), timing each;
//  - logs a chat line every 16 ms through ModStore (GAME_THREAD_STORE_OPTIONS) and flushes it;
//  - lets the worker checkpoint every second ('wal.checkpoint', the recommended upkeep).
// Budgets double on CI (CI=true). VS_PERF3_ROWS overrides the fixture size (default 260,000); VS_PERF3_CHUNK fixes the
// chunk size (default: adaptive). Measured on the owner's PC: adaptive p99 ~22-25 ms (max ~57-81 ms), fixed 250 p99 ~35 ms,
// fixed 100 p99 ~26 ms; the 200k lines take ~35-57 s.
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatLogEntry } from '../../shared/room/moderation';
import { openProtectedDb } from '../db/guard';
import { GAME_THREAD_STORE_OPTIONS, ModStore } from '../moderation/store';
import type { MaintClient } from './client';
import { markIndexDirty } from './erase';
import { buildBigLog, type BigLog } from './queries.testutil';
import { count, open, tmpData, type TmpData } from './testutil';
import { startWriteWorker } from './writes.testutil';

const ROWS = Math.max(210_000, Number(process.env.VS_PERF3_ROWS) || 260_000);
const PURGE_ROWS = 200_000;
const SLOW = process.env.CI ? 2 : 1;
const AUTH_P99_MS = 50 * SLOW;
const END = Date.UTC(2026, 8, 28, 20, 0, 0);

let t: TmpData;
let big: BigLog;
let worker: MaintClient;

beforeAll(async () => {
  t = tmpData('vs-perf3-');
  big = buildBigLog(t.db, { rows: ROWS, end: END, days: 60, actions: 2000 });
  worker = await startWriteWorker(t);
  const raw = open(t.db);
  try { markIndexDirty(raw, 1); } finally { raw.close(); }
  await worker.call('fts.optimize', undefined, { timeoutMs: 120_000 });
}, 300_000);

afterAll(async () => {
  try { await worker?.close(); } catch { /* closed */ }
  t?.cleanup();
});

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0;
};

describe('T-PERF-3 a 200k-row purge in the worker', () => {
  it(`keeps auth write p99 < ${AUTH_P99_MS} ms and loses no chat lines`, async () => {
    // The cut that leaves ROWS - PURGE_ROWS lines: the ts of the first line to keep.
    const probe = open(t.db);
    const cut = Number((probe.prepare('SELECT ts FROM chat_log ORDER BY ts LIMIT 1 OFFSET ?').get(PURGE_ROWS) as { ts: number }).ts);
    probe.close();
    const auth: DatabaseSync = openProtectedDb(t.db, { busyTimeoutMs: 5000 });
    const store = new ModStore(t.db, { log: () => {}, busyTimeoutMs: 250, ...GAME_THREAD_STORE_OPTIONS });
    const authMs: number[] = [];
    let logged = 0;
    let running = true;
    const upd = auth.prepare('UPDATE accounts SET last_login = ? WHERE id = ?');
    const authTick = setInterval(() => {
      if (!running) return;
      const t0 = performance.now();
      upd.run(Date.now(), big.accounts[authMs.length % big.accounts.length]!);
      authMs.push(performance.now() - t0);
    }, 10);
    const chatTick = setInterval(() => {
      if (!running) return;
      logged++;
      const e: ChatLogEntry = {
        time: END + logged, roomId: 'r9', roomName: 'Perf Room', roomUid: 'perf3:r9', channel: 'all', team: -1, playerId: 9, name: 'Pilot9',
        accountId: 'acc-9', address: '10.0.9.2', original: `perf line ${logged}`, shown: `perf line ${logged}`, action: 'pass', hits: [], display: 'as-typed',
      };
      store.logChat(e);
      try { store.flush(); } catch { /* busy: stays buffered */ }
    }, 16);
    const ckpt = setInterval(() => { void worker.call('wal.checkpoint', { mode: 'passive' }).catch(() => undefined); }, 1000);
    const t0 = performance.now();
    let r: { deleted: number };
    try {
      const chunk = Number(process.env.VS_PERF3_CHUNK) || undefined;
      r = await worker.call<{ deleted: number }>('purge.chat', { before: cut, by: 'host:perf', ...(chunk ? { chunk } : {}) }, { timeoutMs: 20 * 60_000 });
    } finally {
      running = false;
      clearInterval(authTick);
      clearInterval(chatTick);
      clearInterval(ckpt);
    }
    const purgeMs = performance.now() - t0;
    store.flushAll();
    const kept = count(auth, "SELECT count(*) AS n FROM chat_log WHERE room_uid = 'perf3:r9'");
    const dropped = store.dropped;
    store.close();
    auth.close();
    const p99 = quantile(authMs, 0.99);
    const max = Math.max(...authMs);
    console.log(`[T-PERF-3] purged ${r.deleted} rows in ${(purgeMs / 1000).toFixed(1)} s; auth writes n=${authMs.length} p50 ${quantile(authMs, 0.5).toFixed(2)} ms p99 ${p99.toFixed(2)} ms max ${max.toFixed(1)} ms; chat lines logged ${logged}, written ${kept}, dropped ${dropped}`);
    expect(r.deleted).toBe(PURGE_ROWS);
    expect(authMs.length).toBeGreaterThan(50);
    expect(p99).toBeLessThan(AUTH_P99_MS);
    expect(dropped).toBe(0);
    expect(kept).toBe(logged);
  }, 20 * 60_000);
});
