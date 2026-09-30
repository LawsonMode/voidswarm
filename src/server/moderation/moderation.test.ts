// Server moderation: SQLite store (migration, batched chat log, retention), the ModerationService (strikes →
// auto-mute, bans + live enforcement, sign-in guards, reports, moderator commands) and the CLI against a running
// service. A fake ZoneControl stands in for the Zone; the clock is injected.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatLogEntry, ModUser, OnlinePilot } from '../../shared/room/moderation';
import { AuthStore, MIGRATIONS, SCHEMA_VERSION } from '../auth/store';
import { csvCell, runCli } from './cliCore';
import { runAdminCommand } from './commands';
import { parseDuration } from './durations';
import { ModerationService, SYSTEM_ACTOR, type Actor, type ZoneControl } from './service';
import { ModStore } from './store';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);

const dirs: string[] = [];
const services: ModerationService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows: still open */ } }
});

/** A migrated DB with some accounts (inserted directly: no scrypt needed here). */
function setupDb(accounts: string[] = ['Teach', 'Student', 'Other']): string {
  const dir = mkdtempSync(join(tmpdir(), 'voidswarm-mod-'));
  dirs.push(dir);
  const dbPath = join(dir, 'mod.db');
  new AuthStore(dbPath).close();
  const db = new DatabaseSync(dbPath);
  for (const u of accounts) {
    db.prepare(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at, last_login)
                VALUES (?, ?, ?, ?, ?, 'x', ?, NULL)`).run(`id-${u.toLowerCase()}`, u, u.toLowerCase(), `${u}@x.test`, `${u.toLowerCase()}@x.test`, T0 - DAY);
  }
  db.close();
  return dbPath;
}

class FakeZone implements ZoneControl {
  pilots: OnlinePilot[] = [];
  told: [number, string][] = [];
  kicked: [number, string][] = [];
  add(p: Partial<OnlinePilot> & { playerId: number; name: string }): OnlinePilot {
    const full: OnlinePilot = { accountId: null, username: null, address: '10.1.1.1', roomId: null, roomName: null, ...p };
    this.pilots.push(full);
    return full;
  }
  onlinePilots(): OnlinePilot[] { return this.pilots.slice(); }
  kickPilots(select: (p: OnlinePilot) => boolean, reason: string): number {
    let n = 0;
    this.pilots = this.pilots.filter((p) => {
      if (!select(p)) return true;
      this.kicked.push([p.playerId, reason]);
      n++;
      return false;
    });
    return n;
  }
  tellPilot(playerId: number, text: string): boolean {
    if (!this.pilots.some((p) => p.playerId === playerId)) return false;
    this.told.push([playerId, text]);
    return true;
  }
  toldTo(pid: number): string[] { return this.told.filter(([p]) => p === pid).map(([, t]) => t); }
}

interface Rig { svc: ModerationService; zone: FakeZone; dbPath: string; clock: { t: number }; teach: OnlinePilot; student: OnlinePilot }

function rig(opts: { timers?: boolean; pollMs?: number } = {}): Rig {
  const dbPath = setupDb();
  const clock = { t: T0 };
  const svc = new ModerationService({ dbPath, log: () => {}, now: () => clock.t, timers: opts.timers ?? false, pollMs: opts.pollMs, env: {} });
  services.push(svc);
  svc.store.addAdmin('id-teach', 'test', clock.t);
  svc.reload();
  const zone = new FakeZone();
  const teach = zone.add({ playerId: 1, name: 'Teach', accountId: 'id-teach', username: 'Teach', address: '10.9.9.9' });
  const student = zone.add({ playerId: 2, name: 'Student', accountId: 'id-student', username: 'Student', address: '10.9.9.9' });
  svc.attachZone(zone);
  return { svc, zone, dbPath, clock, teach, student };
}

const TEACH: Actor = { accountId: 'id-teach', name: 'Teach' };

function entry(p: ModUser, text: string, t: number, action: ChatLogEntry['action'] = 'pass'): ChatLogEntry {
  return {
    time: t, roomId: 'r1', roomName: 'Main Arena', channel: 'all', team: 0, playerId: p.playerId, name: p.name,
    accountId: p.accountId, address: p.address, original: text, shown: action === 'pass' ? text : '', action, hits: [],
  };
}

const count = (dbPath: string, table: string): number => {
  const db = new DatabaseSync(dbPath);
  try { return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n); } finally { db.close(); }
};

async function drain(svc: ModerationService): Promise<void> {
  for (let i = 0; i < 200 && svc.store.pending; i++) await new Promise((r) => setImmediate(r));
}

describe('schema (MIGRATIONS[2])', () => {
  it('bumps user_version once and creates the moderation tables + indexes', () => {
    const dbPath = setupDb([]);
    expect(SCHEMA_VERSION).toBe(4); // v4 (§6.6) is additive: the v3 moderation tables are unchanged
    const db = new DatabaseSync(dbPath);
    try {
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
      for (const t of ['chat_log', 'mod_actions', 'bans', 'reports', 'admins', 'mod_meta']) expect(tables).toContain(t);
      const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);
      for (const i of ['chat_log_ts', 'chat_log_account', 'chat_log_address', 'chat_log_name', 'mod_actions_ts', 'bans_account', 'bans_address', 'reports_status']) {
        expect(idx).toContain(i);
      }
      expect(db.prepare("SELECT v FROM mod_meta WHERE k = 'rev'").get()).toEqual({ v: 0 });
    } finally { db.close(); }
  });

  it('the moderation store refuses a DB that has not been migrated (v2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voidswarm-mod-'));
    dirs.push(dir);
    const p = join(dir, 'v2.db');
    const db = new DatabaseSync(p);
    db.exec(MIGRATIONS[0]!); db.exec(MIGRATIONS[1]!); db.exec('PRAGMA user_version = 2');
    db.close();
    expect(() => new ModStore(p)).toThrow(/no moderation tables/);
    expect(() => new ModStore(join(dir, 'missing.db'))).toThrow(/construct the AuthService first/);
  });
});

describe('chat log batching', () => {
  it('logChat only buffers (cheap enough for the tick); flushes go out in batches of 50 off the hot path', async () => {
    const { svc, dbPath, student } = rig();
    const hook = svc.hook();
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) hook.logChat(entry(student, `line ${i}`, T0 + i));
    const perCall = (performance.now() - t0) / 1000;
    expect(perCall).toBeLessThan(0.05); // ≪ 1 ms per line
    expect(count(dbPath, 'chat_log')).toBe(0); // nothing written synchronously
    const b0 = performance.now();
    svc.flushStep(); // one batch
    const batchMs = performance.now() - b0;
    expect(batchMs).toBeLessThan(50); // (typically well under 1 ms)
    expect(count(dbPath, 'chat_log')).toBeGreaterThanOrEqual(50);
    await drain(svc);
    expect(count(dbPath, 'chat_log')).toBe(1000);
    const rows = svc.store.recentChat({ accountId: 'id-student' }, 3);
    expect(rows.map((r) => r.original)).toEqual(['line 997', 'line 998', 'line 999']);
  });

  it('a write lock held by another process never stalls a flush: the rows stay buffered', () => {
    const { svc, dbPath, student } = rig();
    svc.hook().logChat(entry(student, 'hello', T0));
    const other = new DatabaseSync(dbPath);
    other.exec('BEGIN IMMEDIATE');
    try {
      const t = performance.now();
      svc.flushStep();
      expect(performance.now() - t).toBeLessThan(50);
      expect(svc.store.pending).toBe(1);
    } finally {
      other.exec('COMMIT');
      other.close();
    }
    svc.flushStep();
    expect(svc.store.pending).toBe(0);
    expect(count(dbPath, 'chat_log')).toBe(1);
  });

  it('the buffer is bounded (oldest dropped and counted)', () => {
    const dbPath = setupDb([]);
    const store = new ModStore(dbPath, { maxBuffered: 100, log: () => {} });
    const u: ModUser = { playerId: 1, name: 'A', accountId: null, username: null, address: null };
    for (let i = 0; i < 150; i++) store.logChat(entry(u, `m${i}`, T0));
    expect(store.pending).toBe(100);
    expect(store.dropped).toBe(50);
    store.flushAll();
    expect(store.searchLog({ limit: 1 }).lines[0]!.original).toBe('m149');
    store.close();
  });
});

describe('strikes → automatic mute', () => {
  it('3 blocked lines in 10 minutes mute an account for 10 minutes (logged as system; moderators told)', () => {
    const { svc, zone, student, clock, teach } = rig();
    const hook = svc.hook();
    expect(hook.onStrike(student, 'language')).toBeNull();
    expect(hook.strikeStatus!(student)).toEqual({ count: 1, limit: 3 });
    clock.t += MIN;
    // v0.6 (§5.8, A2): the escalating "one more …" warning is the Zone's (from strikeStatus); onStrike only says "muted".
    expect(hook.onStrike(student, 'language')).toBeNull();
    expect(hook.strikeStatus!(student)).toEqual({ count: 2, limit: 3 });
    clock.t += MIN;
    expect(hook.onStrike(student, 'language')).toBe('You are muted for 10 minutes (repeated blocked language).');
    const mute = hook.isMuted(student);
    expect(mute).toEqual({ until: clock.t + 10 * MIN, reason: 'Automatic: repeated blocked language' });
    const bans = svc.store.listBans({ kind: 'mute' }, clock.t);
    expect(bans).toHaveLength(1);
    expect(bans[0]).toMatchObject({ scope: 'account', accountId: 'id-student', by: 'system' });
    const acts = svc.store.listActions({}).actions;
    expect(acts[0]).toMatchObject({ actor: 'system', actorAccountId: null, action: 'mute', targetAccountId: 'id-student', durationSec: 600 });
    expect(zone.toldTo(teach.playerId).some((t) => t.includes('Auto-muted Student'))).toBe(true);
    clock.t += 10 * MIN + 1;
    expect(hook.isMuted(student)).toBeNull();
  });

  it('strikes spread over more than the window do not mute', () => {
    const { svc, student, clock } = rig();
    const hook = svc.hook();
    hook.onStrike(student, 'language');
    clock.t += 6 * MIN;
    hook.onStrike(student, 'language');
    clock.t += 6 * MIN;
    hook.onStrike(student, 'language');
    expect(hook.isMuted(student)).toBeNull();
    expect(svc.strikeCount(student)).toBe(2);
  });

  it('a guest auto-mute follows that callsign on that network (and the connection through a rename), not the whole network', () => {
    const { svc, zone, clock } = rig();
    const g = zone.add({ playerId: 7, name: 'Guesty', address: '10.5.5.5' });
    const hook = svc.hook();
    for (let i = 0; i < 3; i++) { hook.onStrike(g, 'language'); clock.t += 1000; }
    expect(hook.isMuted(g)).not.toBeNull();
    expect(hook.isMuted({ ...g, name: 'Renamed' })).not.toBeNull(); // same connection
    expect(hook.isMuted({ ...g, playerId: 8 })).not.toBeNull(); // same callsign, new connection
    expect(hook.isMuted({ ...g, playerId: 9, name: 'Classmate' })).toBeNull(); // another guest on that network
    expect(hook.isMuted({ ...g, playerId: 10, accountId: 'id-other', username: 'Other' })).toBeNull();
    expect(svc.store.listBans({ kind: 'mute' }, clock.t)[0]).toMatchObject({ scope: 'guest', username: 'Guesty', address: '10.5.5.5' });
  });

  it('an auto-mute the DB cannot save (CLI holds the lock) is enforced from memory at once, saved later, and never waits', () => {
    const { svc, student, clock, dbPath } = rig();
    const hook = svc.hook();
    hook.onStrike(student, 'language');
    hook.onStrike(student, 'language');
    const other = new DatabaseSync(dbPath);
    other.exec('BEGIN IMMEDIATE');
    let notice: string | null | void;
    try {
      const t = performance.now();
      notice = hook.onStrike(student, 'language');
      expect(performance.now() - t).toBeLessThan(100); // no busy_timeout wait on the game thread
      expect(notice).toBe('You are muted for 10 minutes (repeated blocked language).');
      expect(hook.isMuted(student)).toEqual({ until: clock.t + 10 * MIN, reason: 'Automatic: repeated blocked language' });
      expect(svc.strikeCount(student)).toBe(0);
      expect(svc.store.listBans({ kind: 'mute' }, clock.t)).toHaveLength(0);
      clock.t += 6000;
      svc.poll(); // still locked: stays in memory
      expect(hook.isMuted(student)).not.toBeNull();
    } finally {
      other.exec('COMMIT');
      other.close();
    }
    clock.t += 6000;
    svc.poll();
    const saved = svc.store.listBans({ kind: 'mute' }, clock.t);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ scope: 'account', accountId: 'id-student', by: 'system' });
    expect(saved[0]!.expiresAt).toBe(T0 + 10 * MIN);
    expect(hook.isMuted(student)).not.toBeNull();
    clock.t = T0 + 10 * MIN + 1;
    expect(hook.isMuted(student)).toBeNull();
  });

  it('self-harm alerts are for the host alone and nameless (T-WB-1); threats raise a host alert; neither is a strike', () => {
    const { svc, zone, student, teach, clock } = rig();
    const hook = svc.hook();
    hook.alert!(student, 'selfharm');
    hook.alert!(student, 'selfharm');
    // v0.6: nothing reaches a moderator in game, and the host's alert carries no name.
    expect(zone.toldTo(teach.playerId).filter((t) => t.includes('self-harm') || t.includes('Student'))).toHaveLength(0);
    const wellbeing = svc.alertsList().filter((a) => a.kind === 'wellbeing');
    expect(wellbeing.length).toBeGreaterThan(0);
    for (const a of wellbeing) expect(a).not.toHaveProperty('name');
    hook.alert!(student, 'threat');
    expect(svc.alertsList().some((a) => a.kind === 'threat')).toBe(true);
    clock.t += MIN + 1;
    hook.alert!(student, 'selfharm');
    expect(zone.toldTo(teach.playerId).filter((t) => t.includes('self-harm'))).toHaveLength(0);
    expect(svc.strikeCount(student)).toBe(0);
  });

  it('usernames are checked at registration with the CHAT_FILTER strictness (default strict)', () => {
    const { svc } = rig();
    expect(svc.config.chatFilter).toBe('strict');
    expect(svc.registerRefusal('Ace_Pilot', '10.0.0.1')).toBeNull();
    const dbPath = setupDb([]);
    const relaxed = new ModerationService({ dbPath, log: () => {}, timers: false, env: { CHAT_FILTER: 'standard' } });
    services.push(relaxed);
    expect(relaxed.config.chatFilter).toBe('standard');
  });
});

describe('bans and enforcement', () => {
  it('an account ban kicks the pilot at once and refuses hello / login; it expires', () => {
    const { svc, zone, student, clock } = rig();
    const t = svc.resolveTarget('student')!;
    expect(t).toMatchObject({ accountId: 'id-student', playerId: 2 });
    const res = svc.createBan(TEACH, { kind: 'ban', target: t, durationSec: 3600, reason: 'cheating' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kicked).toBe(1);
    expect(zone.kicked[0]![1]).toMatch(/^You are banned until .+: cheating$/);
    expect(svc.banFor({ accountId: 'id-student', address: '1.2.3.4' })?.id).toBe(res.ban.id);
    expect(svc.loginRefused({ accountId: 'id-student', username: 'Student' }, '1.2.3.4')).toBe(true);
    expect(svc.loginRefused({ accountId: 'id-other', username: 'Other' }, '10.9.9.9')).toBe(false); // account ban only
    expect(svc.registerRefusal('Newbie', '10.9.9.9')).toBeNull();
    expect(svc.store.listActions({}).actions[0]).toMatchObject({ actor: 'Teach', action: 'ban', targetAccountId: 'id-student', reason: 'cheating' });
    clock.t += 3600_000 + 1;
    expect(svc.banFor({ accountId: 'id-student', address: null })).toBeNull();
    // a moderator can't ban themselves
    const self = svc.createBan(TEACH, { kind: 'ban', target: svc.resolveTarget('Teach'), durationSec: 60, reason: 'x' });
    expect(self.ok).toBe(false);
  });

  it('a guest has no account to ban; an address ban needs confirmation when others share it, spares moderators, blocks register', () => {
    const { svc, zone, teach } = rig();
    const g = zone.add({ playerId: 5, name: 'Troll', address: '10.9.9.9' });
    const t = svc.resolveTarget('troll')!;
    const noAcct = svc.createBan(TEACH, { kind: 'ban', target: t, durationSec: 3600, reason: 'x' });
    expect(noAcct).toMatchObject({ ok: false, status: 400 });
    const wide = svc.createBan(TEACH, { kind: 'ban', target: t, scope: 'address', durationSec: 3600, reason: 'trolling' });
    expect(wide).toMatchObject({ ok: false, status: 409, needsConfirm: true, sharing: 1 }); // Student (Teach is exempt)
    const ok = svc.createBan(TEACH, { kind: 'ban', target: t, scope: 'address', durationSec: 3600, reason: 'trolling', confirm: true });
    expect(ok.ok && ok.kicked).toBe(2); // Troll + Student
    expect(zone.pilots.map((p) => p.playerId)).toEqual([teach.playerId]); // the moderator stays
    expect(svc.banFor({ accountId: null, address: '10.9.9.9', name: 'Someone' })).not.toBeNull();
    expect(svc.loginRefused({ accountId: 'id-other', username: 'Other' }, '10.9.9.9')).toBe(true);
    expect(svc.loginRefused({ accountId: 'id-teach', username: 'Teach' }, '10.9.9.9')).toBe(false);
    expect(svc.registerRefusal('Newbie', '10.9.9.9')).toEqual({ status: 403, message: "Accounts can't be created from your network right now." });
    expect(svc.registerRefusal('Newbie', '10.9.9.10')).toBeNull();
    // unban by address
    const rev = svc.revoke(TEACH, { target: { query: '10.9.9.9', name: '10.9.9.9', online: [], accountId: null, username: null, address: '10.9.9.9', playerId: null }, kind: 'ban' });
    expect(rev.ok && rev.revoked).toBe(1);
    expect(svc.registerRefusal('Newbie', '10.9.9.9')).toBeNull();
    void g;
  });

  it('a guest-scope ban blocks guests from that network but not accounts', () => {
    const { svc, zone } = rig();
    zone.add({ playerId: 5, name: 'Troll', address: '10.7.7.7' });
    const res = svc.createBan(TEACH, { kind: 'ban', target: svc.resolveTarget('Troll'), scope: 'guest', durationSec: null, reason: 'no guests', confirm: true });
    expect(res.ok).toBe(true);
    expect(svc.banFor({ accountId: null, address: '10.7.7.7', name: 'AnyGuest' })?.expiresAt).toBeNull();
    expect(svc.banFor({ accountId: 'id-other', address: '10.7.7.7' })).toBeNull();
    expect(svc.banMessage(svc.banFor({ accountId: null, address: '10.7.7.7' })!)).toBe('You are banned: no guests');
  });

  it('mutes tell the online target; unmute lifts it and says so', () => {
    const { svc, zone, student } = rig();
    const t = svc.resolveTarget('Student')!;
    const res = svc.createBan(TEACH, { kind: 'mute', target: t, durationSec: 600, reason: 'spamming' });
    expect(res.ok && res.kicked).toBe(0);
    expect(zone.toldTo(student.playerId).at(-1)).toMatch(/^You are muted until .*: spamming\.$/);
    expect(svc.muteFor(student)).not.toBeNull();
    const rev = svc.revoke(TEACH, { target: t, kind: 'mute' });
    expect(rev.ok && rev.revoked).toBe(1);
    expect(svc.muteFor(student)).toBeNull();
    expect(zone.toldTo(student.playerId).at(-1)).toBe('You can chat again.');
    const acts = svc.store.listActions({}).actions.map((a) => a.action);
    expect(acts.slice(0, 2)).toEqual(['unmute', 'mute']);
  });
});

describe('reports', () => {
  it('/report files the target\'s last 20 lines, tells moderators, and is limited to 3 per 10 minutes', async () => {
    const { svc, zone, teach, student, clock } = rig();
    const reporter = zone.add({ playerId: 3, name: 'Other', accountId: 'id-other', username: 'Other', address: '10.2.2.2' });
    const hook = svc.hook();
    for (let i = 0; i < 25; i++) hook.logChat(entry(student, `msg ${i}`, clock.t + i));
    const reply = await hook.report(reporter, 'student', 'bullying me', { roomId: 'r1', roomName: 'Main Arena' });
    expect(reply).toEqual(['Report sent — thank you.']);
    const { reports } = svc.store.listReports({ status: 'open' });
    expect(reports).toHaveLength(1);
    const r = reports[0]!;
    expect(r).toMatchObject({ status: 'open', reason: 'bullying me', room: 'Main Arena' });
    expect(r.reporter).toMatchObject({ name: 'Other', accountId: 'id-other' });
    expect(r.target).toMatchObject({ name: 'Student', accountId: 'id-student', playerId: 2 });
    expect(r.recentChat).toHaveLength(20);
    // §6.4: a report stores only what others saw (no original text, address or hit labels).
    expect(r.recentChat.at(-1)!.shown).toBe('msg 24');
    expect(r.recentChat[0]!.shown).toBe('msg 5');
    for (const line of r.recentChat) expect(line.original ?? '').toBe('');
    expect(zone.toldTo(teach.playerId).some((t) => t.startsWith(`[mod] New report #${r.id}: Other reported Student`))).toBe(true);
    // self / unknown
    expect(await hook.report(reporter, 'Other', 'x', { roomId: null, roomName: 'Zone' })).toEqual(["You can't report yourself."]);
    expect((await hook.report(reporter, 'Nobody', 'x', { roomId: null, roomName: 'Zone' }))[0]).toMatch(/^No pilot called "Nobody"/);
    // rate limit: 3 per 10 minutes per reporter
    await hook.report(reporter, 'Student', 'again', { roomId: null, roomName: 'Zone' });
    await hook.report(reporter, 'Student', 'again', { roomId: null, roomName: 'Zone' });
    expect((await hook.report(reporter, 'Student', 'again', { roomId: null, roomName: 'Zone' }))[0]).toMatch(/several reports recently/);
    expect(svc.store.listReports({ status: 'all' }).reports).toHaveLength(3);
    clock.t += 10 * MIN + 1;
    expect(await hook.report(reporter, 'Student', 'later', { roomId: null, roomName: 'Zone' })).toEqual(['Report sent — thank you.']);
    // review
    const rv = svc.reviewReport(TEACH, r.id, 'reviewed', 'talked to them');
    expect(rv.ok && rv.report).toMatchObject({ status: 'reviewed', reviewedBy: 'Teach', note: 'talked to them' });
  });
});

