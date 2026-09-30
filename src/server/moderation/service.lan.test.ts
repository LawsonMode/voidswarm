// The v0.6 ModerationService (docs/LAN-EDITION-proposal.md §5.4, §5.8, §5.11, §5.2, §6.4; task B8b), without the
// maintenance worker: the Live ring and its long-poll (T-ADM-5, also over the real admin API), the per-tag strike
// policy and strikeStatus, alert routing (T-WB-1, the routing part: a SELF-HARM line gives a nameless alert and
// nothing in moderator feeds, in-game alerts or the log; threats reach trusted moderators name-only), report copies
// shown-only, and the retention plan (T-ADM-9). Test data only: generated names and passwords; custom terms are
// made-up words (no real lists).
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearCustomTerms, setCustomTerms } from '../../shared/moderation/filter';
import type { ClientMsg, ServerMsg } from '../../shared/protocol';
import {
  MSG_CARE, MSG_WARN_FIRST, MSG_WARN_LAST, type ChatLogEntry, type ModUser, type OnlinePilot,
} from '../../shared/room/moderation';
import type { Snapshot } from '../../shared/types';
import { PROTOCOL_VERSION } from '../../shared/version';
import { Zone, type ClientSink, type ZoneConnection } from '../../shared/room/Zone';
import { startAdminListener, type AdminListener } from '../listeners';
import { addAccount, open, tmpData, type TmpData } from '../maint/testutil';
import { bindSettings, type ModerationPolicy, type RetentionPolicy } from '../settings/bindings';
import { SettingsService, memoryBackend } from '../settings/service';
import { defaultTagPolicies, DEFAULT_TAG_DEFAULT } from '../settings/schema';
import { DEFAULT_ADMIN_POLICY, HostAdmin, formatSetupCode, newSetupCode, type AdminPolicy } from './hostAdmin';
import { createAdminHttp, createAdminSite, scrubReply, scrubRulesFor, ADMIN_ROUTES } from './http';
import {
  LIVE_MAX_WAITS, LiveFeed, ModerationService, liveLabel, liveQueryOf, moderationAdminHandlers, nextRetentionAt, purgeBeforeOf, retentionPlan, termPurgeOwed,
  type MaintAccess, type ZoneControl,
} from './service';

const MIN = 60_000;
const DAY = 86_400_000;
const FAST = { N: 1 << 10, r: 8, p: 1, keylen: 32 } as const;

const temps: TmpData[] = [];
const services: ModerationService[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  clearCustomTerms();
  for (const c of cleanups.splice(0).reverse()) await c();
  for (const s of services.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) t.cleanup();
});

class FakeZone implements ZoneControl {
  pilots: OnlinePilot[] = [];
  told: [number, string][] = [];
  add(p: Partial<OnlinePilot> & { playerId: number; name: string }): OnlinePilot {
    const full: OnlinePilot = { accountId: null, username: null, address: '10.1.1.1', roomId: null, roomName: null, ...p };
    this.pilots.push(full);
    return full;
  }
  onlinePilots(): OnlinePilot[] { return this.pilots.slice(); }
  kickPilots(): number { return 0; }
  tellPilot(playerId: number, text: string): boolean { this.told.push([playerId, text]); return true; }
  toldTo(pid: number): string[] { return this.told.filter(([p]) => p === pid).map(([, t]) => t); }
}

interface Rig { svc: ModerationService; t: TmpData; logs: string[]; clock: { t: number }; zone: FakeZone }

function rig(o: { liveRingSize?: number; accounts?: string[]; clock?: boolean; liveSeqBase?: number } = {}): Rig {
  const t = tmpData('vs-modlan-');
  temps.push(t);
  const db = open(t.db);
  for (const u of o.accounts ?? ['NovaPilot', 'VegaPilot', 'TeachMod']) addAccount(db, { id: `acc-${u.toLowerCase()}`, username: u });
  db.close();
  const logs: string[] = [];
  const clock = { t: Date.UTC(2026, 8, 28, 15, 0, 0) };
  const svc = new ModerationService({
    dbPath: t.db, timers: false, env: {}, log: (l) => logs.push(l), liveRingSize: o.liveRingSize, liveSeqBase: o.liveSeqBase ?? 0,
    ...(o.clock === false ? {} : { now: () => clock.t }),
  });
  services.push(svc);
  const zone = new FakeZone();
  svc.attachZone(zone);
  return { svc, t, logs, clock, zone };
}

let seq = 0;
function entry(over: Partial<ChatLogEntry> = {}): ChatLogEntry {
  seq++;
  return {
    time: Date.UTC(2026, 8, 28, 15, 0, 0) + seq, roomId: 'r2', roomName: 'Flag Run', roomUid: 'boot1:r2', channel: 'all', team: 0, playerId: 5, name: 'NovaPilot',
    accountId: 'acc-novapilot', address: '10.0.0.5', original: `line ${seq}`, shown: `line ${seq}`, action: 'pass', hits: [], display: 'as-typed', ...over,
  };
}

const policyOf = (over: Partial<ModerationPolicy> = {}): ModerationPolicy => ({
  tags: defaultTagPolicies(), tagDefault: { ...DEFAULT_TAG_DEFAULT },
  retention: { mode: 'days', days: 90, termEnd: null, graceDays: 14, recordsDays: 365 }, addressMinimisation: false, tier: 'limited',
  moderatorView: true, moderatorLogSearch: false, ...over,
});

const STUDENT: ModUser = { playerId: 5, name: 'NovaPilot', accountId: 'acc-novapilot', username: 'NovaPilot', address: '10.0.0.5' };

// ------------------------------------------------------------------------------------------ the Live ring

