// OWNER: SERVER MODERATION (LAN task B8a). Test fixture (imported by *.test.ts only): a real maintenance worker that
// knows QUERY_OPS. Once registry.ts spreads QUERY_OPS into MAINT_OPS (handoff to B5) the default worker is used;
// until then a small entry module in the test's scratch folder runs the same runMaintWorker with
// { ...MAINT_OPS, ...QUERY_OPS }.
import * as fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultWorkerFile, MaintClient, type MaintClientOptions } from './client';
import { MAINT_OPS } from './registry';

const here = (f: string): string => pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), f)).href;

/** True when registry.ts already carries the query ops. */
export const registryHasQueries = (): boolean => Object.prototype.hasOwnProperty.call(MAINT_OPS, 'log.search');

/** Start a worker on `t.db` (data folder `t.dir`) whose op table includes QUERY_OPS. */
export async function startQueryWorker(t: { dir: string; db: string }, opts: Partial<MaintClientOptions> = {}): Promise<MaintClient> {
  if (registryHasQueries()) return MaintClient.start({ dataDir: t.dir, dbPath: t.db, ...opts });
  const entry = path.join(t.dir, 'maint-queries-worker.mjs');
  fs.writeFileSync(entry, [
    "import { workerData, parentPort } from 'node:worker_threads';",
    'const init = workerData.maint;',
    'delete workerData.maint; // worker.ts must not start its own copy on import',
    `const { runMaintWorker } = await import(${JSON.stringify(here('worker.ts'))});`,
    `const { MAINT_OPS } = await import(${JSON.stringify(here('registry.ts'))});`,
    `const { QUERY_OPS } = await import(${JSON.stringify(here('queries.ts'))});`,
    'runMaintWorker({ postMessage: (m) => parentPort.postMessage(m), on: (e, cb) => parentPort.on(e, cb), off: (e, cb) => parentPort.off(e, cb) },',
    '  init, { ...MAINT_OPS, ...QUERY_OPS });',
    '',
  ].join('\n'), 'utf8');
  return MaintClient.start({ dataDir: t.dir, dbPath: t.db, workerFile: pathToFileURL(entry), execArgv: defaultWorkerFile().execArgv ?? [], ...opts });
}

// ------------------------------------------------------------------------------------------
// A big synthetic chat log (T-ADM-7, T-PERF-2: 1M rows)
// ------------------------------------------------------------------------------------------

export interface BigLog {
  rows: number;
  /** epoch ms of the first / last line */
  start: number;
  end: number;
  /** account ids ('acc-<n>') and their usernames ('Pilot<n>'); guests fly as 'Guest<n>' */
  accounts: string[];
  /** one student with a seventh of the log ('HeavyPilot'), and the review-only tag on ~30% of the lines */
  heavyAccount: string;
  heavyName: string;
  commonTag: string;
  /** a lobby holding ~30% of the log */
  bigRoomUid: string;
  /** a token that appears in about 1 line in 100k */
  rareToken: string;
  /** a few room uids that exist */
  roomUids: string[];
  /** ids of some tagged lines */
  taggedIds: number[];
  /**
   * The audit trail's worst cases: the heavy student is the target of a fifth of the audit rows (every conduct view
   * and reveal adds one, §5.11), and one guest (callsign + address) of another fifth.
   */
  heavyAuditGuest: { name: string; address: string };
}

const HEAVY_AUDIT_GUEST = { name: 'GuestHeavy', address: '10.0.88.8' } as const;

export const BIG_LOG_WORDS = ('the a to and pilot go left right nice shot gg flag base zone help me here now wait come on team red blue shield '
  + 'boost laser turret mine enemy behind above below fast slow lol ok yes no maybe good great bad cap point hold defend attack push back '
  + 'retreat heal repair ammo energy wow sorry thanks please where who what when why how').split(' ');