describe('moderator chat commands', () => {
  const mod: ModUser = { playerId: 1, name: 'Teach', accountId: 'id-teach', username: 'Teach', address: '10.9.9.9' };

  it('/ban, /mute, /unban, /kick, /warn, /log, /whois, /reports, /ipban + /confirm', () => {
    const { svc, zone, student } = rig();
    const run = (line: string): string[] => {
      const [cmd, ...args] = line.slice(1).split(/\s+/);
      return runAdminCommand(svc, mod, cmd!, args) as string[];
    };
    expect(run('/modhelp')[0]).toMatch(/Moderator commands/);
    expect(run('/ban Student')).toEqual(['Usage: /ban <name> <10m|2h|1d|7d|perm> <reason>']);
    expect(run('/ban Student 3x rude')).toEqual(['Duration must look like 10m, 2h, 1d, 7d or perm.']);
    expect(run('/ban Nobody 1d rude')[0]).toMatch(/No pilot or account called "Nobody"/);
    svc.hook().logChat(entry(student, 'first line', T0));
    svc.hook().logChat(entry(student, 'rude line', T0 + 1, 'block'));
    const log = run('/log Student 5');
    expect(log[0]).toBe('Last 2 lines of Student:');
    expect(log[2]).toMatch(/Student: rude line \[block\]$/);
    const who = run('/whois Student');
    expect(who[0]).toMatch(/^Student: account Student .*online/);
    expect(who.join('\n')).toMatch(/Address: 10\.9\.9\.9/);
    expect(who.join('\n')).toMatch(/flagged lines \(24 h\): 1/);
    expect(run('/warn Student please stop')).toEqual(['Warned Student.']);
    expect(zone.toldTo(student.playerId).at(-1)).toBe('Warning from a moderator: please stop');
    expect(run('/mute Student 10m chill')[0]).toMatch(/^Muted Student until .* \(10 minutes, #\d+\)\.$/);
    expect(run('/unmute Student')[0]).toMatch(/^Lifted 1 mute for Student/);
    expect(run('/ban Student perm griefing')[0]).toMatch(/^Banned Student permanently \(#\d+\) — disconnected 1 connection\.$/);
    expect(zone.kicked.at(-1)).toEqual([student.playerId, 'You are banned: griefing']);
    expect(run('/unban Student')[0]).toMatch(/^Lifted 1 ban for Student/);
    // a guest: no account → explanation; /ipban needs /confirm when others share the network
    const g = zone.add({ playerId: 9, name: 'Guesty', address: '10.4.4.4' });
    zone.add({ playerId: 10, name: 'Buddy', address: '10.4.4.4' });
    expect(run('/ban Guesty 1d x')[0]).toBe('Guesty is a guest (no account), so there is no account to ban.');
    const ip = run('/ipban Guesty 1d trolling');
    expect(ip[0]).toMatch(/1 other pilot online shares that network address/);
    expect(ip[1]).toMatch(/\/confirm/);
    expect(zone.pilots.some((p) => p.playerId === g.playerId)).toBe(true);
    expect(run('/confirm')[0]).toMatch(/^Banned the network of Guesty until .* \(1 day, #\d+\) — disconnected 2 connections\.$/);
    expect(run('/confirm')).toEqual(['Nothing to confirm.']);
    expect(run('/kick Guesty')).toEqual(['No pilot or account called "Guesty".']); // a guest who never chatted leaves no trace
    expect(run('/reports')).toEqual(['No open reports.']);
  });
});

describe('retention', () => {
  it('prunes chat older than CHAT_LOG_RETENTION_DAYS and actions / reports / ended bans older than 365 days', async () => {
    const dbPath = setupDb([]);
    const clock = { t: T0 };
    const svc = new ModerationService({ dbPath, log: () => {}, now: () => clock.t, timers: false, env: { CHAT_LOG_RETENTION_DAYS: '30' } });
    services.push(svc);
    expect(svc.config.retentionDays).toBe(30);
    const u: ModUser = { playerId: 1, name: 'A', accountId: null, username: null, address: '10.0.0.1' };
    const s = svc.store;
    s.logChat(entry(u, 'ancient', T0 - 31 * DAY));
    s.logChat(entry(u, 'recent', T0 - 29 * DAY));
    s.flushAll();
    s.addAction({ ts: T0 - 400 * DAY, actorAccountId: 'cli', actorName: 'cli', action: 'kick', reason: 'old' });
    s.addAction({ ts: T0 - 10 * DAY, actorAccountId: 'cli', actorName: 'cli', action: 'kick', reason: 'new' });
    s.addReport({ ts: T0 - 400 * DAY, reporter: { playerId: 1, name: 'a', accountId: null, address: null }, target: { playerId: 2, name: 'b', accountId: null, address: null }, reason: 'old', room: 'Zone', recentChat: [] });
    const ended = s.addBan({ kind: 'mute', scope: 'guest', accountId: null, username: 'x', address: '1.1.1.1', createdAt: T0 - 500 * DAY, expiresAt: T0 - 499 * DAY, reason: 'old', by: 'cli' });
    const perm = s.addBan({ kind: 'ban', scope: 'account', accountId: 'acc', username: 'y', address: null, createdAt: T0 - 500 * DAY, expiresAt: null, reason: 'perm', by: 'cli' });
    const removed = await svc.pruneNow();
    expect(removed).toBe(4);
    expect(s.searchLog({}).lines.map((l) => l.original)).toEqual(['recent']);
    expect(s.listActions({}).actions.map((a) => a.reason)).toEqual(['new']);
    expect(s.listReports({ status: 'all' }).reports).toHaveLength(0);
    expect(s.getBan(ended.id, clock.t)).toBeNull();
    expect(s.getBan(perm.id, clock.t)?.active).toBe(true); // a live ban is never pruned
  });
});

describe('CLI', () => {
  it('promote / ban from the CLI are picked up by a running server (rev poll) and the banned pilot is kicked', async () => {
    const { svc, zone, dbPath, student } = rig();
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: { DB_PATH: dbPath } };
    expect(await runCli(['promote', 'other'], io)).toBe(0);
    expect(out.join('')).toMatch(/Other is now a moderator/);
    expect(svc.isAdminAccount('id-other')).toBe(false);
    svc.poll();
    expect(svc.isAdminAccount('id-other')).toBe(true);
    expect(await runCli(['ban', 'Student', '2h', 'cheating', 'in', 'class'], io)).toBe(0);
    expect(zone.pilots.some((p) => p.playerId === student.playerId)).toBe(true);
    svc.poll();
    expect(zone.kicked).toEqual([[student.playerId, expect.stringMatching(/^You are banned until .*: cheating in class$/)]]);
    expect(await runCli(['bans'], io)).toBe(0);
    expect(out.join('')).toMatch(/#\d+ {2}ban +account Student/);
    expect(await runCli(['unban', 'Student'], io)).toBe(0);
    svc.poll();
    expect(svc.banFor({ accountId: 'id-student', address: null })).toBeNull();
    expect(await runCli(['demote', 'Other'], io)).toBe(0);
    svc.poll();
    expect(svc.isAdminAccount('id-other')).toBe(false);
    expect(await runCli(['nope'], io)).toBe(1);
    expect(await runCli(['ban', 'Student', 'soon', 'x'], io)).toBe(1);
    const acts = svc.store.listActions({}).actions;
    expect(acts.some((a) => a.actor === 'cli' && a.action === 'promote')).toBe(true);
    expect(acts.some((a) => a.actor === 'cli' && a.action === 'ban')).toBe(true);
  });

  it('with timers on, a CLI ban reaches the running service within the poll interval', async () => {
    const { zone, dbPath, student } = rig({ timers: true, pollMs: 50 });
    const io = { out: () => {}, err: () => {}, env: { DB_PATH: dbPath } };
    expect(await runCli(['ban', 'Student', '1d', 'x'], io)).toBe(0);
    for (let i = 0; i < 100 && !zone.kicked.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(zone.kicked.map(([p]) => p)).toEqual([student.playerId]);
  });

  it('log / export-log (CSV, spreadsheet-safe) / reports / review', async () => {
    const { svc, dbPath, student } = rig();
    svc.hook().logChat(entry(student, '=HYPERLINK("http://x")', Date.now() - 1000));
    svc.hook().logChat(entry(student, 'plain, with "quotes"', Date.now() - 500, 'block'));
    svc.flushAllQuiet();
    const out: string[] = [];
    const io = { out: (s: string) => out.push(s), err: () => {}, env: { DB_PATH: dbPath } };
    expect(await runCli(['log', '--player', 'student', '--since', '1h'], io)).toBe(0);
    expect(out.join('')).toMatch(/Student @10\.9\.9\.9: plain, with "quotes" {2}\[block\]/);
    out.length = 0;
    expect(await runCli(['export-log', '--since', '7d'], io)).toBe(0);
    const csv = out.join('').trim().split('\n');
    expect(csv[0]).toBe('id,time,room,channel,team,player_id,name,account_id,address,action,original,shown,hits');
    expect(csv[1]).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv[2]).toContain('"plain, with ""quotes"""');
    const file = join(dbPath, '..', 'out.csv');
    expect(await runCli(['export-log', '--flagged', '--out', file], io)).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('﻿id,time')).toBe(true);
    expect(text.trim().split('\r\n')).toHaveLength(2);
    expect(csvCell('-1+1')).toBe(`"'-1+1"`);
    expect(csvCell('fine')).toBe('fine');
  });
});

describe("review-only 'flag' lines", () => {
  it("action 'flag' finds lines for review (flag, or any line with a flag: hit); 'flagged' = the lines the filter acted on", async () => {
    const { svc, dbPath, student, teach } = rig();
    const t = Date.now();
    const long = `flag:${'c'.repeat(24)}:${'zorblax'.repeat(9)}`; // category 24 + term 63: kept whole (128-char labels)
    svc.hook().logChat({ ...entry(student, 'plain line', t - 400) });
    svc.hook().logChat({ ...entry(student, 'meet at zorblax', t - 300, 'flag'), shown: 'meet at zorblax', hits: ['flag:crew:zorblax'] });
    svc.hook().logChat({ ...entry(student, 'quenth zorblax', t - 200, 'mask'), shown: 'q*** zorblax', hits: ['custom:crew:quenth', long] });
    svc.hook().logChat({ ...entry(student, 'quenth', t - 100, 'mask'), shown: 'q***', hits: ['custom:crew:quenth'] });
    svc.flushAllQuiet();
    const review = svc.store.searchLog({ action: 'flag' }).lines;
    expect(review.map((l) => l.original)).toEqual(['quenth zorblax', 'meet at zorblax']);
    expect(review[0]!.hits[1]).toBe(long);
    // 'flagged' (and the whois count) = lines the filter acted on: a review-only line was shown and is no misconduct
    expect(svc.store.searchLog({ action: 'flagged' }).lines.map((l) => l.action)).toEqual(['mask', 'mask']);
    expect(svc.whois(svc.resolveTarget('Student')!).flagged24h).toBe(2);
    const exported: string[] = [];
    svc.store.exportLog({ action: 'flag' }, (rows) => { for (const r of rows) exported.push(r.original); });
    expect(exported).toEqual(['meet at zorblax', 'quenth zorblax']);
    const out: string[] = [];
    const io = { out: (x: string) => out.push(x), err: () => {}, env: { DB_PATH: dbPath } };
    expect(await runCli(['export-log', '--review'], io)).toBe(0);
    expect(out.join('').trim().split(/\r?\n/)).toHaveLength(3); // header + 2
    out.length = 0;
    expect(await runCli(['log', '--review'], io)).toBe(0);
    expect(out.join('')).toContain('meet at zorblax  [for review: flag:crew:zorblax]');
    expect(out.join('')).not.toContain('plain line');
    // the in-game /log shows the tag too
    const lines = runAdminCommand(svc, teach, 'log', ['Student']) as string[];
    expect(lines.some((l) => l.endsWith('meet at zorblax [for review]'))).toBe(true);
  });

  it('a refused name that also matched a review-only term is found by the review filter (labels logged one per hit)', () => {
    const { svc, student } = rig();
    const t = Date.now();
    // exactly what the Zone logs for a refused callsign: one label per hit
    svc.hook().logChat({ ...entry(student, 'QuenthZorblax', t - 100, 'block'), channel: 'name', hits: ['custom:crew:quenth', 'flag:watch:zorblax'] });
    svc.hook().logChat({ ...entry(student, 'QuenthOnly', t - 50, 'block'), channel: 'name', hits: ['custom:crew:quenth'] });
    svc.flushAllQuiet();
    expect(svc.store.searchLog({ action: 'flag' }).lines.map((l) => l.original)).toEqual(['QuenthZorblax']);
    expect(svc.store.searchLog({ action: 'flagged' }).lines).toHaveLength(2);
  });
});

describe('network targets, purge-log, CSV numbers', () => {
  it('/mute <address> mutes that network (everyone there, moderators excepted) after /confirm — not one callsign', () => {
    const { svc, zone, teach, clock } = rig();
    const g1 = zone.add({ playerId: 11, name: 'AddrGuest', address: '10.93.0.7' });
    const g2 = zone.add({ playerId: 12, name: 'Classmate', address: '10.93.0.7' });
    const lines = runAdminCommand(svc, teach, 'mute', ['10.93.0.7', '10m', 'cool', 'off']) as string[];
    expect(lines[0]).toMatch(/^2 pilots online use that network address/);
    const done = runAdminCommand(svc, teach, 'confirm', []) as string[];
    expect(done[0]).toMatch(/^Muted network 10\.93\.0\.7 until /);
    const mutes = svc.store.listBans({ kind: 'mute' }, clock.t);
    expect(mutes).toHaveLength(1);
    expect(mutes[0]).toMatchObject({ scope: 'address', address: '10.93.0.7', username: null });
    expect(svc.muteFor(g1)).not.toBeNull();
    expect(svc.muteFor(g2)).not.toBeNull();
    expect(svc.muteFor({ ...g2, playerId: 13, name: 'Latecomer' })).not.toBeNull();
    // /ban <address> is a network ban too (no "is a guest" detour)
    const ban = runAdminCommand(svc, teach, 'ban', ['10.93.0.7', '1h', 'raid']) as string[];
    expect(ban[0]).toMatch(/^2 pilots online use that network address/);
  });

  it('a network ban from the dashboard (address + scope, no target) counts everyone on it, not "others"', () => {
    const { svc, zone } = rig();
    zone.add({ playerId: 21, name: 'ClassGuest', address: '10.60.0.2' });
    zone.add({ playerId: 22, name: 'Other1', address: '10.60.0.2' });
    const res = svc.createBan(TEACH, { kind: 'ban', address: '10.60.0.2', scope: 'guest', durationSec: 600, reason: 'x' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.sharing).toBe(2);
    expect(res.error).toMatch(/^2 pilots online use that network address .* would hit all of them\.$/);
  });

  it('purge-log deletes old chat lines now (by age, by player, or all with --yes), and is audited', async () => {
    const { svc, dbPath, student, teach } = rig();
    const now = Date.now();
    const hook = svc.hook();
    hook.logChat(entry(student, 'old', now - 40 * DAY));
    hook.logChat(entry(teach, 'old teach', now - 40 * DAY));
    hook.logChat(entry(student, 'recent', now - DAY));
    hook.logChat(entry(teach, 'recent teach', now - 1000));
    svc.flushAllQuiet();
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: { DB_PATH: dbPath } };
    expect(await runCli(['purge-log'], io)).toBe(1);
    expect(await runCli(['purge-log', '--before', 'soon'], io)).toBe(1);
    expect(await runCli(['purge-log', '--before', '30d'], io)).toBe(0);
    expect(out.join('')).toMatch(/Deleted 2 chat-log line\(s\) older than 30d\./);
    expect(count(dbPath, 'chat_log')).toBe(2);
    expect(await runCli(['purge-log', '--before', '1h', '--player', 'Student'], io)).toBe(0);
    expect(count(dbPath, 'chat_log')).toBe(1);
    expect(await runCli(['purge-log', '--all'], io)).toBe(1);
    expect(err.join('')).toMatch(/Add --yes/);
    expect(await runCli(['purge-log', '--all', '--yes'], io)).toBe(0);
    expect(count(dbPath, 'chat_log')).toBe(0);
    const notes = svc.store.listActions({}).actions.filter((a) => a.action === 'note' && a.reason.startsWith('purged'));
    expect(notes).toHaveLength(3);
  });

  it('CSV: numbers are written as numbers (team -1), only text cells get the formula guard', () => {
    expect(csvCell(-1)).toBe('-1');
    expect(csvCell(42)).toBe('42');
    expect(csvCell('-1')).toBe(`"'-1"`);
    expect(csvCell('@home')).toBe(`"'@home"`);
  });
});

describe('durations', () => {
  it('parses the moderator shorthands', () => {
    expect(parseDuration('10m')).toBe(600);
    expect(parseDuration('2h')).toBe(7200);
    expect(parseDuration('1d')).toBe(86400);
    expect(parseDuration('7d')).toBe(7 * 86400);
    expect(parseDuration('perm')).toBeNull();
    expect(parseDuration('0m')).toBeUndefined();
    expect(parseDuration('400d')).toBeUndefined();
    expect(parseDuration('soon')).toBeUndefined();
    expect(parseDuration(90)).toBe(90);
    void SYSTEM_ACTOR;
  });
});