describe('the Live ring (§5.4)', () => {
  it('numbers every logged line; a line never carries the original or hit labels; SELF-HARM lines are nameless', () => {
    const { svc } = rig();
    const h = svc.hook();
    h.logChat(entry({ original: 'hello team', shown: 'hello team' }));
    h.logChat(entry({ original: 'the words they typed', shown: 'GG, pilots!', action: 'block', hits: ['profanity:x'], display: 'substituted' }));
    h.logChat(entry({ channel: 'team', team: 1, original: 'go left', shown: 'go left' }));
    h.logChat(entry({ roomId: null, roomName: 'Zone', roomUid: 'boot1:zone', team: -1, original: 'lobby hi', shown: 'lobby hi' }));
    h.logChat(entry({ channel: 'announce', roomId: null, roomName: 'All rooms', roomUid: null, playerId: 0, name: 'Host', accountId: null, address: null, original: 'Class ends soon', shown: '[Host] Class ends soon' }));
    h.logChat(entry({ original: 'a private sad line', shown: '', action: 'block', hits: ['selfharm:x'], display: 'withheld' }));
    const page = svc.live.page({ includeWellbeing: true });
    expect(page.next).toBe(6);
    expect(page.gap).toBe(false);
    expect(page.lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    const text = JSON.stringify(page);
    expect(text).not.toContain('the words they typed');
    expect(text).not.toContain('a private sad line');
    expect(text).not.toContain('"original"');
    expect(text).not.toContain('"hits"');
    expect(page.lines[1]).toMatchObject({ shown: 'GG, pilots!', display: 'substituted', tags: ['PROFANITY'], action: 'block', name: 'NovaPilot' });
    expect(page.lines[5]).toMatchObject({ wellbeing: true, name: '', shown: '', accountId: null, address: null, playerId: 0, online: false, tags: ['SELF-HARM'], roomName: 'Flag Run' });
    expect(page.lines.map((l) => l.label)).toEqual([
      'Flag Run · Crimson', 'Flag Run · Crimson', 'Flag Run · Azure (team chat)', 'Zone lobby', 'All rooms (announcement)', 'Flag Run · Crimson',
    ]);
    // filters
    expect(svc.live.page({ tag: 'profanity' }).lines.map((l) => l.seq)).toEqual([2]);
    expect(svc.live.page({ flaggedOnly: true, includeWellbeing: true }).lines.map((l) => l.seq)).toEqual([2, 6]);
    expect(svc.live.page({ roomUid: 'boot1:r2' }).lines.map((l) => l.seq)).toEqual([1, 2, 3, 5]); // a zone-wide announcement shows in every room
    expect(svc.live.page({ channel: 'lobby' }).lines.map((l) => l.seq)).toEqual([4]);
    expect(svc.live.page({ channel: 'team' }).lines.map((l) => l.seq)).toEqual([3]);
    expect(svc.live.page({ player: 'novapilot', includeWellbeing: true }).lines.map((l) => l.seq)).toEqual([1, 2, 3, 4]); // never the nameless line
    expect(svc.live.page({}).lines.some((l) => l.wellbeing)).toBe(false); // moderators: none at all
    expect(svc.live.page({ after: 2, limit: 2 })).toMatchObject({ gap: true, next: 6 });
    expect(liveLabel({ roomId: 'r1', roomName: 'Duel Pit', channel: 'name', team: -1 })).toBe('Duel Pit (callsign)');
  });

  it('online is true for pilots connected now; a gap when the ring overwrote lines or the server restarted', () => {
    const { svc, zone } = rig({ liveRingSize: 10 });
    zone.add({ playerId: 5, name: 'NovaPilot', accountId: 'acc-novapilot' });
    const h = svc.hook();
    for (let i = 0; i < 5; i++) h.logChat(entry());
    expect(svc.live.page({ after: 5 })).toEqual({ lines: [], next: 5, gap: false });
    expect(svc.live.page({ after: 3 }).lines.map((l) => [l.seq, l.online])).toEqual([[4, true], [5, true]]);
    for (let i = 0; i < 20; i++) h.logChat(entry({ playerId: 9 }));
    expect(svc.live.oldest).toBe(16);
    const p = svc.live.page({ after: 5 });
    expect(p.gap).toBe(true);
    expect(p.lines[0]!.seq).toBe(16);
    expect(p.lines.every((l) => !l.online)).toBe(true);
    expect(svc.live.page({ after: 14 }).gap).toBe(true);
    expect(svc.live.page({ after: 15 }).gap).toBe(false);
    expect(svc.live.page({ after: 99 })).toMatchObject({ gap: true, next: 25 }); // an earlier run's cursor
  });

  it('a long-poll resolves within 100 ms of a matching line, keeps waiting past others, times out, and frees its slot on abort', async () => {
    const { svc } = rig({ clock: false });
    const h = svc.hook();
    const w = svc.livePoll({ after: 0, tag: 'PROFANITY' }, { waitMs: 5000, key: 's1' });
    let done = false;
    void w.then(() => { done = true; });
    h.logChat(entry());
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false); // not the tag it waits for
    const t0 = performance.now();
    h.logChat(entry({ action: 'mask', shown: 'GG, pilots!', hits: ['profanity:x'], display: 'substituted' }));
    const page = await w;
    expect(performance.now() - t0).toBeLessThan(100);
    expect(page).toMatchObject({ next: 2, gap: false });
    expect(page !== 'busy' && page.lines.map((l) => l.seq)).toEqual([2]);
    // the timeout
    const t1 = performance.now();
    expect(await svc.livePoll({ after: 2 }, { waitMs: 60, key: 's1' })).toEqual({ lines: [], next: 2, gap: false });
    expect(performance.now() - t1).toBeGreaterThanOrEqual(50);
    // at most 4 waits per session; an abort frees one
    const acs = Array.from({ length: LIVE_MAX_WAITS }, () => new AbortController());
    const waits = acs.map((ac) => svc.livePoll({ after: 2 }, { waitMs: 5000, key: 's2', signal: ac.signal }));
    expect(svc.live.waiting).toBe(LIVE_MAX_WAITS);
    expect(await svc.livePoll({ after: 2 }, { waitMs: 5000, key: 's2' })).toBe('busy');
    expect(svc.livePoll({ after: 2 }, { waitMs: 5000, key: 'other session' })).not.toBe('busy');
    acs[0]!.abort();
    expect(await waits[0]).toEqual({ lines: [], next: 2, gap: false });
    const again = svc.livePoll({ after: 2 }, { waitMs: 5000, key: 's2' });
    h.logChat(entry());
    const all = await Promise.all([again, ...waits.slice(1)]);
    for (const p of all) expect(p !== 'busy' && p.lines.map((l) => l.seq)).toEqual([3]);
    // shutdown answers whoever still waits
    const last = svc.livePoll({ after: 3 }, { waitMs: 5000, key: 's3' });
    svc.close();
    expect(await last).toMatchObject({ lines: [] });
  });

  it('liveQueryOf validates the body', () => {
    expect(liveQueryOf({ after: 5, wait: 25, limit: 10, tag: 'gang', channel: 'lobby', flaggedOnly: true })).toEqual({
      q: { after: 5, limit: 10, roomUid: undefined, tag: 'GANG', flaggedOnly: true, channel: 'lobby', player: undefined }, waitMs: 25_000,
    });
    expect(() => liveQueryOf({ wait: 26 })).toThrow(/wait/);
    expect(() => liveQueryOf({ after: -1 })).toThrow(/after/);
    expect(() => liveQueryOf({ limit: 501 })).toThrow(/limit/);
    expect(() => liveQueryOf({ channel: 'whisper' })).toThrow(/channel/);
  });
});

// ------------------------------------------------------------------------------------------ T-ADM-5 over HTTP

interface Reply { status: number; text: string; json: Record<string, unknown>; headers: Record<string, unknown> }

