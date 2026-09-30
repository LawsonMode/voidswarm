// OWNER: SERVER MODERATION (LAN task B5). Test fixtures for the maintenance tests (imported by *.test.ts only):
// a scratch data folder with a v4 database made by this version's migrations, and row helpers. Generated names and
// random keys only; school examples use caldwellschools.org.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { AuthStore } from '../auth/store';
import { openProtectedDb } from '../db/guard';
import { nameKey } from '../../shared/room/util';

export interface TmpData { dir: string; db: string; cleanup(): void }

/** A fresh data folder (with a v4 voidswarm.db unless `db: false`). */
export function tmpData(prefix = 'vs-maint-', opts: { db?: boolean } = {}): TmpData {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const db = path.join(dir, 'voidswarm.db');
  if (opts.db !== false) new AuthStore(db).close();
  return { dir, db, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold a file a moment */ } } };
}

export const key32 = (): Buffer => randomBytes(32);

export function open(dbPath: string): DatabaseSync {
  return openProtectedDb(dbPath);
}

export function addAccount(db: DatabaseSync, a: { id: string; username: string; email?: string; createdAt?: number }): void {
  const email = a.email ?? `${a.username.toLowerCase()}@caldwellschools.org`;
  db.prepare(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at, email_key)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(a.id, a.username, a.username.toLowerCase(), email, email.toLowerCase(), `scrypt$test$${a.id}`, a.createdAt ?? 1, email.toLowerCase());
}

let seqTs = 1_700_000_000_000;

export function addChat(db: DatabaseSync, c: {
  ts?: number; accountId?: string | null; name: string; original?: string; shown?: string; address?: string | null; roomUid?: string; action?: string;
}): number {
  const ts = c.ts ?? (seqTs += 1000);
  const r = db.prepare(`INSERT INTO chat_log (ts, room_id, room_name, channel, team, player_id, name, name_key, account_id, address, original, shown, action, hits, room_uid, display)
                        VALUES (?, 'r1', 'Room 1', 'all', -1, 1, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 'as-typed')`)
    .run(ts, c.name, nameKey(c.name), c.accountId ?? null, c.address ?? '10.0.0.5', c.original ?? `hello from ${c.name}`, c.shown ?? c.original ?? `hello from ${c.name}`,
      c.action ?? 'pass', c.roomUid ?? 'room-uid-1');
  return Number(r.lastInsertRowid);
}

export function addTag(db: DatabaseSync, chatId: number, tag: string, accountId: string | null, ts = 1): void {
  db.prepare('INSERT INTO chat_tags (chat_id, tag, ts, account_id) VALUES (?, ?, ?, ?)').run(chatId, tag, ts, accountId);
}

export function addConduct(db: DatabaseSync, accountKey: string, day: number, tag = 'PROFANITY', n = 1): void {
  db.prepare('INSERT INTO conduct_daily (account_key, day, tag, n) VALUES (?, ?, ?, ?)').run(accountKey, day, tag, n);
}

export function addReport(db: DatabaseSync, r: {
  reporterName: string; reporterId?: string | null; targetName: string; targetId?: string | null; reason?: string; copies?: Record<string, unknown>[]; ts?: number;
}): number {
  const copies = r.copies ?? [];
  const ids = copies.map((c) => c.id).filter((x) => typeof x === 'number');
  const res = db.prepare(`INSERT INTO reports (ts, reporter_name, reporter_account_id, reporter_address, target_name, target_account_id, target_address, reason, room, recent_chat_json, recent_ids)
                          VALUES (?, ?, ?, '10.0.0.7', ?, ?, '10.0.0.8', ?, 'Room 1', ?, ?)`)
    .run(r.ts ?? (seqTs += 1000), r.reporterName, r.reporterId ?? null, r.targetName, r.targetId ?? null, r.reason ?? 'spam', JSON.stringify(copies), JSON.stringify(ids));
  return Number(res.lastInsertRowid);
}

export function addAction(db: DatabaseSync, a: { actorId?: string; actorName?: string; action?: string; targetId?: string | null; targetName?: string | null; reason?: string }): number {
  const r = db.prepare(`INSERT INTO mod_actions (ts, actor_account_id, actor_name, action, target_account_id, target_name, target_address, reason)
                        VALUES (?, ?, ?, ?, ?, ?, '10.0.0.9', ?)`)
    .run(seqTs += 1000, a.actorId ?? 'host', a.actorName ?? 'host', a.action ?? 'mute', a.targetId ?? null, a.targetName ?? null, a.reason ?? '');
  return Number(r.lastInsertRowid);
}

export const count = (db: DatabaseSync, sql: string, ...args: (string | number | null)[]): number =>
  Number((db.prepare(sql).get(...args) as { n: number }).n);

/** A statfs stand-in reporting `freeBytes` free. */
export const statfsFree = (freeBytes: number) => async (): Promise<{ bavail: number; bsize: number; blocks: number }> =>
  ({ bavail: Math.floor(freeBytes / 4096), bsize: 4096, blocks: Math.floor((freeBytes * 4) / 4096) });

export const GB = 1024 ** 3;
export const MB = 1024 ** 2;