/**
 * Fill a fresh v4 database (made by AuthStore) with `rows` chat lines over `days` days ending at `end`, like a busy
 * school year with its worst cases: 300 pilots (250 accounts, 50 guests) plus one student with a seventh of the log,
 * rooms of 2,000 lines and one lobby with ~30% of it, 20% team chat, 2% masked (PROFANITY) and ~30% hitting an
 * overbroad review-only custom term (GANG: chat_tags + conduct_daily 'review:GANG'), plus `actions` audit rows (a fifth
 * about the heavy student, a fifth about one guest: BigLog.heavyAuditGuest), bans and reports. Built the fast way (the FTS triggers dropped during the bulk insert, then recreated), ending as the v4
 * migration leaves a database: the index 'rebuild' only. The start-up tidy ('fts.optimize', MaintService.startupTidy)
 * is the caller's step (`optimize: true` runs the same statement here).
 * `organicTxRows`: grow the index as a running server does instead: the FTS triggers stay, the lines go in
 * transactions of that many rows with FTS5's default automerge, and nothing is rebuilt or optimized (the multi-level
 * index of a log that never had a purge: the first 90 days, 'forever' retention). ~17 s for 250k rows at 100.
 */
export function buildBigLog(dbPath: string, opts: {
  rows: number; end: number; days?: number; actions?: number; seed?: number; optimize?: boolean; organicTxRows?: number;
}): BigLog {
  const days = opts.days ?? 90;
  const start = opts.end - days * 86_400_000;
  const db = new DatabaseSync(dbPath);
  // mulberry32 (a float LCG loses precision past 2^53 and repeats word pairs)
  let seed = (opts.seed ?? 12345) >>> 0;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let x = seed;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; PRAGMA cache_size = -200000; PRAGMA foreign_keys = ON');
    const triggers = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'chat_log'").all() as { name: string; sql: string }[];
    db.exec('BEGIN');
    const acc = db.prepare(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at, email_key)
                            VALUES (?, ?, ?, ?, ?, 'scrypt$test', ?, ?)`);
    const accounts: string[] = [];
    for (let i = 0; i < 250; i++) {
      const email = `pilot${i}@caldwellschools.org`;
      acc.run(`acc-${i}`, `Pilot${i}`, `pilot${i}`, email, email, start, email);
      accounts.push(`acc-${i}`);
    }
    acc.run('acc-heavy', 'HeavyPilot', 'heavypilot', 'heavypilot@caldwellschools.org', 'heavypilot@caldwellschools.org', start, 'heavypilot@caldwellschools.org');
    const organic = opts.organicTxRows !== undefined ? Math.max(1, Math.floor(opts.organicTxRows)) : 0;
    if (!organic) for (const t of triggers) db.exec(`DROP TRIGGER ${t.name}`);
    const ins = db.prepare(`INSERT INTO chat_log (id, ts, room_id, room_name, channel, team, player_id, name, name_key, account_id, address,
                            original, shown, action, hits, room_uid, display) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const tag = db.prepare('INSERT INTO chat_tags (chat_id, tag, ts, account_id) VALUES (?, ?, ?, ?)');
    const cond = db.prepare(`INSERT INTO conduct_daily (account_key, day, tag, n) VALUES (?, ?, ?, 1)
                             ON CONFLICT (account_key, day, tag) DO UPDATE SET n = n + 1`);
    const step = (opts.end - start) / opts.rows;
    const rareToken = 'quasarvoxel';
    const roomUids = new Set<string>();
    const taggedIds: number[] = [];
    for (let i = 1; i <= opts.rows; i++) {
      const n = 2 + Math.floor(rnd() * 8);
      const w: string[] = [];
      for (let j = 0; j < n; j++) w.push(BIG_LOG_WORDS[Math.floor(rnd() * BIG_LOG_WORDS.length)]!);
      if (i % 100_000 === 50_000) w.push(rareToken);
      const text = w.join(' ');
      const s = Math.floor(rnd() * 300);
      const heavy = i % 7 === 0;
      const account = heavy ? 'acc-heavy' : s < 250 ? `acc-${s}` : null;
      const name = heavy ? 'HeavyPilot' : account ? `Pilot${s}` : `Guest${s}`;
      const room = Math.floor(i / 2000);
      const roomUid = i % 10 < 3 ? 'bootBig:zone' : room % 7 === 3 ? `boot${Math.floor(room / 40)}:zone` : `boot${Math.floor(room / 40)}:r${room % 24}`;
      roomUids.add(roomUid);
      const ts = Math.floor(start + i * step);
      const tagged = rnd() < 0.02;
      const review = !tagged && rnd() < 0.3;
      const team = !roomUid.endsWith(':zone') && rnd() < 0.2;
      const key = account ?? `g:${name.toLowerCase()}`;
      ins.run(i, ts, roomUid.endsWith(':zone') ? null : `r${room % 24}`, roomUid.endsWith(':zone') ? 'Zone' : `Room ${room}`, team ? 'team' : 'all',
        team ? 1 : -1, s, name, name.toLowerCase(), account, `10.0.${s % 256}.${s % 7}`, text, tagged ? 'GG, pilots!' : text,
        tagged ? 'mask' : review ? 'flag' : 'pass', tagged ? '["profanity:x"]' : review ? '["flag:gang:x"]' : '[]', roomUid, tagged ? 'substituted' : 'as-typed');
      if (tagged) {
        tag.run(i, 'PROFANITY', ts, account);
        cond.run(key, Math.floor(ts / 86_400_000), 'PROFANITY');
        if (taggedIds.length < 1000) taggedIds.push(i);
      } else if (review) {
        tag.run(i, 'GANG', ts, account);
        cond.run(key, Math.floor(ts / 86_400_000), 'review:GANG');
      }
      if (organic && i % organic === 0) { db.exec('COMMIT'); db.exec('BEGIN'); }
    }
    const act = db.prepare(`INSERT INTO mod_actions (ts, actor_account_id, actor_name, action, target_account_id, target_name, target_address, reason)
                            VALUES (?, 'host', 'host', ?, ?, ?, ?, ?)`);
    const nAct = opts.actions ?? 100_000;
    for (let i = 0; i < nAct; i++) {
      const s = Math.floor(rnd() * 300);
      const ts = Math.floor(start + (i * (opts.end - start)) / nAct);
      const kind = i % 3 ? 'note' : 'mute';
      if (i % 5 === 0) act.run(ts, kind, 'acc-heavy', 'HeavyPilot', '10.0.77.7', 'api log');
      else if (i % 5 === 1) act.run(ts, kind, null, HEAVY_AUDIT_GUEST.name, HEAVY_AUDIT_GUEST.address, 'api log');
      else act.run(ts, kind, s < 250 ? `acc-${s}` : null, s < 250 ? `Pilot${s}` : `Guest${s}`, `10.0.${s % 256}.${s % 7}`, 'api log');
    }
    const ban = db.prepare(`INSERT INTO bans (kind, scope, account_id, username, address_prefix, created_at, expires_at, reason, by)
                            VALUES (?, ?, ?, ?, ?, ?, ?, 'test', 'host')`);
    for (let i = 0; i < 60; i++) ban.run(i % 2 ? 'mute' : 'ban', i % 3 ? 'account' : 'address', `acc-${i}`, `Pilot${i}`, `10.0.${i}.1`, opts.end - 3_600_000, i % 4 ? opts.end + 3_600_000 : null);
    const rep = db.prepare(`INSERT INTO reports (ts, reporter_name, target_name, target_account_id, reason, room, recent_chat_json, recent_ids)
                            VALUES (?, 'Pilot1', ?, ?, 'test', 'Room', '[]', '[]')`);
    for (let i = 0; i < 200; i++) rep.run(opts.end - i * 60_000, `Pilot${i % 250}`, `acc-${i % 250}`);
    db.exec('COMMIT');
    if (!organic) {
      // as MIGRATIONS[3] leaves it: 'rebuild' only
      db.exec("INSERT INTO chat_fts(chat_fts) VALUES('rebuild')");
      if (opts.optimize) db.exec("INSERT INTO chat_fts(chat_fts) VALUES('optimize')");
      for (const t of triggers) db.exec(t.sql);
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return {
      rows: opts.rows, start, end: opts.end, accounts, heavyAccount: 'acc-heavy', heavyName: 'HeavyPilot', commonTag: 'GANG', bigRoomUid: 'bootBig:zone',
      rareToken, roomUids: [...roomUids].filter((u) => u !== 'bootBig:zone'), taggedIds, heavyAuditGuest: { ...HEAVY_AUDIT_GUEST },
    };
  } finally {
    db.close();
  }
}