function post(port: number, name: string, body: unknown, token?: string, signal?: AbortSignal): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({
      host: '127.0.0.1', port, path: `/api/admin/${name}`, method: 'POST', agent: false, signal,
      headers: {
        Host: `localhost:${port}`, Origin: `http://localhost:${port}`, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* a file */ }
        resolve({ status: res.statusCode ?? 0, text, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function adminStack(svc: ModerationService, dbPath: string): Promise<{ port: number; token: string }> {
  const policy: AdminPolicy = { ...DEFAULT_ADMIN_POLICY };
  const codes: string[] = [];
  const ha = new HostAdmin({ dbPath, policy: () => policy, passwordParams: FAST, pepper: randomBytes(32), onSetupCode: (c) => codes.push(c) });
  const api = createAdminHttp({ service: svc, trustProxy: false, log: () => undefined, hostAdmin: ha, policy: () => policy, handlers: moderationAdminHandlers(svc) });
  const listener: AdminListener = await startAdminListener({
    port: 0, policy: () => ({ remoteAccess: policy.remoteAccess, devicesTrustCert: policy.devicesTrustCert }), handle: createAdminSite({ api }),
    loopback: ['127.0.0.1'], lan: null,
  });
  cleanups.push(async () => { await listener.close(); ha.close(); });
  const code = newSetupCode();
  ha.installLaunchCode(code);
  const password = `${randomBytes(12).toString('base64url')}-Aa7`;
  const r = await post(listener.port, 'setup', { setupCode: formatSetupCode(code), username: 'NovaHost', password, preset: 'home', serverName: 'Den', accountsMode: 'email' });
  expect(r.status, r.text).toBe(200);
  return { port: listener.port, token: r.json.token as string };
}

describe('T-ADM-5 chat/live over the admin API', () => {
  it('resolves within 100 ms of a new line; gap; a 5th wait gets 429; an abort frees the waiter; lines carry no original', async () => {
    const { svc, t } = rig({ clock: false, liveRingSize: 50 });
    const { port, token } = await adminStack(svc, t.db);
    const h = svc.hook();
    expect(ADMIN_ROUTES['chat/live']).toMatchObject({ cap: 'live', passive: true });
    const first = await post(port, 'chat/live', {}, token);
    expect(first.status, first.text).toBe(200);
    expect(first.json).toMatchObject({ ok: true, lines: [], next: 0, gap: false });

    // a long-poll answered by the next line
    const waiting = post(port, 'chat/live', { after: 0, wait: 5 }, token);
    await new Promise((r) => setTimeout(r, 50));
    const t0 = performance.now();
    h.logChat(entry({ original: 'what the student typed', shown: 'GG, pilots!', action: 'block', hits: ['profanity:x'], display: 'substituted' }));
    const got = await waiting;
    expect(performance.now() - t0).toBeLessThan(100);
    expect(got.status).toBe(200);
    expect(got.json).toMatchObject({ next: 1, gap: false });
    expect((got.json.lines as { shown: string }[])[0]!.shown).toBe('GG, pilots!');
    expect(got.text).not.toContain('what the student typed');
    expect(got.text).not.toContain('"original"');
    // a principal without `addresses` would get a tag; the host on the host PC sees the address
    expect((got.json.lines as { address?: string }[])[0]!.address).toBe('10.0.0.5');

    // the gap: the ring (50) moved past the cursor
    for (let i = 0; i < 60; i++) h.logChat(entry());
    const gap = await post(port, 'chat/live', { after: 1 }, token);
    expect(gap.json).toMatchObject({ gap: true, next: 61 });

    // 4 waits at once per session; the 5th: 429
    const acs = Array.from({ length: LIVE_MAX_WAITS }, () => new AbortController());
    const polls = acs.map((ac) => post(port, 'chat/live', { after: 61, wait: 10 }, token, ac.signal).catch((e: Error) => e));
    await new Promise((r) => setTimeout(r, 150));
    expect(svc.live.waiting).toBe(LIVE_MAX_WAITS);
    const fifth = await post(port, 'chat/live', { after: 61, wait: 10 }, token);
    expect(fifth.status).toBe(429);
    // the client goes away: its waiter is freed, and a new wait is taken
    acs[0]!.abort();
    await polls[0];
    for (let i = 0; i < 50 && svc.live.waiting >= LIVE_MAX_WAITS; i++) await new Promise((r) => setTimeout(r, 10));
    expect(svc.live.waiting).toBe(LIVE_MAX_WAITS - 1);
    const sixth = post(port, 'chat/live', { after: 61, wait: 10 }, token);
    await new Promise((r) => setTimeout(r, 100));
    expect(svc.live.waiting).toBe(LIVE_MAX_WAITS);
    h.logChat(entry());
    const answers = await Promise.all([sixth, ...polls.slice(1)]) as Reply[];
    for (const a of answers) expect(a.json).toMatchObject({ ok: true, next: 62 });
  });

  it('a moderator never receives a SELF-HARM line, nor an address; a host session without `wellbeing` gets the nameless line', () => {
    const { svc } = rig();
    svc.hook().logChat(entry());
    svc.hook().logChat(entry({ original: 'sad words', shown: '', action: 'block', hits: ['selfharm:x'], display: 'withheld' }));
    const spec = ADMIN_ROUTES['chat/live']!;
    const tag = (a: string): string => `t${a.length}`;
    const forMod = scrubReply(svc.live.page({ includeWellbeing: false }), scrubRulesFor({ kind: 'moderator', tier: 'trusted' }, spec), tag) as { lines: Record<string, unknown>[] };
    expect(forMod.lines).toHaveLength(1);
    expect(forMod.lines[0]!.address).toBeUndefined();
    expect(forMod.lines[0]!.addressTag).toBe('t8');
    const forLimitedHost = scrubReply(svc.live.page({ includeWellbeing: true }), scrubRulesFor({ kind: 'host', via: 'limited' }, spec), tag) as { lines: Record<string, unknown>[] };
    expect(forLimitedHost.lines).toHaveLength(2);
    expect(forLimitedHost.lines[1]).toMatchObject({ wellbeing: true, name: '', shown: '' });
    expect(JSON.stringify(forLimitedHost)).not.toContain('sad words');
  });
});

// ------------------------------------------------------------------------------------------ the tag policy

describe('the per-tag strike policy (§5.8)', () => {
  it('defaults: PROFANITY counts to the strike limit (3); THREAT mutes after 2; strikeStatus escalates the warning', () => {
    const { svc, clock, zone } = rig();
    const teach = zone.add({ playerId: 1, name: 'TeachMod', accountId: 'acc-teachmod', username: 'TeachMod' });
    svc.store.addAdmin('acc-teachmod', 'test', clock.t);
    svc.reload();
    const h = svc.hook();
    const prof = { tags: ['PROFANITY'], action: 'mask' as const };
    expect(h.onStrike(STUDENT, 'language', prof)).toBeNull();
    expect(h.strikeStatus!(STUDENT)).toEqual({ count: 1, limit: 3 });
    clock.t += MIN;
    expect(h.onStrike(STUDENT, 'language', prof)).toBeNull(); // no "one more" text: the Zone writes it from strikeStatus
    expect(h.strikeStatus!(STUDENT)).toEqual({ count: 2, limit: 3 });
    clock.t += MIN;
    expect(h.onStrike(STUDENT, 'language', prof)).toBe('You are muted for 10 minutes (repeated blocked language).');
    expect(h.isMuted(STUDENT)).not.toBeNull();
    expect(zone.toldTo(teach.playerId).some((t) => t.includes('Auto-muted NovaPilot'))).toBe(true);

    const other: ModUser = { ...STUDENT, playerId: 6, name: 'VegaPilot', accountId: 'acc-vegapilot', username: 'VegaPilot' };
    const threat = { tags: ['THREAT'], action: 'block' as const };
    expect(h.onStrike(other, 'threat', threat)).toBeNull();
    expect(h.strikeStatus!(other)).toEqual({ count: 1, limit: 2 }); // THREAT's own autoMuteAfter is closer than the limit
    expect(h.onStrike(other, 'threat', threat)).toMatch(/^You are muted for 10 minutes/);
  });

  it('a tag whose policy says no strike is no strike at all; custom labels follow tagDefault until they get a row', () => {
    const { svc } = rig();
    const h = svc.hook();
    svc.setPolicy(policyOf({ tags: { ...defaultTagPolicies(), PROFANITY: { strike: false, autoMuteAfter: null, notify: 'none', dailySummary: true } } }));
    for (let i = 0; i < 5; i++) expect(h.onStrike(STUDENT, 'language', { tags: ['PROFANITY'], action: 'mask' })).toBeNull();
    expect(h.strikeStatus!(STUDENT)).toEqual({ count: 0, limit: 3 });
    expect(svc.strikeCount(STUDENT)).toBe(0);
    expect(h.onStrike(STUDENT, 'language', { tags: ['BULLYING'], action: 'block' })).toBeNull();
    expect(svc.strikeCount(STUDENT)).toBe(0); // "Other custom labels": strike no
    svc.setPolicy(policyOf({ tags: { ...defaultTagPolicies(), BULLYING: { strike: true, autoMuteAfter: 1, notify: 'banner', dailySummary: true } } }));
    expect(h.onStrike(STUDENT, 'language', { tags: ['BULLYING'], action: 'block' })).toMatch(/^You are muted/);
    // SELF-HARM is never a strike, whatever the settings say
    expect(svc.tagPolicy('SELF-HARM')).toMatchObject({ strike: false, autoMuteAfter: null });
    svc.setPolicy(policyOf({ tags: { ...defaultTagPolicies(), 'SELF-HARM': { strike: true, autoMuteAfter: 1, notify: 'none', dailySummary: true } } }));
    expect(svc.tagPolicy('SELF-HARM')).toEqual({ strike: false, autoMuteAfter: null, notify: 'banner', dailySummary: true });
  });

  it('bindSettings drives setConfig and setPolicy: tag policy, tier and retention apply live', async () => {
    const { svc } = rig();
    const settings = SettingsService.open({ backend: memoryBackend(), env: {}, log: () => undefined });
    const off = bindSettings(settings, { moderation: svc, log: () => undefined });
    expect(svc.moderatorTier).toBe('limited'); // the settings' default (the service alone would be `trusted`)
    expect(svc.retentionInfo()).toMatchObject({ mode: 'days', days: 90, recordsDays: 365 });
    const actor = { accountId: 'host:1', name: 'NovaHost' };
    const r = await settings.update({ rev: settings.rev, patch: { chat: { tags: { PROFANITY: { strike: false } }, retention: { mode: 'term', termEnd: '2026-12-18' }, strikes: { limit: 4 } } } }, actor);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(svc.tagPolicy('PROFANITY').strike).toBe(false);
    expect(svc.config.strikeLimit).toBe(4);
    expect(svc.retentionInfo()).toMatchObject({ mode: 'term', termEnd: '2026-12-18' });
    off();
  });

  it('an older Zone (no detail) counts every strike; setConfig applies the settings live', () => {
    const { svc } = rig();
    const h = svc.hook();
    svc.setConfig({ strikeLimit: 2, autoMuteSec: 1800, strikeWindowMs: 5 * MIN, retentionDays: 30, keepDays: 400, chatFilter: 'standard' });
    expect(svc.config).toMatchObject({ strikeLimit: 2, autoMuteSec: 1800, strikeWindowMs: 5 * MIN, retentionDays: 30, keepDays: 400, chatFilter: 'standard' });
    svc.setConfig({ strikeLimit: 0, autoMuteSec: Number.NaN }); // ignored
    expect(svc.config.strikeLimit).toBe(2);
    expect(h.onStrike(STUDENT, 'language')).toBeNull();
    expect(h.onStrike(STUDENT, 'language')).toBe('You are muted for 30 minutes (repeated blocked language).');
  });
});

// ------------------------------------------------------------------------------------------ alert routing

class FakeClient implements ClientSink {
  msgs: ServerMsg[] = [];
  conn!: ZoneConnection;
  sendMsg(m: ServerMsg): void { this.msgs.push(m); }
  sendSnapshot(_s: Snapshot): void { /* no sim */ }
  send(m: ClientMsg): void { this.conn.handle(m); }
  chats(): string[] { return this.msgs.filter((m): m is Extract<ServerMsg, { type: 'chat' }> => m.type === 'chat').map((m) => m.line.text); }
}

describe('T-WB-1 alert routing (with the real Zone)', () => {
  it('SELF-HARM: a nameless host alert; nothing to moderators in game, in Live or in the log. THREAT: the host\'s alert; trusted moderators name-only', () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    // made-up words, host-supplied as custom terms (no real list is used)
    expect(setCustomTerms([
      { term: 'glimmerbog', category: 'selfharm', action: 'block' },
      { term: 'zorbleflux', category: 'threat', action: 'block' },
      { term: 'plinkwort', category: 'hate', action: 'block' },
    ]).ok).toBe(true);
    const { svc, logs, t } = rig({ clock: false });
    const zone = new Zone({ snapshotEvery: 3, motd: '', local: false, moderation: svc.hook(), defaultRooms: [{ name: 'Main', botFill: 0 }] });
    cleanups.push(() => zone.stop());
    svc.attachZone(zone);
    svc.setPolicy(policyOf({ tier: 'limited' })); // the settings' default tier
    svc.store.addAdmin('acc-teachmod', 'test', Date.now());
    svc.reload();
    const mk = (name: string): FakeClient => {
      const c = new FakeClient();
      c.conn = zone.connect(c);
      c.conn.setAccount({ accountId: `acc-${name.toLowerCase()}`, username: name, emailMasked: 'x***@caldwellschools.org', createdAt: 1 });
      c.send({ type: 'hello', name, protocol: PROTOCOL_VERSION, version: 'test', token: 'tok' });
      return c;
    };
    const nova = mk('NovaPilot');
    const vega = mk('VegaPilot');
    const mod = mk('TeachMod');
    const say = (text: string): void => { vi.setSystemTime(Date.now() + 1100); nova.send({ type: 'chat', channel: 'all', text }); };
    const modLines = (): string[] => mod.chats().filter((l) => l.startsWith('[mod]'));

    say('i feel glimmerbog today');
    expect(nova.chats().at(-1)).toBe(MSG_CARE);
    expect(vega.chats().some((l) => l.includes('glimmerbog'))).toBe(false);
    const alerts = svc.alertsList();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'wellbeing', level: 'urgent', wellbeing: true, text: 'A wellbeing alert needs your attention' });
    expect(alerts[0]!.name).toBeUndefined();
    expect(alerts[0]!.playerId).toBeUndefined();
    expect(JSON.stringify(alerts)).not.toContain('NovaPilot');
    expect(modLines()).toEqual([]);
    expect(logs.some((l) => l.includes('NovaPilot') || /self-harm|wellbeing/i.test(l))).toBe(false);
    const live = svc.live.page({ includeWellbeing: true }).lines.filter((l) => l.wellbeing);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ name: '', shown: '', accountId: null, alertId: alerts[0]!.id });
    expect(svc.live.page({ includeWellbeing: false }).lines.some((l) => l.wellbeing)).toBe(false);
    expect(svc.alertCounts()).toEqual({ urgent: 1, banner: 0, wellbeing: 1 });
    expect(svc.banners().map((b) => b.code)).toContain('wellbeing');
    expect(JSON.stringify(svc.banners())).not.toContain('NovaPilot');

    // a threat: substituted; the host's alert names the student; a limited-tier moderator hears nothing in game
    say('you zorbleflux');
    expect(nova.chats().at(-1)).toBe(`${MSG_WARN_FIRST} ${MSG_WARN_LAST}`); // THREAT mutes after 2: this was the last warning
    const threat = svc.alertsList().find((a) => a.kind === 'threat')!;
    expect(threat).toMatchObject({ level: 'urgent', tag: 'THREAT', name: 'NovaPilot' });
    expect(JSON.stringify(threat)).not.toContain('zorbleflux');
    expect(modLines()).toEqual([]);
    expect(logs.some((l) => l.includes('zorbleflux'))).toBe(false);

    // trusted tier: name only, never the text
    svc.setPolicy(policyOf({ tier: 'trusted' }));
    vi.setSystemTime(Date.now() + 61_000);
    say('really zorbleflux');
    expect(modLines().some((l) => l.includes('NovaPilot wrote something threatening'))).toBe(true);
    expect(modLines().some((l) => l.includes('zorbleflux'))).toBe(false);
    expect(nova.chats().at(-1)).toBe('You are muted for 10 minutes (repeated blocked language).');

    // a HATE line (notify: banner) raises a banner alert with the name; the counts say so
    const vegaSay = (text: string): void => { vi.setSystemTime(Date.now() + 1100); vega.send({ type: 'chat', channel: 'all', text }); };
    vegaSay('such plinkwort');
    expect(svc.alertsList().find((a) => a.tag === 'HATE')).toMatchObject({ kind: 'tag', level: 'banner', name: 'VegaPilot' });
    expect(svc.alertCounts().banner).toBe(1);
  });

  it('the older hook calls: alert() without a line, onStrike(selfharm) — the same routing', () => {
    const { svc, zone, logs, clock } = rig();
    const teach = zone.add({ playerId: 1, name: 'TeachMod', accountId: 'acc-teachmod', username: 'TeachMod' });
    svc.store.addAdmin('acc-teachmod', 'test', clock.t);
    svc.reload();
    zone.add({ playerId: 5, name: 'NovaPilot', accountId: 'acc-novapilot', roomName: 'Flag Run' });
    const h = svc.hook();
    h.alert!(STUDENT, 'selfharm');
    h.alert!(STUDENT, 'selfharm'); // folded into the same alert within a minute
    expect(h.onStrike(STUDENT, 'selfharm')).toBeNull();
    expect(svc.strikeCount(STUDENT)).toBe(0);
    const a = svc.alertsList();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'wellbeing', count: 3, roomName: 'Flag Run' });
    expect(zone.toldTo(teach.playerId)).toEqual([]);
    expect(logs.filter((l) => /self-harm|wellbeing|NovaPilot/i.test(l))).toEqual([]);
    svc.setPolicy(policyOf({ tier: 'limited' }));
    h.alert!(STUDENT, 'threat');
    expect(zone.toldTo(teach.playerId)).toEqual([]); // limited tier (the settings' default)
    expect(svc.alertsList()[0]).toMatchObject({ kind: 'threat', name: 'NovaPilot' });
  });

  it('with no settings bound (the pre-0.6 server) moderators keep the v0.5 view: threat names and reporters, never self-harm', async () => {
    const { svc, zone, clock } = rig();
    const teach = zone.add({ playerId: 1, name: 'TeachMod', accountId: 'acc-teachmod', username: 'TeachMod' });
    svc.store.addAdmin('acc-teachmod', 'test', clock.t);
    svc.reload();
    expect(svc.moderatorTier).toBe('trusted');
    const nova = zone.add({ playerId: 5, name: 'NovaPilot', accountId: 'acc-novapilot', username: 'NovaPilot' });
    const vega = zone.add({ playerId: 6, name: 'VegaPilot', accountId: 'acc-vegapilot', username: 'VegaPilot' });
    svc.hook().alert!(nova, 'selfharm');
    svc.hook().alert!(nova, 'threat');
    expect(zone.toldTo(teach.playerId)).toEqual(['[mod] NovaPilot wrote something threatening (not shown to anyone) — /log NovaPilot']);
    await svc.hook().report(vega, 'NovaPilot', 'rude', { roomId: null, roomName: 'Zone' });
    expect(zone.toldTo(teach.playerId).at(-1)).toMatch(/^\[mod\] New report #\d+: VegaPilot reported NovaPilot — rude/);
    svc.setPolicy(policyOf({ tier: 'limited' }));
    clock.t += 10 * MIN + 1;
    await svc.hook().report(vega, 'NovaPilot', 'again', { roomId: null, roomName: 'Zone' });
    expect(zone.toldTo(teach.playerId).at(-1)).toMatch(/^\[mod\] New report #\d+ about NovaPilot — again/); // limited: no reporter
  });

  it('the in-game /log (a moderator\'s feed) never shows a SELF-HARM line; the report snapshot keeps only its marked copy', async () => {
    const { svc, zone, clock } = rig();
    zone.add({ playerId: 1, name: 'TeachMod', accountId: 'acc-teachmod', username: 'TeachMod' });
    zone.add({ playerId: 5, name: 'NovaPilot', accountId: 'acc-novapilot', username: 'NovaPilot' });
    svc.store.addAdmin('acc-teachmod', 'test', clock.t);
    svc.reload();
    const h = svc.hook();
    h.logChat(entry({ original: 'good game', shown: 'good game' }));
    h.logChat(entry({ original: 'a private sad line', shown: '', action: 'block', hits: ['selfharm:x'], display: 'withheld' }));
    const mod: ModUser = { playerId: 1, name: 'TeachMod', accountId: 'acc-teachmod', username: 'TeachMod', address: '10.9.9.9' };
    const out = (await h.adminCommand(mod, 'log', ['NovaPilot'])).join('\n');
    expect(out).toContain('good game');
    expect(out).not.toContain('a private sad line');
    expect(out).toMatch(/Last 1 line/);
    const target = svc.resolveTarget('NovaPilot')!;
    expect(svc.chatOf(target, 10).map((l) => l.original)).toEqual(['good game']);
    expect(svc.chatOf(target, 10, { wellbeing: true })).toHaveLength(2);
  });

  it('alerts/ack: a wellbeing alert is acknowledged once, audited without a name, and leaves the counts', async () => {
    const { svc } = rig();
    svc.hook().alert!(STUDENT, 'selfharm');
    const id = svc.alertsList()[0]!.id;
    const r = await svc.ackAlert(id, { accountId: 'host', name: 'NovaHost' }, 'spoke with the counselor');
    expect(r.ok && r.alert).toMatchObject({ acked: true, kind: 'wellbeing' });
    expect(svc.alertCounts()).toEqual({ urgent: 0, banner: 0, wellbeing: 0 });
    const acts = svc.store.listActions({}).actions;
    expect(acts[0]).toMatchObject({ action: 'wellbeing-ack', targetAccountId: null, targetName: null });
    expect(acts[0]!.reason).not.toContain('NovaPilot');
    expect(acts[0]!.reason).not.toContain('counselor'); // the note is kept with the alert, not in the audit reason
    expect((await svc.ackAlert(999, { accountId: 'host', name: 'NovaHost' })).ok).toBe(false);
    expect(svc.alertsList({ includeAcked: false })).toEqual([]);
  });

  it('the urgent alert email is content-free and at most once in 10 minutes', () => {
    const { svc, clock } = rig();
    const sent: unknown[][] = [];
    svc.setUrgentAlertSink((...args: unknown[]) => { sent.push(args); });
    svc.hook().alert!(STUDENT, 'selfharm');
    svc.hook().alert!({ ...STUDENT, playerId: 6, accountId: 'acc-vegapilot', name: 'VegaPilot' }, 'threat');
    expect(sent).toEqual([[]]);
    clock.t += 10 * MIN + 1;
    svc.hook().alert!({ ...STUDENT, playerId: 7, accountId: 'acc-x', name: 'X' }, 'threat');
    expect(sent).toHaveLength(2);
  });
});

/** The real Zone on a rig: NovaPilot and VegaPilot (students) and TeachMod (a moderator), signed in. */
function zoneWorld(tier: 'limited' | 'trusted'): { svc: ModerationService; logs: string[]; nova: FakeClient; vega: FakeClient; mod: FakeClient; say: (c: FakeClient, text: string) => void } {
  const { svc, logs } = rig({ clock: false });
  const zone = new Zone({ snapshotEvery: 3, motd: '', local: false, moderation: svc.hook(), defaultRooms: [{ name: 'Main', botFill: 0 }] });
  cleanups.push(() => zone.stop());
  svc.attachZone(zone);
  svc.setPolicy(policyOf({ tier }));
  svc.store.addAdmin('acc-teachmod', 'test', Date.now());
  svc.reload();
  const mk = (name: string): FakeClient => {
    const c = new FakeClient();
    c.conn = zone.connect(c);
    c.conn.setAccount({ accountId: `acc-${name.toLowerCase()}`, username: name, emailMasked: 'x***@caldwellschools.org', createdAt: 1 });
    c.send({ type: 'hello', name, protocol: PROTOCOL_VERSION, version: 'test', token: 'tok' });
    return c;
  };
  const say = (c: FakeClient, text: string): void => { vi.setSystemTime(Date.now() + 1100); c.send({ type: 'chat', channel: 'all', text }); };
  return { svc, logs, nova: mk('NovaPilot'), vega: mk('VegaPilot'), mod: mk('TeachMod'), say };
}

describe('T-WB-1: a SELF-HARM line that also has a THREAT, HATE or GANG word raises no named alert', () => {
  const forRemoteLimitedHost = (svc: ModerationService): Record<string, unknown>[] =>
    (scrubReply({ alerts: svc.alertsList() }, scrubRulesFor({ kind: 'host', via: 'limited' }, ADMIN_ROUTES['alerts/list']!), (a) => a) as { alerts: Record<string, unknown>[] }).alerts;

  for (const tier of ['trusted', 'limited'] as const) {
    it(`self-harm + threat (${tier} moderators): one nameless wellbeing alert with the THREAT chip; nothing in game, in the log or in Live names the student`, () => {
      vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
      expect(setCustomTerms([
        { term: 'glimmerbog', category: 'selfharm', action: 'block' },
        { term: 'zorbleflux', category: 'threat', action: 'block' },
      ]).ok).toBe(true);
      const w = zoneWorld(tier);
      w.say(w.nova, 'glimmerbog and zorbleflux');
      expect(w.nova.chats().at(-1)).toBe(MSG_CARE); // withheld as a SELF-HARM line
      const alerts = w.svc.alertsList();
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ kind: 'wellbeing', level: 'urgent', wellbeing: true, tags: ['SELF-HARM', 'THREAT'] });
      expect(alerts[0]!.name).toBeUndefined();
      expect(JSON.stringify(alerts)).not.toContain('NovaPilot');
      expect(JSON.stringify(forRemoteLimitedHost(w.svc))).not.toContain('NovaPilot');
      expect(w.mod.chats().filter((l) => l.startsWith('[mod]'))).toEqual([]);
      expect(w.logs.filter((l) => !l.startsWith('[mod] ready'))).toEqual([]);
      const live = w.svc.live.page({ includeWellbeing: true }).lines.filter((l) => l.wellbeing);
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ name: '', alertId: alerts[0]!.id });
      expect(w.svc.alertCounts()).toEqual({ urgent: 1, banner: 0, wellbeing: 1 });
      expect(w.svc.banners().map((b) => b.code)).toEqual(['wellbeing']); // counted once, never as a second urgent alert
      // an ordinary threat afterwards still names the student (a line of its own)
      vi.setSystemTime(Date.now() + 61_000);
      w.say(w.nova, 'you zorbleflux');
      expect(w.svc.alertsList().find((a) => a.kind === 'threat')).toMatchObject({ name: 'NovaPilot' });
      expect(w.mod.chats().some((l) => l.includes('NovaPilot wrote something threatening'))).toBe(tier === 'trusted');
    });
  }

  it('self-harm + HATE + GANG (notify: banner): the chips fold into the one wellbeing alert', () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    expect(setCustomTerms([
      { term: 'glimmerbog', category: 'selfharm', action: 'block' },
      { term: 'plinkwort', category: 'hate', action: 'block' },
      { term: 'snarfquill', category: 'gang', action: 'block' },
    ]).ok).toBe(true);
    const w = zoneWorld('limited');
    w.say(w.nova, 'glimmerbog plinkwort snarfquill');
    expect(w.nova.chats().at(-1)).toBe(MSG_CARE);
    const alerts = w.svc.alertsList();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'wellbeing', level: 'urgent' });
    expect([...(alerts[0]!.tags as string[])].sort()).toEqual(['GANG', 'HATE', 'SELF-HARM']);
    expect(JSON.stringify(forRemoteLimitedHost(w.svc))).not.toContain('NovaPilot');
    expect(w.svc.live.page({ includeWellbeing: true }).lines.find((l) => l.wellbeing)!.alertId).toBe(alerts[0]!.id);
    expect(w.logs.filter((l) => !l.startsWith('[mod] ready'))).toEqual([]);
  });

  it('a threat line with a review-only SELF-HARM term: the threat folds into the nameless wellbeing alert too', () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    expect(setCustomTerms([
      { term: 'plonkwhistle', category: 'selfharm', action: 'flag' },
      { term: 'zorbleflux', category: 'threat', action: 'block' },
    ]).ok).toBe(true);
    const w = zoneWorld('trusted');
    w.say(w.nova, 'plonkwhistle zorbleflux');
    const alerts = w.svc.alertsList();
    expect(alerts.map((a) => a.kind)).toEqual(['wellbeing']);
    expect(alerts[0]!.tags).toEqual(['SELF-HARM', 'THREAT']);
    expect(w.mod.chats().filter((l) => l.includes('threatening'))).toEqual([]);
    expect(w.logs.filter((l) => l.includes('threat alert'))).toEqual([]);
  });

  it('the hook without the Zone: a threat alert on a withheld line, before the self-harm call, is the same one alert', () => {
    const { svc, zone, logs, clock } = rig();
    const teach = zone.add({ playerId: 1, name: 'TeachMod', accountId: 'acc-teachmod', username: 'TeachMod' });
    svc.store.addAdmin('acc-teachmod', 'test', clock.t);
    svc.reload();
    const h = svc.hook();
    const e = entry({ original: 'x', shown: '', action: 'block', hits: ['threat:x', 'selfharm:y'], display: 'withheld' });
    h.logChat(e);
    h.alert!(STUDENT, 'threat', e);
    h.alert!(STUDENT, 'selfharm', e);
    const a = svc.alertsList();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'wellbeing', count: 1, tags: ['SELF-HARM', 'THREAT'] });
    expect(zone.toldTo(teach.playerId)).toEqual([]);
    expect(logs.filter((l) => !l.startsWith('[mod] ready'))).toEqual([]);
    expect(svc.live.item(svc.live.seq)!.alertId).toBe(a[0]!.id);
    // SELF-HARM set to banner: the folded THREAT makes the one alert urgent, and it is still one banner
    svc.setPolicy(policyOf({ tags: { ...defaultTagPolicies(), 'SELF-HARM': { strike: false, autoMuteAfter: null, notify: 'banner', dailySummary: true } } }));
    const sent: number[] = [];
    svc.setUrgentAlertSink(() => { sent.push(1); });
    const vega: ModUser = { ...STUDENT, playerId: 6, name: 'VegaPilot', accountId: 'acc-vegapilot', username: 'VegaPilot' };
    const e2 = entry({ playerId: 6, name: 'VegaPilot', accountId: 'acc-vegapilot', original: 'y', shown: '', action: 'block', hits: ['threat:x', 'selfharm:y'], display: 'withheld' });
    h.logChat(e2);
    h.alert!(vega, 'selfharm', e2);
    h.alert!(vega, 'threat', e2);
    const b = svc.alertsList().find((x) => x.id !== a[0]!.id)!;
    expect(b).toMatchObject({ kind: 'wellbeing', level: 'urgent', tags: ['SELF-HARM', 'THREAT'] });
    expect(sent).toEqual([1]); // the content-free alert email
    expect(svc.banners().filter((x) => x.level === 'urgent').map((x) => x.code)).toEqual(['wellbeing']);
    expect(svc.banners().find((x) => x.code === 'wellbeing')!.text).toMatch(/^2 wellbeing alerts need your attention/);
  });
});

// ------------------------------------------------------------------------------------------ Live after a restart

describe('the Live cursor after a restart (§5.4 gap)', () => {
  const e = (i: number): ChatLogEntry => entry({ original: `l${i}`, shown: `l${i}` });

  it('each run numbers its lines from its start time: an old cursor is a gap, then every line of the new run', () => {
    const t0 = Date.UTC(2026, 8, 28, 8, 0, 0);
    const first = new LiveFeed(100, undefined, t0);
    for (let i = 0; i < 8; i++) first.push(e(i));
    const oldCursor = first.page({}).next;
    expect(oldCursor).toBe(t0 + 8);
    const second = new LiveFeed(100, undefined, t0 + 60_000); // restarted a minute later
    for (let i = 0; i < 8; i++) second.push(e(i));
    const p = second.page({ after: oldCursor });
    expect(p.gap).toBe(true);
    expect(p.lines.map((l) => l.seq)).toEqual(Array.from({ length: 8 }, (_, i) => t0 + 60_001 + i));
    expect(second.page({ after: 5 })).toMatchObject({ gap: true }); // any small cursor, e.g. the verifier's
    expect(second.page({ after: 5 }).lines).toHaveLength(8);
    const now = second.page({ after: p.next });
    expect(now).toEqual({ lines: [], next: t0 + 60_008, gap: false });
    // an empty new run: the old cursor still gets its gap at once (the wait does not hang on it)
    const empty = new LiveFeed(100, undefined, t0 + 120_000);
    expect(empty.page({ after: oldCursor })).toEqual({ lines: [], next: t0 + 120_000, gap: true });
    // the default base is the start time
    const dflt = new LiveFeed(10);
    expect(dflt.seq).toBeGreaterThan(Date.UTC(2026, 0, 1));
    expect(dflt.page({ after: 5 }).gap).toBe(true);
  });

  it('the service numbers from its clock at start (a second service on the same data: the first one\'s cursor gets gap)', async () => {
    const { t, clock } = rig();
    const a = new ModerationService({ dbPath: t.db, timers: false, env: {}, log: () => undefined, now: () => clock.t });
    services.push(a);
    a.hook().logChat(e(1));
    const cursor = a.live.page({}).next;
    expect(cursor).toBe(clock.t + 1);
    a.close();
    clock.t += 5 * MIN;
    const b = new ModerationService({ dbPath: t.db, timers: false, env: {}, log: () => undefined, now: () => clock.t });
    services.push(b);
    b.hook().logChat(e(2));
    const r = await b.livePoll({ after: cursor }, { waitMs: 5000, key: 'panel' });
    expect(r !== 'busy' && r.gap).toBe(true);
    expect(r !== 'busy' && r.lines.map((l) => l.shown)).toEqual(['l2']);
  });
});

// ------------------------------------------------------------------------------------------ addresses from the log

describe('a minimised guest address is never a ban address', () => {
  it('resolveTarget and createBan ignore "tag:" addresses from old log lines', () => {
    const { svc } = rig();
    svc.hook().logChat(entry({ name: 'QuasarKid', accountId: null, playerId: 12, address: 'tag:ab12' }));
    svc.flushAllQuiet();
    const t = svc.resolveTarget('QuasarKid')!;
    expect(t).toMatchObject({ name: 'QuasarKid', accountId: null, address: null });
    expect(svc.createBan({ accountId: 'host', name: 'NovaHost' }, { kind: 'mute', target: t, durationSec: 600, reason: 'test' })).toMatchObject({ ok: false, status: 400 });
    const r = svc.createBan({ accountId: 'host', name: 'NovaHost' }, { kind: 'mute', scope: 'guest', target: t, durationSec: 600, reason: 'test' });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.ok ? '' : r.error).toMatch(/No network address is known/);
    expect(svc.createBan({ accountId: 'host', name: 'NovaHost' }, { kind: 'ban', scope: 'guest', address: 'tag:ab12', durationSec: 600, reason: 'test' })).toMatchObject({ ok: false, status: 400 });
    expect(svc.store.liveBans(Date.now())).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------ report copies

describe('report copies are shown-only (§6.4)', () => {
  it('the saved lines keep what the others saw, never the original, the address or the hit labels', async () => {
    const { svc, zone, t } = rig();
    zone.add({ playerId: 5, name: 'NovaPilot', accountId: 'acc-novapilot', username: 'NovaPilot', address: '10.0.0.5' });
    const reporter = zone.add({ playerId: 6, name: 'VegaPilot', accountId: 'acc-vegapilot', username: 'VegaPilot', address: '10.0.0.6' });
    const h = svc.hook();
    h.logChat(entry({ original: 'the rude words typed', shown: 'GG, pilots!', action: 'block', hits: ['profanity:x'], display: 'substituted' }));
    h.logChat(entry({ original: 'nice one', shown: 'nice one' }));
    expect(await h.report(reporter, 'NovaPilot', 'rude', { roomId: 'r2', roomName: 'Flag Run' })).toEqual(['Report sent — thank you.']);
    const r = svc.store.listReports({ status: 'all' }).reports[0]!;
    expect(r.recentChat.map((l) => [l.original, l.shown, l.address, l.hits.length, l.display])).toEqual([
      ['', 'GG, pilots!', null, 0, 'substituted'], ['', 'nice one', null, 0, 'as-typed'],
    ]);
    const raw = open(t.db);
    try {
      const json = (raw.prepare('SELECT recent_chat_json AS j FROM reports').get() as { j: string }).j;
      expect(json).not.toContain('the rude words typed');
      expect(json).not.toContain('10.0.0.5');
      expect(json).not.toContain('profanity:');
    } finally { raw.close(); }
  });
});

// ------------------------------------------------------------------------------------------ T-ADM-9 retention

/** Local midnight of a date + days. */
const local = (y: number, m: number, d: number, h = 0): number => new Date(y, m - 1, d, h, 0, 0, 0).getTime();

describe('T-ADM-9 retention modes', () => {
  const term = (termEnd: string | null): RetentionPolicy => ({ mode: 'term', days: 90, termEnd, graceDays: 14, recordsDays: 365 });

  it('retentionPlan: nothing before the end date; a banner 7 days before; at end + 14 the term\'s lines; no next date by end + 28 → 90 days', () => {
    const E = local(2026, 12, 19); // the day after the end date 2026-12-18
    expect(retentionPlan(term('2026-12-18'), local(2026, 12, 1))).toMatchObject({ phase: 'term-before', chatBefore: null, banner: null, termCut: E });
    expect(retentionPlan(term('2026-12-18'), local(2026, 12, 12, 9))).toMatchObject({ phase: 'term-ending', chatBefore: null, banner: { code: 'term-ending' } });
    expect(retentionPlan(term('2026-12-18'), local(2026, 12, 20))).toMatchObject({ phase: 'term-grace', chatBefore: null, banner: { code: 'term-ended', level: 'warn' } });
    const purge = retentionPlan(term('2026-12-18'), local(2027, 1, 2, 3));
    expect(purge).toMatchObject({ phase: 'term-purge', chatBefore: E, backupFirst: true, purgeAt: local(2027, 1, 2), fallbackAt: local(2027, 1, 16), banner: { code: 'term-next' } });
    const fb = retentionPlan(term('2026-12-18'), local(2027, 1, 16, 3));
    expect(fb).toMatchObject({ phase: 'term-fallback', chatBefore: E, backupFirst: true, banner: { code: 'term-fallback' } });
    expect(fb.banner!.text).toMatch(/kept 90 days/);
    const late = local(2027, 4, 20, 3);
    expect(retentionPlan(term('2026-12-18'), late).chatBefore).toBe(late - 90 * DAY);
    expect(retentionPlan(term(null), late)).toMatchObject({ phase: 'days', chatBefore: late - 90 * DAY });
    expect(retentionPlan(term('2026-13-45'), late)).toMatchObject({ phase: 'days' });
    expect(retentionPlan({ ...term(null), mode: 'forever' }, late)).toMatchObject({ phase: 'forever', chatBefore: null });
    expect(retentionPlan({ mode: 'days', days: 30, termEnd: null, graceDays: 14, recordsDays: 365 }, late).chatBefore).toBe(late - 30 * DAY);
    expect(nextRetentionAt(local(2026, 9, 28, 1))).toBe(local(2026, 9, 28, 2));
    expect(nextRetentionAt(local(2026, 9, 28, 2))).toBe(local(2026, 9, 29, 2));
  });

  it('the service: no purge before the date; at date + grace a purge after a backup (once); a failed backup waits; the fallback with a banner', async () => {
    const { svc, clock } = rig();
    const calls: [string, Record<string, unknown>][] = [];
    const client: MaintAccess = {
      call: async <R>(op: string, args?: unknown): Promise<R> => {
        calls.push([op, (args ?? {}) as Record<string, unknown>]);
        if (op === 'purge.count') return { rows: 5 } as R;
        if (op === 'retention.chat') return { deleted: 5, reportsUpdated: 0, reportCopies: 0 } as R;
        if (op === 'retention.records') return { actions: 0, reports: 0, bans: 0, conduct: 0, deviceChecks: 0 } as R;
        if (op === 'wellbeing.clear') return { cleared: 0 } as R;
        if (op === 'wellbeing.pending') return { lines: [] } as R;
        return {} as R;
      },
      stream: () => { throw new Error('no streams here'); },
    };
    const backups: string[] = [];
    let backupOk = true;
    const dirty: number[] = [];
    svc.attachMaint({
      client,
      backup: async (reason) => { backups.push(reason); return backupOk ? { ok: true } : { ok: false, error: 'the disk is full' }; },
      indexDirty: () => { dirty.push(1); },
    });
    svc.setPolicy(policyOf({ retention: term('2026-12-18') }));
    const E = local(2026, 12, 19);
    const ops = (): string[] => calls.map(([op]) => op);

    clock.t = local(2026, 12, 10, 3);
    let run = await svc.runRetention();
    expect(run.phase).toBe('term-before');
    expect(ops()).not.toContain('retention.chat');
    expect(ops()).toContain('retention.records');
    expect(svc.retentionInfo()).toMatchObject({ mode: 'term', phase: 'term-before', nextPurgeAt: local(2027, 1, 2) });

    // at end + grace, the backup fails: nothing is deleted, a banner says why
    calls.length = 0;
    backupOk = false;
    clock.t = local(2027, 1, 2, 3);
    run = await svc.runRetention();
    expect(backups).toEqual(['pre-purge']);
    expect(ops()).not.toContain('retention.chat');
    expect(run.skipped).toMatch(/backup/);
    expect(svc.banners().map((b) => b.code)).toEqual(expect.arrayContaining(['term-next', 'term-purge-waiting']));

    // the next night the backup works: the term's lines go (before = the end date)
    calls.length = 0;
    backupOk = true;
    clock.t = local(2027, 1, 3, 3);
    run = await svc.runRetention();
    expect(backups).toEqual(['pre-purge', 'pre-purge']);
    expect(calls.find(([op]) => op === 'retention.chat')![1]).toEqual({ before: E });
    expect(run).toMatchObject({ phase: 'term-purge', chat: 5, where: 'worker' });
    expect(dirty.length).toBeGreaterThan(0);
    expect(svc.banners().map((b) => b.code)).not.toContain('term-purge-waiting');
    // …and never another backup for the same term
    clock.t = local(2027, 1, 4, 3);
    await svc.runRetention();
    expect(backups).toHaveLength(2);

    // no next date by end + 28: the 90-day rule, with a banner
    calls.length = 0;
    clock.t = local(2027, 4, 20, 3);
    run = await svc.runRetention();
    expect(run.phase).toBe('term-fallback');
    expect(calls.find(([op]) => op === 'retention.chat')![1]).toEqual({ before: clock.t - 90 * DAY });
    expect(svc.banners().find((b) => b.code === 'term-fallback')!.text).toMatch(/kept 90 days/);
    expect(svc.nextRetentionRunAt).toBe(local(2027, 4, 21, 2));

    // forever: no chat purge; records still go
    calls.length = 0;
    svc.setPolicy(policyOf({ retention: { ...term(null), mode: 'forever' } }));
    run = await svc.runRetention();
    expect(ops()).not.toContain('retention.chat');
    expect(ops()).toContain('retention.records');
    expect(svc.retentionInfo().nextPurgeAt).toBeNull();
  });

  it('without a worker the game-thread pruner runs in small steps, and a term purge never runs without its backup', async () => {
    const { svc, clock } = rig();
    const h = svc.hook();
    h.logChat(entry({ time: local(2026, 12, 1) }));
    h.logChat(entry({ time: local(2027, 1, 1) }));
    svc.flushAllQuiet();
    svc.setPolicy(policyOf({ retention: term('2026-12-18') }));
    clock.t = local(2027, 1, 3, 3);
    const run = await svc.runRetention();
    expect(run).toMatchObject({ where: 'thread', chat: 0 });
    expect(run.skipped).toMatch(/makes no backups/);
    expect(svc.store.searchLog({}).lines).toHaveLength(2);
    // days mode: the old line goes
    svc.setPolicy(policyOf({ retention: { mode: 'days', days: 30, termEnd: null, graceDays: 14, recordsDays: 365 } }));
    expect(await svc.pruneNow()).toBe(1);
    expect(svc.store.searchLog({}).lines).toHaveLength(1);
  });

  it('termPurgeOwed: the next term\'s date set from the banner window on leaves the ending term\'s purge owed; a correction or a new rule does not', () => {
    const fall = term('2026-12-18');
    const spring = term('2027-05-28');
    const owed = { cut: local(2026, 12, 19), purgeAt: local(2027, 1, 2) };
    expect(termPurgeOwed(fall, spring, local(2026, 12, 12, 9))).toEqual(owed); // term-ending (the banner asks for it)
    expect(termPurgeOwed(fall, spring, local(2026, 12, 20, 9))).toEqual(owed); // term-grace
    expect(termPurgeOwed(fall, spring, local(2027, 1, 2, 9))).toEqual(owed); // term-purge, before the run did it
    expect(termPurgeOwed(fall, term(null), local(2026, 12, 20))).toEqual(owed); // the date cleared
    expect(termPurgeOwed(fall, spring, local(2026, 11, 20))).toBeNull(); // before the window: the host changed this term's date
    expect(termPurgeOwed(fall, term('2026-12-22'), local(2026, 12, 20))).toBeNull(); // a correction within the grace
    expect(termPurgeOwed(fall, term('2026-12-10'), local(2026, 12, 20))).toBeNull(); // an earlier date purges sooner itself
    expect(termPurgeOwed(fall, { ...spring, mode: 'forever' }, local(2026, 12, 20))).toBeNull();
    expect(termPurgeOwed(fall, { ...spring, mode: 'days' }, local(2026, 12, 20))).toBeNull();
    expect(termPurgeOwed(fall, fall, local(2026, 12, 20))).toBeNull();
    expect(termPurgeOwed(null, spring, local(2026, 12, 20))).toBeNull();
  });

  it('the next term\'s date set during the grace (as the banner says): the ending term is still purged at end + 14, after a backup', async () => {
    const { svc, clock } = rig();
    const calls: [string, Record<string, unknown>][] = [];
    let stored: unknown[] = [];
    const client: MaintAccess = {
      call: async <R>(op: string, args?: unknown): Promise<R> => {
        calls.push([op, (args ?? {}) as Record<string, unknown>]);
        if (op === 'purge.count') return { rows: 7 } as R;
        if (op === 'retention.chat') return { deleted: 7, reportsUpdated: 0, reportCopies: 0 } as R;
        if (op === 'retention.records') return { actions: 0, reports: 0, bans: 0, conduct: 0, deviceChecks: 0 } as R;
        if (op === 'wellbeing.clear') return { cleared: 0 } as R;
        if (op === 'wellbeing.pending') return { lines: [] } as R;
        if (op === 'retention.term.get') return { owed: stored } as R;
        if (op === 'retention.term.set') { stored = (args as { owed: unknown[] }).owed; return { owed: stored } as R; }
        return {} as R;
      },
      stream: () => { throw new Error('no streams here'); },
    };
    const backups: string[] = [];
    svc.attachMaint({ client, backup: async (r) => { backups.push(r); return { ok: true }; } });
    svc.setPolicy(policyOf({ retention: term('2026-12-18') }));
    await svc.maintReady();
    const E = local(2026, 12, 19);

    clock.t = local(2026, 12, 20, 9);
    expect(svc.banners().find((b) => b.code === 'term-ended')!.text).toMatch(/set the next term's end date/);
    svc.setPolicy(policyOf({ retention: term('2027-05-28') })); // what the banner asks for
    await svc.maintReady();
    expect(stored).toEqual([{ cut: E, purgeAt: local(2027, 1, 2) }]); // persisted through the worker
    expect(svc.retentionInfo()).toMatchObject({ phase: 'term-before', nextPurgeAt: local(2027, 1, 2), owed: [{ cut: E }] });
    // the ended term's grace banner stays (without asking for the date again)
    const b = svc.banners().find((x) => x.code === 'term-ended')!;
    expect(b.text).toMatch(/The term ended on Dec 18, 2026\. Its chat is deleted on Jan 2, 2027/);
    expect(b.text).not.toMatch(/set the next/);

    // before the purge day: nothing
    clock.t = local(2027, 1, 1, 3);
    await svc.runRetention();
    expect(calls.map(([op]) => op)).not.toContain('retention.chat');
    // Jan 2: the backup, then the fall term's lines (before = the day after its end date)
    calls.length = 0;
    clock.t = local(2027, 1, 2, 3);
    const run = await svc.runRetention();
    expect(backups).toEqual(['pre-purge']);
    expect(calls.find(([op]) => op === 'retention.chat')![1]).toEqual({ before: E });
    expect(run).toMatchObject({ chat: 7, phase: 'term-before' });
    await svc.maintReady();
    expect(stored).toEqual([]); // settled
    expect(svc.retentionInfo().owed).toEqual([]);
    expect(svc.banners().map((x) => x.code)).not.toContain('term-ended');
    calls.length = 0;
    clock.t = local(2027, 1, 3, 3);
    await svc.runRetention();
    expect(calls.map(([op]) => op)).not.toContain('retention.chat'); // once
    expect(backups).toHaveLength(1);
  });

  it('an owed term purge waits for its backup; switching to days or forever drops it; a restart reloads it', async () => {
    const { svc, clock, t } = rig();
    let stored: unknown[] = [];
    const ops: string[] = [];
    const client: MaintAccess = {
      call: async <R>(op: string, args?: unknown): Promise<R> => {
        ops.push(op);
        if (op === 'purge.count') return { rows: 3 } as R;
        if (op === 'retention.chat') return { deleted: 3, reportsUpdated: 0, reportCopies: 0 } as R;
        if (op === 'retention.records') return { actions: 0, reports: 0, bans: 0, conduct: 0, deviceChecks: 0 } as R;
        if (op === 'wellbeing.clear') return { cleared: 0 } as R;
        if (op === 'wellbeing.pending') return { lines: [] } as R;
        if (op === 'retention.term.get') return { owed: stored } as R;
        if (op === 'retention.term.set') { stored = (args as { owed: unknown[] }).owed; return { owed: stored } as R; }
        return {} as R;
      },
      stream: () => { throw new Error('no streams here'); },
    };
    let backupOk = false;
    svc.attachMaint({ client, backup: async () => (backupOk ? { ok: true } : { ok: false, error: 'the disk is full' }) });
    svc.setPolicy(policyOf({ retention: term('2026-12-18') }));
    clock.t = local(2026, 12, 15, 9);
    svc.setPolicy(policyOf({ retention: term('2027-05-28') }));
    await svc.maintReady();
    expect(stored).toHaveLength(1);
    clock.t = local(2027, 1, 2, 3);
    let run = await svc.runRetention();
    expect(run.skipped).toMatch(/backup/);
    expect(ops).not.toContain('retention.chat');
    expect(svc.banners().map((b) => b.code)).toContain('term-purge-waiting');
    expect(svc.retentionInfo().owed).toHaveLength(1); // still owed

    // a restart: the new service reads it back
    const again = new ModerationService({ dbPath: t.db, timers: false, env: {}, log: () => undefined, now: () => clock.t, liveSeqBase: 0 });
    services.push(again);
    again.setPolicy(policyOf({ retention: term('2027-05-28') }));
    again.attachMaint({ client, backup: async () => ({ ok: true }) });
    await again.maintReady();
    expect(again.retentionInfo().owed).toEqual([{ cut: local(2026, 12, 19), purgeAt: local(2027, 1, 2) }]);
    backupOk = true;
    ops.length = 0;
    clock.t = local(2027, 1, 3, 3);
    run = await again.runRetention();
    expect(run.chat).toBe(3);
    expect(ops).toContain('retention.chat');

    // days (or forever) is the host's new rule: an owed purge is dropped
    stored = [{ cut: local(2026, 12, 19), purgeAt: local(2027, 1, 2) }];
    const third = new ModerationService({ dbPath: t.db, timers: false, env: {}, log: () => undefined, now: () => clock.t, liveSeqBase: 0 });
    services.push(third);
    third.setPolicy(policyOf({ retention: term('2027-05-28') }));
    third.attachMaint({ client });
    await third.maintReady();
    expect(third.retentionInfo().owed).toHaveLength(1);
    third.setPolicy(policyOf({ retention: { ...term(null), mode: 'forever' } }));
    await third.maintReady();
    expect(stored).toEqual([]);
    expect(third.retentionInfo().owed).toEqual([]);
  });

  it('a retention change runs within a minute (a one-shot), not at the next 10-minute look', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'Date'] });
    const t = tmpData('vs-modlan-soon-');
    temps.push(t);
    const svc = new ModerationService({ dbPath: t.db, env: {}, log: () => undefined, liveSeqBase: 0 });
    services.push(svc);
    const run = vi.spyOn(svc, 'runRetention').mockResolvedValue({ at: 0, phase: 'days', where: 'thread', chat: 0, records: 0, addresses: 0, wellbeing: 0, skipped: null });
    vi.advanceTimersByTime(61_000);
    expect(run).toHaveBeenCalledTimes(1); // a minute after the start
    run.mockClear();
    vi.advanceTimersByTime(5 * MIN);
    svc.setPolicy(policyOf({ retention: { mode: 'days', days: 30, termEnd: null, graceDays: 14, recordsDays: 365 } }));
    vi.advanceTimersByTime(59_000);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(run).toHaveBeenCalledTimes(1);
    svc.close();
  });

  it('purgeBeforeOf reads a date as the start of that local day', () => {
    expect(purgeBeforeOf('2026-09-01')).toBe(local(2026, 9, 1));
    expect(purgeBeforeOf(123)).toBe(123);
    expect(() => purgeBeforeOf('yesterday')).toThrow(/before/);
  });
});
