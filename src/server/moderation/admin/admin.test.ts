// OWNER: ADMIN UI (B9). Tests for the Host Control Panel (docs/LAN-EDITION-proposal.md §5.2-§5.6, §11.7):
//  - the pure helpers and the API client (node, no DOM);
//  - T-UI-1 (every ENDPOINTS entry is a real route and documented), T-UI-2 (no inline script, CSP-safe files);
//  - T-UI-6 (the default Live and Chat-log DOM holds no original of a blocked line; Presenting hides names; a reveal
//    is one audited call) and T-UI-7 (the reauth dialog on a 401 `reauth`, then the call is retried), by booting the
//    real admin.html + admin.js on a small fake DOM (dom.testutil.ts) with a routed fake fetch;
//  - the v0.4 moderator API fallback (legacy `npm start`), first-run setup from the URL fragment;
//  - no QR code anywhere (owner decision 7): the join address is text only.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPanelState } from '../../../lan/display/state';
import { AuthStore } from '../../auth/store';
import { startAdminListener } from '../../listeners';
import { capabilitiesOf } from '../capabilities';
import { DEFAULT_ADMIN_POLICY, HostAdmin, formatSetupCode, newSetupCode, type AdminPolicy } from '../hostAdmin';
import { ADMIN_PAGE_DIR, ADMIN_ROUTES, createAdminHttp, createAdminSite, type AdminRouteHandler } from '../http';
import {
  ApiError, BACKGROUND_ENDPOINTS, BUILTIN_TAGS, CHAT_ACTIONS, CLOCK_TICK_MS, DEFAULT_DURATION, DURATION_PRESETS, ENDPOINTS, HOME_REFRESH_MS,
  LEGACY_CAPS, ME_REFRESH_MS, MODE_KEY, ONLINE_REFRESH_MS, PREFS_KEY, PRESENT_NAME, QUICK_MUTES, REPORTS_POLL_MS, SESSIONLESS, TABS, TOKEN_KEY,
  WELLBEING_TEXT, LOST_ANSWER_RETRY, LOST_ANSWER_TRIES, homeAlertParts, isLostAnswer, openReportsOf, presentingRoomLabel, presentingWellbeingRow,
  actionDurationText, actionTargetText, announceBody, attributionText, auditMatches, banCreateBody, banTargetText, boot, buildLogQuery,
  chatActionInfo, chatRowClass, checkReason, cleanText, createApi, createPrefs, createTokenStore, currentPeriod, defaultTab,
  durationChoices, errorText, exportBody, fileNameOf, formatBytes, formatCount, formatDateTime, formatExpiry, formatShortTime, formatSpan,
  isDashboardRead, isReauth, isWellbeingRow, latestOnly, liveRequestBody, makeH, manualBanBody, mergeLive, nextTabIndex, normalizeSetupCode,
  pagerCursor, pagerInit, pagerLabel, pagerLoaded, pagerNewer, pagerOlder, parseLocalDate, parseLocalDateTime, periodRanges, presentingAtStart,
  principalText, renderLiveLine, renderLogRow, retentionPatch, retentionText, roomSpanText, rowTags, scopeChoices, sessionClock, setupBody,
  DOMAINS_MAX, domainListOf, BANNER_ACTIONS, DISMISSED_KEY, bannerAction,
  setupCodeFromHash, shownView, statsText, tagClass, toSubject, visibleTabs, whereLabel,
} from './admin.js';
import {
  FakeElement, FakeEvent, fakeFetch, fakeWindow, pageText, parseHtml, settle, type FakeDocument, type FetchCall, type Route,
} from './dom.testutil';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string): string => readFileSync(path.join(here, f), 'utf8');
const repo = path.resolve(here, '..', '..', '..', '..');

// A string that stands for what a student typed: it must never reach the DOM until Reveal.
const SECRET = 'ORIGINAL-typed-text-7f3a';
const PASS = 'generated-Test-pass-91xq'; // generated test password (never a real credential)

// ---------------------------------------------------------------------------------------------------------- fetch mock
interface Call { url: string; init: { method: string; headers: Record<string, string>; body: string } }
function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: Call['init']) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers[k] ?? headers[k.toLowerCase()] ?? null },
      json: async () => {
        if (body === undefined) throw new SyntaxError('no json');
        return body;
      },
      blob: async () => 'blob-data',
    };
  });
  return { fn, calls };
}
/** A fetch that answers each call from the list in turn (then repeats the last). */
function seqFetch(replies: { status: number; body: unknown; headers?: Record<string, string> }[]) {
  const calls: Call[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: Call['init']) => {
    calls.push({ url, init });
    const r = replies[Math.min(i++, replies.length - 1)]!;
    return {
      ok: r.status >= 200 && r.status < 300, status: r.status,
      headers: { get: (k: string) => r.headers?.[k] ?? r.headers?.[k.toLowerCase()] ?? null },
      json: async () => r.body,
    };
  });
  return { fn, calls };
}

// ====================================================================================================================
// Pure helpers
// ====================================================================================================================

describe('durations', () => {
  it('offers the classroom presets, with safe defaults; a mute without `ban` is at most a day', () => {
    expect(DURATION_PRESETS.map((p) => p.id)).toEqual(['10m', '1h', '1d', '7d', 'perm']);
    expect(DEFAULT_DURATION).toEqual({ ban: '1d', mute: '10m' });
    expect(QUICK_MUTES).toEqual(['10m', '1h', '1d']);
    expect(durationChoices('mute', ['moderate'])).toEqual(['10m', '1h', '1d']);
    expect(durationChoices('mute', ['moderate', 'ban'])).toEqual(['10m', '1h', '1d', '7d', 'perm']);
  });
});

describe('formatting', () => {
  it('formatSpan uses at most two units', () => {
    expect(formatSpan(0)).toBe('0s');
    expect(formatSpan(45_000)).toBe('45s');
    expect(formatSpan(12 * 60_000)).toBe('12m');
    expect(formatSpan(3 * 3600_000 + 5 * 60_000)).toBe('3h 5m');
    expect(formatSpan(2 * 86400_000 + 4 * 3600_000 + 59 * 60_000)).toBe('2d 4h');
    expect(formatSpan(-1)).toBe('—');
  });

  it('formatExpiry, formatDateTime, formatShortTime', () => {
    const now = 1_700_000_000_000;
    expect(formatExpiry(null, now)).toBe('Permanent');
    expect(formatExpiry(now - 1, now)).toBe('Ended');
    expect(formatExpiry(now + 90 * 60_000, now)).toBe('in 1h 30m');
    const t = new Date(2026, 8, 27, 9, 5, 7).getTime();
    expect(formatDateTime(t)).toBe('2026-09-27 09:05:07');
    expect(formatShortTime(t, new Date(2026, 8, 27, 23, 0, 0).getTime())).toBe('09:05:07');
    expect(formatShortTime(t, new Date(2026, 10, 1).getTime())).toBe('09-27 09:05');
    expect(formatDateTime('2026')).toBe('—');
  });

  it('counts, bytes and the room span', () => {
    expect(formatCount(812331)).toBe('812,331');
    expect(formatBytes(372 * 1024 * 1024)).toBe('372 MB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    const a = new Date(2026, 8, 28, 10, 2).getTime();
    const b = new Date(2026, 8, 28, 10, 51).getTime();
    expect(roomSpanText(a, b, new Date(2026, 8, 29).getTime())).toBe('Sep 28, 10:02–10:51');
  });

  it('parses datetime-local and date inputs, rejecting impossible dates', () => {
    expect(parseLocalDateTime('2026-09-27T14:30')).toBe(new Date(2026, 8, 27, 14, 30, 0).getTime());
    expect(parseLocalDateTime('2026-02-31T10:00')).toBeNull();
    expect(parseLocalDate('2026-09-27')).toBe(new Date(2026, 8, 27).getTime());
    expect(parseLocalDate('2026-09-27', 1)).toBe(new Date(2026, 8, 28).getTime());
    expect(parseLocalDate('2026-13-01')).toBeNull();
  });

  it('cleanText trims, strips control characters and caps length', () => {
    expect(cleanText('  hi\u0000there\n ', 50)).toBe('hi there');
    expect(cleanText(42, 10)).toBe('');
  });
});

describe('chat rows: actions, display, tags, attribution', () => {
  it('knows every contract action; blocked / flood / muted are "not shown"', () => {
    expect(Object.keys(CHAT_ACTIONS).sort()).toEqual(['block', 'flag', 'mask', 'muted', 'pass', 'spam']);
    expect(chatActionInfo('flag')).toMatchObject({ id: 'flag', label: 'For review', hidden: false });
    expect(chatActionInfo('block').hidden).toBe(true);
    expect(chatActionInfo('toString').id).toBe('unknown');
    expect(chatRowClass('block')).toBe('row-block');
    expect(chatRowClass('pass')).toBe('');
  });

  it('a substituted line is labelled, never presented as the student\'s words (§5.8)', () => {
    const row = { action: 'block', display: 'substituted', shown: 'GG, pilots!' };
    expect(shownView(row)).toMatchObject({ kind: 'substituted', text: 'GG, pilots!' });
    expect(attributionText(row)).toBe('Others saw: “GG, pilots!” (substituted)');
    expect(shownView({ action: 'block', display: 'system', shown: 'x' }).note).toMatch(/system line/);
    expect(shownView({ action: 'block', display: 'hidden', shown: '' }).kind).toBe('hidden');
    expect(shownView({ action: 'block', shown: '' }).kind).toBe('hidden'); // a row from before 0.6
    expect(shownView({ action: 'pass', display: 'as-typed', shown: 'hi' })).toEqual({ kind: 'text', text: 'hi', note: '' });
    expect(shownView({ display: 'withheld' }).kind).toBe('withheld');
  });

  it('tags come from `tags`, else from hit labels by category — never the terms', () => {
    expect(rowTags({ tags: ['HATE', 'threat'] })).toEqual(['HATE', 'THREAT']);
    const derived = rowTags({ hits: ['profanity:x', 'custom:gang:y', 'flag:bullying:z', 'sexual:w', 'selfharm:v'] });
    expect(derived).toEqual(['PROFANITY', 'GANG', 'BULLYING', 'VULGAR', 'SELF-HARM']);
    expect(derived.join(' ')).not.toMatch(/\b[xyzwv]\b/);
    expect(tagClass('SELF-HARM')).toBe('tag-wellbeing');
    expect(tagClass('BULLYING')).toBe('tag-custom');
    expect(BUILTIN_TAGS).toContain('GANG');
    expect(isWellbeingRow({ tags: ['SELF-HARM'] })).toBe(true);
    expect(isWellbeingRow({ display: 'withheld' })).toBe(true);
    expect(isWellbeingRow({ wellbeing: true })).toBe(true);
    expect(isWellbeingRow({ tags: ['HATE'] })).toBe(false);
  });

  it('where a line was said', () => {
    expect(whereLabel({ label: 'Flag Run · Crimson (team chat)' })).toBe('Flag Run · Crimson (team chat)');
    expect(whereLabel({ roomId: 'r2', roomName: 'Flag Run', channel: 'team', team: 0 })).toBe('Flag Run · Crimson (team chat)');
    expect(whereLabel({ roomId: null, roomUid: 'b:zone', channel: 'all' })).toBe('Zone lobby');
    expect(whereLabel({ roomId: null, roomUid: null, channel: 'announce' })).toBe('All rooms (announcement)');
    expect(whereLabel({ roomId: 'r1', roomName: 'Duel Pit', channel: 'name' })).toBe('Duel Pit (callsign)');
  });
});

describe('capability-driven tabs', () => {
  it('a limited moderator sees Live, Rooms and Reports only (T-UI-3 shape)', () => {
    expect(visibleTabs(capabilitiesOf({ kind: 'moderator', tier: 'limited' }))).toEqual(['live', 'rooms', 'reports']);
  });
  it('the host on the host PC sees all 12 tabs; a remote limited host no private ones', () => {
    expect(visibleTabs(capabilitiesOf({ kind: 'host', via: 'local' }))).toEqual(TABS.map((t) => t.id));
    const limited = visibleTabs(capabilitiesOf({ kind: 'host', via: 'limited' }));
    for (const t of ['conduct', 'accounts', 'terms', 'settings', 'audit']) expect(limited).not.toContain(t);
    expect(limited).toEqual(expect.arrayContaining(['home', 'live', 'chat', 'rooms', 'reports', 'bans', 'server']));
  });
  it('the v0.4 moderator API gets its old tools; Home first, else Live, else Rooms', () => {
    expect(visibleTabs(LEGACY_CAPS)).toEqual(['chat', 'rooms', 'reports', 'bans', 'audit']);
    expect(defaultTab(visibleTabs(LEGACY_CAPS))).toBe('rooms');
    expect(defaultTab(['live', 'rooms'])).toBe('live');
    expect(defaultTab(['home', 'live'])).toBe('home');
    expect(principalText({ kind: 'host', via: 'local' })).toBe('Host · this PC');
    expect(principalText({ kind: 'moderator', tier: 'limited' })).toBe('Moderator (limited)');
  });
});

describe('class periods', () => {
  const periods = [{ name: 'P1', start: '08:00', end: '08:50', days: [1, 2, 3, 4, 5] }, { name: 'P2', start: '09:00', end: '09:50', days: [1, 2, 3, 4, 5] }];
  const tue = (h: number, m: number): number => new Date(2026, 8, 29, h, m).getTime(); // a Tuesday

  it('"this class period" is the one running now, else the latest today', () => {
    expect(currentPeriod(periods, tue(8, 30))?.period.name).toBe('P1');
    expect(currentPeriod(periods, tue(9, 55))?.period.name).toBe('P2');
    expect(currentPeriod(periods, tue(7, 0))).toBeNull();
    expect(currentPeriod(periods, new Date(2026, 8, 27, 9, 0).getTime())).toBeNull(); // Sunday
  });

  it('a named period becomes one range per school day in the date range', () => {
    const r = periodRanges(periods[1], new Date(2026, 8, 21).getTime(), new Date(2026, 8, 27, 23, 59).getTime());
    expect(r).toHaveLength(5);
    expect(r[0]).toEqual({ since: new Date(2026, 8, 21, 9, 0).getTime(), until: new Date(2026, 8, 21, 9, 50).getTime() + 59_999 });
  });
});

describe('buildLogQuery', () => {
  const now = new Date(2026, 8, 29, 10, 0).getTime();
  it('sends only the set fields, `q` for text, the room uid and the cursor', () => {
    const r = buildLogQuery({ player: ' Bob ', q: 'hello', room: 'uid:abc:r2', tag: 'hate', channel: 'team' }, { now, cursor: { before: 900, beforeTs: 55 } });
    expect(r.query).toEqual({ player: 'Bob', q: 'hello', roomUid: 'abc:r2', tag: 'HATE', channel: 'team', limit: 100, before: 900, beforeTs: 55 });
  });
  it('maps "What happened" to action / display (§5.5)', () => {
    expect(buildLogQuery({ action: 'substituted' }, { now }).query).toMatchObject({ display: ['substituted', 'system'] });
    expect(buildLogQuery({ action: 'shown' }, { now }).query).toMatchObject({ display: 'as-typed' });
    expect(buildLogQuery({ action: 'block' }, { now }).query).toMatchObject({ action: 'block' });
    expect(buildLogQuery({ action: 'drop table' }, { now }).error).toBeTruthy();
  });
  it('date presets: today, last 60 minutes, 7 days, custom, jump to date, class periods', () => {
    expect(buildLogQuery({ range: 'today' }, { now }).query?.since).toBe(new Date(2026, 8, 29).getTime());
    expect(buildLogQuery({ range: '60m' }, { now }).query?.since).toBe(now - 3_600_000);
    expect(buildLogQuery({ range: '7d' }, { now }).query?.since).toBe(now - 7 * 86_400_000);
    expect(buildLogQuery({ range: 'custom', from: '2026-09-27T10:00', to: '2026-09-27T09:00' }, { now }).error).toMatch(/before/);
    expect(buildLogQuery({ jump: '2026-09-20' }, { now }).query?.until).toBe(new Date(2026, 8, 21).getTime() - 1);
    const periods = [{ name: 'P1', start: '08:00', end: '08:50', days: [2] }];
    expect(buildLogQuery({ range: 'period' }, { now, periods }).query).toMatchObject({ since: new Date(2026, 8, 29, 8, 0).getTime() });
    expect(buildLogQuery({ range: 'period' }, { now, periods: [] }).error).toMatch(/class period/);
    const named = buildLogQuery({ range: '7d', period: 'P1' }, { now, periods });
    expect(named.query?.ranges).toHaveLength(1);
    expect(buildLogQuery({ range: 'forever' }, { now }).error).toBeTruthy();
  });
  it('the v0.4 API: `grep` and roomId, no display / tag / channel', () => {
    const r = buildLogQuery({ q: 'hi', room: 'id:r7', action: 'shown', tag: 'HATE', channel: 'team' }, { now, legacy: true });
    expect(r.query).toEqual({ grep: 'hi', roomId: 'r7', action: 'pass', limit: 100 });
  });
  it('caps text lengths and the page size', () => {
    const long = buildLogQuery({ q: 'x'.repeat(500), player: 'y'.repeat(500) }, { now });
    expect(String(long.query?.q).length).toBe(200);
    expect(String(long.query?.player).length).toBe(64);
    expect(buildLogQuery({}, { now, limit: 99999 }).query?.limit).toBe(1000);
  });
});

describe('checkReason, pager, latestOnly, tab keys', () => {
  it('checkReason', () => {
    expect(checkReason('  ').error).toMatch(/required/);
    expect(checkReason('x'.repeat(201)).error).toMatch(/200/);
    expect(checkReason('', { required: false }).value).toBe('');
  });
  it('pager with (before, beforeTs) cursors', () => {
    let p = pagerInit();
    expect(pagerCursor(p)).toBeNull();
    p = pagerLoaded(p, 900, 123);
    expect(pagerLabel(p, 100)).toBe('Page 1 · 100 rows');
    p = pagerOlder(p);
    expect(pagerCursor(p)).toEqual({ before: 900, beforeTs: 123 });
    p = pagerLoaded(p, null);
    expect(pagerLabel(p, 3)).toBe('Page 2 · 3 rows · end of list');
    expect(pagerOlder(p)).toBe(p);
    p = pagerNewer(p);
    expect(pagerCursor(p)).toBeNull();
    expect(pagerLoaded(pagerInit(), 5).next).toBe(5);
  });
  it('latestOnly / nextTabIndex', () => {
    const start = latestOnly();
    const a = start();
    const b = start();
    expect(a()).toBe(false);
    expect(b()).toBe(true);
    expect(nextTabIndex(4, 'ArrowRight', 5)).toBe(0);
    expect(nextTabIndex(0, 'ArrowLeft', 5)).toBe(4);
    expect(nextTabIndex(2, 'End', 5)).toBe(4);
  });
});

describe('live helpers', () => {
  it('liveRequestBody: the cursor and wait only with `after`, filters cleaned', () => {
    expect(liveRequestBody({}, null)).toEqual({ limit: 500 });
    expect(liveRequestBody({ roomUid: 'b:r2', tag: 'hate', flaggedOnly: true, channel: 'bogus', player: ' Nova ' }, 42, 25))
      .toEqual({ limit: 500, after: 42, wait: 25, roomUid: 'b:r2', tag: 'HATE', flaggedOnly: true, player: 'Nova' });
  });
  it('mergeLive: newest first, deduped by seq, a later copy wins (its chat id may be known now)', () => {
    const out = mergeLive([{ seq: 1, chatId: null }, { seq: 2, chatId: null }], [{ seq: 2, chatId: 9 }, { seq: 3, chatId: 10 }], 2);
    expect(out).toEqual([{ seq: 3, chatId: 10 }, { seq: 2, chatId: 9 }]);
  });
});

describe('setup, export, announce, retention, session', () => {
  it('the setup code comes from the URL fragment, normalized', () => {
    expect(setupCodeFromHash('#setup=k7qp4mxd')).toBe('K7QP-4MXD');
    expect(setupCodeFromHash('#tab=home&setup=K7QP-4MXD')).toBe('K7QP-4MXD');
    expect(setupCodeFromHash('#nothing')).toBe('');
    expect(normalizeSetupCode(' k7qp 4mxd ')).toBe('K7QP-4MXD');
  });
  it('setupBody checks the fields the server checks first', () => {
    const f = { setupCode: 'k7qp4mxd', username: 'hostadmin', password: PASS, password2: PASS, preset: 'school', serverName: 'Room 136', accountsMode: 'roster' };
    expect(setupBody(f).body).toEqual({ setupCode: 'K7QP-4MXD', username: 'hostadmin', password: PASS, preset: 'school', serverName: 'Room 136', accountsMode: 'roster' });
    expect(setupBody({ ...f, password2: 'other-password-x' }).field).toBe('password2');
    expect(setupBody({ ...f, password: 'short', password2: 'short' }).field).toBe('password');
    expect(setupBody({ ...f, preset: '' }).field).toBe('preset');
    expect(setupBody({ ...f, preset: '' }, false).body).toEqual({ setupCode: 'K7QP-4MXD', username: 'hostadmin', password: PASS });
    expect(setupBody({ ...f, preset: 'home' }).body?.accountsMode).toBe('email');
    // School's optional Allowed email domains (owner decision 6); Home never sends them (Settings → Accounts later).
    expect(setupBody({ ...f, domains: ' @Caldwellschools.org, *.example.net ' }).body?.domains)
      .toEqual([{ domain: 'caldwellschools.org', subdomains: false }, { domain: 'example.net', subdomains: true }]);
    expect(setupBody({ ...f, domains: '' }).body).not.toHaveProperty('domains');
    expect(setupBody({ ...f, preset: 'home', domains: 'caldwellschools.org' }).body).not.toHaveProperty('domains');
    expect(setupBody({ ...f, domains: 'nova@caldwellschools.org' }).field).toBe('domains');
  });
  it('domainListOf: the setup domain field → [{ domain, subdomains }] (the server does the real checks)', () => {
    expect(domainListOf('')).toEqual({ domains: [] });
    expect(domainListOf('caldwellschools.org\n*.caldwellschools.org; example.org.', false).domains)
      .toEqual([{ domain: 'caldwellschools.org', subdomains: true }, { domain: 'example.org', subdomains: false }]);
    expect(domainListOf('example.org', true).domains).toEqual([{ domain: 'example.org', subdomains: true }]);
    for (const bad of ['https://example.org', 'example.org/x', 'a*b.org', 'org', '.example.org', 'ex..org', 'a\\b.org']) {
      expect(domainListOf(bad).error, bad).toMatch(/is not a domain/);
    }
    expect(domainListOf(Array.from({ length: DOMAINS_MAX + 1 }, (_, i) => `d${i}.example.org`).join(',')).error).toMatch(/at most/);
  });
  it('exportBody: the current filter, a date range or everything, plus the ★ ticks', () => {
    const filter = { player: 'Nova', q: 'x', roomUid: 'b:r1', ranges: [{ since: 1, until: 2 }] };
    expect(exportBody(filter, { format: 'csv' }).body).toEqual({ format: 'csv', ...filter });
    expect(exportBody(filter, { scope: 'all', format: 'json', includeOriginal: true, includeWellbeing: true, saveOnHost: true }).body)
      .toEqual({ format: 'json', all: true, includeOriginal: true, includeWellbeing: true, saveOnHost: true });
    const r = exportBody(filter, { scope: 'range', from: '2026-09-01', to: '2026-09-02' }).body!;
    expect(r).toEqual({ format: 'csv', since: new Date(2026, 8, 1).getTime(), until: new Date(2026, 8, 3).getTime() - 1 });
    expect(exportBody(filter, { scope: 'range', from: '2026-09-03', to: '2026-09-02' }).error).toBeTruthy();
  });
  it('announceBody', () => {
    expect(announceBody(' Finish your match ', '')).toEqual({ body: { text: 'Finish your match' } });
    expect(announceBody('Hi', 'r3').body).toEqual({ text: 'Hi', roomId: 'r3' });
    expect(announceBody('  ', '').error).toBeTruthy();
    expect(announceBody('x'.repeat(201), '').error).toMatch(/200/);
  });
  it('retention text, stats header and the settings patch', () => {
    const now = new Date(2026, 8, 29, 12, 0).getTime();
    const tonight = new Date(2026, 8, 30, 2, 0).getTime();
    expect(retentionText({ mode: 'days', days: 90, nextPurgeAt: tonight }, now)).toBe('retention 90 days · next purge tonight');
    expect(retentionText({ mode: 'forever' }, now)).toBe('kept until you delete it');
    expect(statsText({ rows: 812331, oldest: new Date(2026, 7, 25).getTime(), dbBytes: 372 * 1024 * 1024, walBytes: 0, retention: { mode: 'days', days: 90 }, nextPurgeAt: tonight }, now))
      .toBe('the log holds 812,331 lines since Aug 25 · 372 MB · retention 90 days · next purge tonight');
    expect(retentionPatch({ mode: 'days', days: '30' }).patch).toEqual({ chat: { retention: { mode: 'days', days: 30 } } });
    expect(retentionPatch({ mode: 'term', termEnd: '2026-12-18' }).patch).toEqual({ chat: { retention: { mode: 'term', termEnd: '2026-12-18' } } });
    expect(retentionPatch({ mode: 'forever' }, true).error).toMatch(/district/);
    expect(retentionPatch({ mode: 'days', days: 0 }).error).toBeTruthy();
  });
  it('sessionClock and Presenting at start', () => {
    const now = 1_000_000;
    expect(sessionClock({ expiresAt: now + 60_000, freshUntil: now + 1000 }, now)).toEqual({ idleLeftMs: 60_000, freshLeftMs: 1000, fresh: true });
    expect(sessionClock({ expiresAt: now + 60_000, freshUntil: 0 }, now).fresh).toBe(false);
    expect(presentingAtStart({ remembered: null, atLogin: true, freshLogin: true })).toBe(true);
    expect(presentingAtStart({ remembered: false, atLogin: true, freshLogin: true })).toBe(true); // School: on at every sign-in
    expect(presentingAtStart({ remembered: true, atLogin: false, freshLogin: false })).toBe(true);
    expect(presentingAtStart({ remembered: null, atLogin: undefined, freshLogin: false })).toBe(false);
  });
});

describe('ban / action rows in words', () => {
  it('banTargetText covers every scope (address tags for moderators)', () => {
    expect(banTargetText({ scope: 'account', username: 'bob' })).toBe('bob');
    expect(banTargetText({ scope: 'address', address: '10.0.0.5' })).toBe('everyone on 10.0.0.5');
    expect(banTargetText({ scope: 'guest', addressTag: '3f9a', username: 'Pilot7' })).toBe('guest "Pilot7" on address 3f9a');
    expect(banTargetText(null)).toBe('?');
  });
  it('actionTargetText / actionDurationText / isDashboardRead / auditMatches', () => {
    expect(actionTargetText({ targetName: 'bob', targetAddress: '1.2.3.4' })).toBe('bob @ 1.2.3.4');
    expect(actionTargetText({ targetAccountId: 'abcdef1234567' })).toBe('account abcdef12');
    expect(actionDurationText({ action: 'ban', durationSec: 3600, expiresAt: 1 })).toBe('1h');
    expect(isDashboardRead({ action: 'note', reason: 'api log player=Bob' })).toBe(true);
    expect(auditMatches({ actor: 'HostAdmin', action: 'reveal' }, { actor: 'host', kind: 'reveal' })).toBe(true);
    expect(auditMatches({ actor: 'HostAdmin', action: 'reveal' }, { kind: 'ban' })).toBe(false);
  });
});

describe('sanction targeting (bans/create bodies)', () => {
  const account = toSubject({ name: 'Ace', playerId: 4, accountId: 'acc-1', username: 'ace', address: '10.0.0.9' }, true);
  const guest = toSubject({ name: 'Pilot7', playerId: 9, accountId: null, address: '10.0.0.9' }, true);
  const guestTagOnly = toSubject({ name: 'Ghost', playerId: 2 }, true);

  it('accounts are sanctioned by account id only', () => {
    expect(scopeChoices('ban', account).map((c) => c.value)).toEqual(['account']);
    expect(banCreateBody({ kind: 'ban', subject: account, scope: 'account', duration: '1d', reason: 'slurs' }).body)
      .toEqual({ kind: 'ban', duration: '1d', reason: 'slurs', accountId: 'acc-1', scope: 'account' });
  });
  it('a guest mute targets the connected pilot; a guest ban needs a network scope', () => {
    expect(scopeChoices('mute', guest).map((c) => c.value)).toEqual(['guest-name', 'guest', 'address']);
    expect(banCreateBody({ kind: 'mute', subject: guest, scope: 'guest-name', duration: '10m', reason: 'spam' }).body)
      .toEqual({ kind: 'mute', duration: '10m', reason: 'spam', playerId: 9, address: '10.0.0.9', scope: 'guest' });
    expect(banCreateBody({ kind: 'ban', subject: guest, scope: 'guest-name', duration: '1d', reason: 'x' }).error).toBeTruthy();
  });
  it('without the address (a moderator sees a tag) a guest can still be muted by callsign', () => {
    expect(scopeChoices('mute', guestTagOnly).map((c) => c.value)).toEqual(['guest-name']);
    expect(scopeChoices('ban', guestTagOnly)).toEqual([]);
  });
  it('manual form', () => {
    expect(manualBanBody({ kind: 'mute', scope: 'target', target: ' bob ', duration: '1h', reason: 'caps' }).body)
      .toEqual({ kind: 'mute', duration: '1h', reason: 'caps', target: 'bob' });
    expect(manualBanBody({ kind: 'ban', scope: 'everyone', target: 'a', duration: '1d', reason: 'x' }).error).toBeTruthy();
  });
});

// ====================================================================================================================
// API client
// ====================================================================================================================

describe('createApi', () => {
  it('POSTs JSON with a Bearer token and never puts the token in the URL', async () => {
    const { fn, calls } = mockFetch(200, { ok: true, players: [] });
    const api = createApi({ fetchImpl: fn, getToken: () => 'tok1234567890abcdef' });
    expect(await api.admin('online', {})).toEqual({ ok: true, players: [] });
    expect(calls[0]!.url).toBe('/api/admin/online');
    expect(calls[0]!.url).not.toContain('tok1234567890abcdef');
    expect(calls[0]!.init.headers.Authorization).toBe('Bearer tok1234567890abcdef');
    expect(calls[0]!.init.headers['Content-Type']).toBe('application/json');
  });

  it('login: the host admin API first; the v0.4 accounts API only on a 404', async () => {
    const lan = mockFetch(200, { ok: true, token: 't-lan', session: { username: 'hostadmin' } });
    const r = await createApi({ fetchImpl: lan.fn, getToken: () => null }).login('host', 'hostadmin', PASS);
    expect(r).toEqual({ token: 't-lan', session: { username: 'hostadmin' }, legacy: false });
    expect(lan.calls.map((c) => c.url)).toEqual(['/api/admin/login']);
    expect(JSON.parse(lan.calls[0]!.init.body)).toEqual({ role: 'host', username: 'hostadmin', password: PASS });
    expect('Authorization' in lan.calls[0]!.init.headers).toBe(false);

    const old = seqFetch([{ status: 404, body: { error: 'Not found' } }, { status: 200, body: { token: 't-old', account: {} } }]);
    const r2 = await createApi({ fetchImpl: old.fn, getToken: () => null }).login('host', 'mod', PASS);
    expect(r2.legacy).toBe(true);
    expect(old.calls.map((c) => c.url)).toEqual(['/api/admin/login', '/api/login']);
    expect(JSON.parse(old.calls[1]!.init.body)).toEqual({ login: 'mod', password: PASS });

    const wrong = mockFetch(401, { error: 'Wrong username or password.' });
    await expect(createApi({ fetchImpl: wrong.fn, getToken: () => null }).login('host', 'a', 'b')).rejects.toMatchObject({ status: 401 });
    expect(wrong.calls).toHaveLength(1); // a wrong password is never retried on the old API
  });

  it('a 401 is a lost session; a 403 is not (LAN), except "Not a moderator" from the v0.4 API', async () => {
    const lost = vi.fn();
    const e401 = await createApi({ fetchImpl: mockFetch(401, { error: 'Signed out after a while without activity. Sign in again.' }).fn, getToken: () => 't', onAuthLost: lost }).admin('me').catch((e: unknown) => e);
    expect(e401).toBeInstanceOf(ApiError);
    expect(lost).toHaveBeenCalledWith(401, 'Signed out after a while without activity. Sign in again.');
    lost.mockClear();
    await createApi({ fetchImpl: mockFetch(403, { error: 'Not allowed for your role' }).fn, getToken: () => 't', onAuthLost: lost }).admin('log').catch(() => undefined);
    expect(lost).not.toHaveBeenCalled();
    await createApi({ fetchImpl: mockFetch(403, { error: 'Not a moderator' }).fn, getToken: () => 't', onAuthLost: lost, isLegacy: () => true }).admin('me').catch(() => undefined);
    expect(lost).toHaveBeenCalledWith(403, 'Not a moderator');
  });

  it('T-UI-7 (client): a 401 `reauth` asks for the password once and retries the call', async () => {
    const f = seqFetch([
      { status: 401, body: { error: 'Enter your password again to continue.', reauth: true, code: 'reauth' } },
      { status: 200, body: { ok: true, originals: [{ id: 5, original: SECRET }] } },
    ]);
    const lost = vi.fn();
    const onReauth = vi.fn(async () => true);
    const api = createApi({ fetchImpl: f.fn, getToken: () => 't', onAuthLost: lost, onReauth });
    const r = await api.admin('log/reveal', { ids: [5] });
    expect(r.originals).toEqual([{ id: 5, original: SECRET }]);
    expect(onReauth).toHaveBeenCalledOnce();
    expect(f.calls.map((c) => c.url)).toEqual(['/api/admin/log/reveal', '/api/admin/log/reveal']);
    expect(lost).not.toHaveBeenCalled();

    // Cancelled: no retry, the call fails with the reauth error, and the session is not lost.
    const g = seqFetch([{ status: 401, body: { error: 'Enter your password again to continue.', reauth: true, code: 'reauth' } }]);
    const api2 = createApi({ fetchImpl: g.fn, getToken: () => 't', onAuthLost: lost, onReauth: async () => false });
    const err = await api2.admin('log/reveal', { ids: [5] }).catch((e: unknown) => e);
    expect(isReauth(err)).toBe(true);
    expect(g.calls).toHaveLength(1);
    expect(lost).not.toHaveBeenCalled();

    // Two ★ calls at once share one prompt.
    const both = seqFetch([
      { status: 401, body: { reauth: true, code: 'reauth', error: 'x' } }, { status: 401, body: { reauth: true, code: 'reauth', error: 'x' } },
      { status: 200, body: { ok: true } },
    ]);
    const once = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); return true; });
    const api3 = createApi({ fetchImpl: both.fn, getToken: () => 't', onReauth: once });
    await Promise.all([api3.admin('log/reveal', { ids: [1] }), api3.admin('log/export', {})]);
    expect(once).toHaveBeenCalledOnce();
  });

  it('409 needsConfirm keeps its body; 429 carries Retry-After; odd answers become ApiErrors', async () => {
    const c = mockFetch(409, { error: 'Shared address', needsConfirm: true, sharing: 23 });
    const e409 = (await createApi({ fetchImpl: c.fn, getToken: () => 't' }).admin('bans/create', { kind: 'ban' }).catch((e: unknown) => e)) as ApiError;
    expect(e409.body).toMatchObject({ needsConfirm: true, sharing: 23 });
    const r = mockFetch(429, { error: 'Too many requests' }, { 'Retry-After': '90' });
    const e429 = (await createApi({ fetchImpl: r.fn, getToken: () => 't' }).admin('online').catch((e: unknown) => e)) as ApiError;
    expect(errorText(e429)).toBe('Too many requests (try again in 1m)');
    const down = createApi({ fetchImpl: async () => { throw new TypeError('offline'); }, getToken: () => 't' });
    await expect(down.admin('online')).rejects.toMatchObject({ status: 0, message: 'Cannot reach the server.' });
    await expect(createApi({ fetchImpl: mockFetch(200, [1, 2]).fn, getToken: () => 't' }).admin('online')).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses endpoints outside the contract (no path tricks); session-less ones carry no token', async () => {
    const { fn, calls } = mockFetch(200, { ok: true, needsSetup: false });
    const api = createApi({ fetchImpl: fn, getToken: () => 't' });
    await expect(api.admin('../login')).rejects.toBeInstanceOf(ApiError);
    await expect(api.admin('online?token=x')).rejects.toBeInstanceOf(ApiError);
    expect(fn).not.toHaveBeenCalled();
    await api.admin('setup/status', {});
    expect('Authorization' in calls[0]!.init.headers).toBe(false);
    expect(SESSIONLESS).toEqual(['setup/status', 'setup', 'login']);
  });

  it('file endpoints: a download (Blob, filename, X-Row-Count) or JSON (Save on this PC)', async () => {
    const dl = mockFetch(200, undefined, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="voidswarm-chat-2026-09-28_101500.csv"', 'X-Row-Count': '12' });
    const r = await createApi({ fetchImpl: dl.fn, getToken: () => 't' }).file('log/export', { format: 'csv' });
    expect(r).toEqual({ kind: 'file', blob: 'blob-data', filename: 'voidswarm-chat-2026-09-28_101500.csv', rows: 12 });
    const saved = mockFetch(200, { ok: true, savedTo: 'data\\exports\\x.csv', rows: 3 }, { 'Content-Type': 'application/json' });
    expect(await createApi({ fetchImpl: saved.fn, getToken: () => 't' }).file('log/export', {})).toEqual({ kind: 'json', data: { ok: true, savedTo: 'data\\exports\\x.csv', rows: 3 } });
    expect(fileNameOf('attachment; filename="../../evil.csv"')).toBe('.._.._evil.csv');
  });
});

describe('token store and prefs', () => {
  const store = () => {
    const data = new Map<string, string>();
    return { data, s: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) } };
  };
  it('the token lives under one sessionStorage key, with a memory fallback', () => {
    const { data, s } = store();
    const t = createTokenStore(() => s);
    t.set('abc');
    expect(data.get(TOKEN_KEY)).toBe('abc');
    t.clear();
    expect(t.get()).toBeNull();
    const boom = () => { throw new Error('SecurityError'); };
    const m = createTokenStore(() => ({ getItem: boom, setItem: boom, removeItem: boom }));
    m.set('x');
    expect(m.get()).toBe('x');
  });
  it('prefs remember Presenting in localStorage, never a token', () => {
    const { data, s } = store();
    const p = createPrefs(() => s);
    expect(p.presenting()).toBeNull();
    p.setPresenting(true);
    expect(JSON.parse(data.get(PREFS_KEY)!)).toEqual({ presenting: true });
    expect(p.presenting()).toBe(true);
    expect(PREFS_KEY).not.toBe(TOKEN_KEY);
    expect(createPrefs(() => { throw new Error('blocked'); }).presenting()).toBeNull();
  });
});

// ====================================================================================================================
// Row renderers (fake document)
// ====================================================================================================================

describe('row renderers', () => {
  const doc = parseHtml('<!doctype html><html><head></head><body></body></html>');
  const h = makeH(doc);
  const host = capabilitiesOf({ kind: 'host', via: 'local' });
  const blocked = {
    seq: 7, ts: Date.now(), roomUid: 'b:r2', roomName: 'Flag Run', label: 'Flag Run · Crimson (team chat)', channel: 'team', team: 0,
    playerId: 3, name: 'NovaPilot', accountId: 'acc-nova', address: '192.168.1.23', shown: 'Great flying, everyone!', action: 'block',
    display: 'substituted', tags: ['PROFANITY'], wellbeing: false, online: true, chatId: 11, alertId: null, original: SECRET, hits: ['profanity:zz'],
  };

  it('a Live line shows what others saw, labelled, with tag chips — never the original or the hit labels', () => {
    const tr = renderLiveLine(h, blocked, { caps: host, revealed: new Map(), on: { reveal: () => undefined, mute: () => undefined } }) as FakeElement;
    const text = tr.textContent;
    expect(text).toContain('Great flying, everyone!');
    expect(text).toContain('(substituted)');
    expect(text).toContain('PROFANITY');
    expect(text).toContain('Flag Run · Crimson (team chat)');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('zz');
    expect(tr.querySelectorAll('button').map((b) => b.textContent)).toEqual(expect.arrayContaining(['Mute', 'Reveal ★']));
  });

  it('Presenting hides the name, the address and the chat text; no action buttons', () => {
    const tr = renderLiveLine(h, blocked, { presenting: true, caps: host, revealed: new Map([[11, SECRET]]), on: { reveal: () => undefined } }) as FakeElement;
    const text = tr.textContent;
    for (const s of ['NovaPilot', '192.168.1.23', 'Great flying', SECRET]) expect(text).not.toContain(s);
    expect(text).toContain(PRESENT_NAME);
    expect(tr.querySelectorAll('button')).toHaveLength(0);
  });

  it('a revealed line shows "Typed:" under what others saw', () => {
    const tr = renderLogRow(h, { ...blocked, id: 11 }, { caps: host, revealed: new Map([[11, SECRET]]) }) as FakeElement;
    expect(tr.textContent).toContain(`Typed: ${SECRET}`);
    expect(tr.querySelectorAll('button').map((b) => b.textContent)).not.toContain('Reveal ★');
  });

  it('a wellbeing line is nameless with no text until opened ★', () => {
    const wb = { ...blocked, name: 'Quiet', shown: '', display: 'withheld', tags: ['SELF-HARM'], wellbeing: true, id: 12 };
    for (const tr of [
      renderLiveLine(h, wb, { caps: host, on: { openWellbeing: () => undefined, reveal: () => undefined } }) as FakeElement,
      renderLogRow(h, wb, { caps: host, on: { openWellbeing: () => undefined, reveal: () => undefined } }) as FakeElement,
    ]) {
      expect(tr.textContent).toContain(WELLBEING_TEXT);
      expect(tr.textContent).not.toContain('Quiet');
      expect(tr.querySelectorAll('button').map((b) => b.textContent)).toEqual(['Open ★']);
    }
    const mod = capabilitiesOf({ kind: 'moderator', tier: 'limited' });
    expect((renderLiveLine(h, wb, { caps: mod, on: { openWellbeing: () => undefined } }) as FakeElement).querySelectorAll('button')).toHaveLength(0);
  });

  it('h() refuses attributes that could carry markup or script', () => {
    expect(() => h('div', { onclick: 'x' })).toThrow(/refusing/);
    expect(() => h('div', { style: 'x' })).toThrow(/refusing/);
    expect(() => h('a', { href: 'javascript:x' })).toThrow(/refusing/);
  });
});

// ====================================================================================================================
// T-UI-1 and T-UI-2: the contract and the shipped files
// ====================================================================================================================

describe('T-UI-1: every ENDPOINTS entry is a real route and documented', () => {
  it('each is in the admin API route table (http.ts ADMIN_ROUTES)', () => {
    for (const e of ENDPOINTS) expect(Object.prototype.hasOwnProperty.call(ADMIN_ROUTES, e), e).toBe(true);
  });

  /**
   * The 0.6 endpoints adminApi.md does not document yet (its owner rewrites it, §11.11: a HANDOFF, not this page's
   * file). Only these may be missing from it, and each must be in the spec's §5.15 tables meanwhile; any other
   * endpoint the page calls must be in adminApi.md itself. The list only shrinks: add nothing to it.
   */
  // Every 0.6 endpoint the page calls is documented in adminApi.md now (written up at the M1 gate).
  const ADMIN_API_MD_PENDING: string[] = [];
  it('each is documented in adminApi.md; only the named 0.6 endpoints wait for its rewrite (and are in the spec §5.15)', () => {
    const contract = read('../adminApi.md');
    const documented = new Set([...contract.matchAll(/^### `([a-zA-Z/]+)`/gm)].map((m) => m[1]));
    const spec = readFileSync(path.join(repo, 'docs', 'LAN-EDITION-proposal.md'), 'utf8');
    const s515 = spec.slice(spec.indexOf('### 5.15'), spec.indexOf('### 5.16'));
    expect(s515.length).toBeGreaterThan(1000);
    const inSpec = (e: string): boolean => s515.includes(`\`${e}\``) || s515.includes(`\`${e} `);
    // Every endpoint the page calls: in adminApi.md, else on the pending list.
    expect(ENDPOINTS.filter((e) => !documented.has(e) && !ADMIN_API_MD_PENDING.includes(e))).toEqual([]);
    // The pending ones are real endpoints of the page, and the spec documents them until adminApi.md does.
    for (const e of ADMIN_API_MD_PENDING) expect(ENDPOINTS, e).toContain(e);
    expect(ADMIN_API_MD_PENDING.filter((e) => !documented.has(e) && !inSpec(e))).toEqual([]);
  });
});

describe('T-UI-2: no inline script; the files stay CSP-safe', () => {
  const js = read('admin.js');
  const code = js.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n'); // ignore comment lines
  const pages: [string, string, RegExp][] = [
    ['admin.html', read('admin.html'), /^\/admin\/admin\.js$/],
    ['display.html', readFileSync(path.join(repo, 'src', 'lan', 'display', 'display.html'), 'utf8'), /^\/display\/display\.js$/],
  ];

  for (const [name, html, allowed] of pages) {
    it(`${name}: scripts are same-origin files only; no inline script, handlers, styles or external origins`, () => {
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
      expect(scripts.length).toBe(1);
      for (const [, attrs, body] of scripts) {
        const src = /\bsrc="([^"]+)"/.exec(attrs!)?.[1] ?? '';
        expect(src).toMatch(allowed);
        expect(body!.trim()).toBe('');
      }
      // exactly one script: the page's module
      expect(scripts.filter(([, a]) => /type="module"/.test(a!))).toHaveLength(1);
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html).not.toMatch(/\sstyle\s*=/i);
      expect(html).not.toMatch(/<style\b/i);
      expect(html).not.toMatch(/javascript:/i);
      expect(html).not.toMatch(/https?:\/\//i);
      expect(html).not.toMatch(/\bdata:/i);
    });
  }

  it('admin.js and display.js never render markup from strings or evaluate code', () => {
    const files = [code, readFileSync(path.join(repo, 'src', 'lan', 'display', 'display.js'), 'utf8')];
    for (const f of files) {
      for (const bad of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\s*\(/,
        /createContextualFragment/, /DOMParser/, /setTimeout\(\s*['"`]/, /setInterval\(\s*['"`]/, /setAttribute\(\s*['"]style/, /\bdata:image/]) {
        expect(f).not.toMatch(bad);
      }
    }
  });

  it('admin.js keeps the token out of URLs and out of localStorage (which holds the Presenting preference only)', () => {
    expect(code).not.toMatch(/[?&]token=/);
    expect(code).not.toMatch(/location\.(href|search|hash)\s*=/);
    const local = code.split('\n').filter((l) => /localStorage/.test(l));
    expect(local).toHaveLength(1);
    expect(local[0]).toMatch(/createPrefs\(\(\) => win\.localStorage\)/);
    expect(code).toMatch(/createTokenStore\(\(\) => win\.sessionStorage\)/);
  });

  it('admin.css and display.css load nothing from other origins', () => {
    for (const css of [read('admin.css'), readFileSync(path.join(repo, 'src', 'lan', 'display', 'display.css'), 'utf8')]) {
      expect(css).not.toMatch(/@import/i);
      expect(css).not.toMatch(/url\(\s*['"]?(https?:|data:)/i);
    }
  });

  it('every id the script looks up exists in the page', () => {
    const html = read('admin.html');
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const wanted = new Set<string>();
    for (const m of js.matchAll(/\$\('([a-z0-9-]+)'\)/g)) wanted.add(m[1]!);
    for (const t of TABS) { wanted.add(`tab-${t.id}`); wanted.add(`tab-btn-${t.id}`); }
    const runtime = new Set(['dlg-reason', 'dlg-date', 'dlg-check', 'alerts-open']); // built by admin.js
    expect([...wanted].filter((id) => !ids.has(id) && !runtime.has(id))).toEqual([]);
  });
});

describe('no QR code (owner decision 7): the join address is text only', () => {
  const display = path.join(repo, 'src', 'lan', 'display');
  it('the panel and /display draw no QR and load no encoder; the vendored files are gone', () => {
    for (const f of [path.join(here, 'admin.html'), path.join(here, 'admin.js'), path.join(display, 'display.html'), path.join(display, 'display.js')]) {
      const src = readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
      expect(src, f).not.toMatch(/<canvas|getContext|qrcode|drawQr|qr\.js/i);
    }
    for (const f of ['qrcode.js', 'qrcode.LICENSE.txt', 'qr.js', 'qr.d.ts']) expect(existsSync(path.join(here, f)), f).toBe(false);
  });
});

// ====================================================================================================================
// The panel booted on a fake DOM (T-UI-6, T-UI-7, setup, the v0.4 fallback)
// ====================================================================================================================

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

const HOST_CAPS = capabilitiesOf({ kind: 'host', via: 'local' });
const hostSession = (freshMs = 10 * 60_000) => ({
  principal: { kind: 'host', via: 'local' }, username: 'hostadmin', expiresAt: Date.now() + 30 * 60_000, idleSec: 1800,
  freshUntil: freshMs > 0 ? Date.now() + freshMs : 0, capabilities: HOST_CAPS,
});
const meReply = (session = hostSession()) => ({ body: { ok: true, admin: { username: 'hostadmin', kind: 'host' }, session, capabilities: session.capabilities, banners: [{ code: 'x', level: 'warn', text: 'No recovery file yet.' }] } });
const HOME = {
  body: {
    ok: true, serverName: 'Room 136', join: { url: 'http://192.168.1.50:7777/', others: [] }, rooms: [{ roomId: 'r2', name: 'Flag Run', typeLabel: 'Arena', subModeLabel: 'Capture the Flag', phase: 'playing', phaseLabel: 'Playing', humans: 5, bots: 3, spectators: 0, maxPlayers: 16 }],
    counts: { online: 5, rooms: 1, playing: 1 }, online: { total: 5, accounts: 3, guests: 2 }, alerts: { urgent: 0, banner: 0, wellbeing: 0 }, presentingAtLogin: false,
  },
};
const LIVE_LINES = [
  { seq: 101, ts: Date.now() - 3000, roomUid: 'b:r2', roomName: 'Flag Run', label: 'Flag Run', channel: 'all', team: 0, playerId: 3, name: 'NovaPilot', accountId: 'acc-nova', address: '192.168.1.23', shown: 'Great flying, everyone!', action: 'block', display: 'substituted', tags: ['PROFANITY'], wellbeing: false, online: true, chatId: 11, alertId: null,
    // A server must never send these; if one did, the page would still not show them.
    original: SECRET, hits: ['profanity:zz'] },
  { seq: 102, ts: Date.now() - 2000, roomUid: 'b:zone', roomName: '', label: 'Zone lobby', channel: 'all', team: -1, playerId: 0, name: '', accountId: null, address: null, shown: '', action: 'block', display: 'withheld', tags: ['SELF-HARM'], wellbeing: true, online: false, chatId: 12, alertId: 4 },
  { seq: 103, ts: Date.now() - 1000, roomUid: 'b:r2', roomName: 'Flag Run', label: 'Flag Run', channel: 'all', team: 1, playerId: 5, name: 'VegaWing', accountId: null, address: '192.168.1.40', shown: 'gg', action: 'pass', display: 'as-typed', tags: [], wellbeing: false, online: true, chatId: 13, alertId: null },
];
const LOG_ROWS = [
  { id: 11, ts: Date.now() - 3000, roomId: 'r2', roomUid: 'b:r2', roomName: 'Flag Run', channel: 'all', team: 0, playerId: 3, name: 'NovaPilot', accountId: 'acc-nova', address: '192.168.1.23', original: SECRET, shown: 'Great flying, everyone!', action: 'block', hits: [], display: 'substituted', tags: ['PROFANITY'] },
  { id: 13, ts: Date.now() - 1000, roomId: 'r2', roomUid: 'b:r2', roomName: 'Flag Run', channel: 'team', team: 1, playerId: 5, name: 'VegaWing', accountId: null, address: '192.168.1.40', original: `${SECRET}-2`, shown: '**** off', action: 'mask', hits: [], display: 'masked', tags: ['PROFANITY'] },
];
/** A long-poll that waits until the test ends (aborted by app.stop()). */
const hang: Route = () => new Promise(() => undefined);

interface Panel { doc: FakeDocument; f: ReturnType<typeof fakeFetch>; win: ReturnType<typeof fakeWindow>; app: ReturnType<typeof boot>; $: (id: string) => FakeElement }

async function bootPanel(o: { routes: Record<string, Route>; token?: string | null; legacy?: boolean; hash?: string; local?: Record<string, string>; ignoreAbort?: boolean }): Promise<Panel> {
  const doc = parseHtml(read('admin.html'));
  const f = fakeFetch(o.routes);
  const session: Record<string, string> = {};
  if (o.token) session[TOKEN_KEY] = o.token;
  if (o.legacy) session[MODE_KEY] = 'legacy';
  // ignoreAbort: the answer lands even after the page aborted the call (the worker had already answered).
  const fetchFn = o.ignoreAbort ? (url: string, init: { signal?: AbortSignal }) => f.fn(url, { ...init, signal: undefined }) : f.fn;
  const win = fakeWindow({ fetch: fetchFn as never, session, local: o.local, hash: o.hash });
  const app = boot({ doc, win });
  cleanups.push(() => app.stop());
  await settle();
  return { doc, f, win, app, $: (id) => { const n = doc.getElementById(id); if (!n) throw new Error(`no #${id}`); return n; } };
}

const buttonIn = (root: FakeElement, text: string): FakeElement[] => root.querySelectorAll('button').filter((b) => b.textContent === text);
const submit = (form: FakeElement): void => { form.dispatchEvent(new FakeEvent('submit')); };

const liveRoute: Route = (c: FetchCall) => ('after' in c.body ? new Promise(() => undefined) : { body: { ok: true, lines: LIVE_LINES, next: 103, gap: false } });

describe('T-UI-6: the default Live and Chat-log DOM; Presenting; one audited call per reveal', () => {
  it('Live: shown text and tag chips only; a reveal is one log/reveal call; Presenting hides names and text', async () => {
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef',
      routes: {
        me: meReply(), home: HOME, reports: { body: { ok: true, reports: [], nextBefore: null } }, 'chat/live': liveRoute,
        'log/reveal': (c) => ({ body: { ok: true, originals: (c.body.ids as number[]).map((id) => ({ id, original: id === 11 ? SECRET : 'other' })), nextBefore: null } }),
      },
    });
    expect(p.$('app-view').hidden).toBe(false);
    expect(p.app.state().currentTab).toBe('home');
    expect(p.$('banners').textContent).toContain('No recovery file yet.');
    // Home is projector-safe: counts and the Join card, no names.
    expect(p.$('tab-home').textContent).toContain('http://192.168.1.50:7777/');
    expect(p.$('tab-home').textContent).not.toContain('NovaPilot');

    p.$('tab-btn-live').click();
    await settle();
    const body = p.$('live-body');
    expect(body.querySelectorAll('tr')).toHaveLength(3);
    const text = body.textContent;
    expect(text).toContain('Great flying, everyone!');
    expect(text).toContain('(substituted)');
    expect(text).toContain('NovaPilot');
    expect(text).toContain(WELLBEING_TEXT);
    // Never the original, the hit labels, or the wellbeing student, anywhere on the page.
    expect(pageText(p.doc)).not.toContain(SECRET);
    expect(pageText(p.doc)).not.toContain('zz');

    // Reveal ★: exactly one audited call, then "Typed:" under the line.
    const reveal = buttonIn(body, 'Reveal ★');
    expect(reveal).toHaveLength(1); // the blocked line only (not the pass line, not the wellbeing one)
    reveal[0]!.click();
    await settle();
    expect(p.f.of('log/reveal')).toHaveLength(1);
    expect(p.f.of('log/reveal')[0]!.body).toEqual({ ids: [11] });
    expect(body.textContent).toContain(`Typed: ${SECRET}`);

    // Presenting: names, addresses, chat text (and the revealed text) disappear; Conduct and Accounts lock.
    p.$('presenting-btn').click();
    await settle();
    expect(p.app.state().presenting).toBe(true);
    const shown = p.$('live-body').textContent;
    for (const s of ['NovaPilot', 'VegaWing', '192.168.1.23', 'Great flying', SECRET]) expect(shown).not.toContain(s);
    expect(shown).toContain(PRESENT_NAME);
    expect(p.$('tab-btn-conduct').disabled).toBe(true);
    expect(p.$('tab-btn-accounts').disabled).toBe(true);
    expect(p.win.localStorage.getItem(PREFS_KEY)).toBe(JSON.stringify({ presenting: true }));

    // Off again (the session is fresh: no password asked).
    p.$('presenting-btn').click();
    await settle();
    expect(p.app.state().presenting).toBe(false);
    expect(p.$('reauth-dlg').open).toBe(false);
    expect(p.$('live-body').textContent).toContain('NovaPilot');
    expect(p.f.of('log/reveal')).toHaveLength(1);
  });

  it('Live: a line whose chat id the ring does not know yet is found in the log (exact time, pilot, channel, shown text)', async () => {
    const pending = { ...LIVE_LINES[0], chatId: null, original: undefined, hits: undefined };
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef',
      routes: {
        me: meReply(), home: HOME, reports: { body: { ok: true, reports: [] } },
        'chat/live': (c) => ('after' in c.body ? new Promise(() => undefined) : { body: { ok: true, lines: [pending], next: 101, gap: false } }),
        // Two candidates at that time: only the exact one (same pilot, channel and shown text) is used.
        log: { body: { ok: true, lines: [{ ...LOG_ROWS[0], id: 40, playerId: 99 }, { ...LOG_ROWS[0], id: 41, ts: pending.ts, playerId: 3, channel: 'all', shown: 'Great flying, everyone!' }], nextBefore: null } },
        'log/reveal': (c) => ({ body: { ok: true, originals: (c.body.ids as number[]).map((id) => ({ id, original: SECRET })) } }),
      },
    });
    p.$('tab-btn-live').click();
    await settle();
    buttonIn(p.$('live-body'), 'Reveal ★')[0]!.click();
    await settle();
    expect(p.f.of('log')[0]!.body).toEqual({ player: 'NovaPilot', since: pending.ts, until: pending.ts, limit: 20 });
    expect(p.f.of('log/reveal').map((c) => c.body)).toEqual([{ ids: [41] }]);
    expect(p.$('live-body').textContent).toContain(`Typed: ${SECRET}`);
  });

  it('Chat log: the table shows what others saw; originals never reach the DOM before Reveal', async () => {
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef',
      routes: {
        me: meReply(), home: HOME, reports: { body: { ok: true, reports: [] } },
        'log/stats': { body: { ok: true, rows: 812331, oldest: Date.now() - 30 * 86_400_000, dbBytes: 1_000_000, walBytes: 0, retention: { mode: 'days', days: 90 }, nextPurgeAt: Date.now() + 3600_000 } },
        'log/rooms': { body: { ok: true, rooms: [{ roomUid: 'b:r2', roomId: 'r2', name: 'Flag Run', firstTs: Date.now() - 60_000, lastTs: Date.now(), lines: 2, lobby: false, legacy: false }] } },
        log: { body: { ok: true, lines: LOG_ROWS, nextBefore: null, nextBeforeTs: null } },
        'log/reveal': (c) => ({ body: { ok: true, originals: (c.body.ids as number[]).map((id) => ({ id, original: LOG_ROWS.find((r) => r.id === id)!.original })) } }),
      },
    });
    p.$('tab-btn-chat').click();
    await settle();
    const body = p.$('chat-body');
    expect(body.querySelectorAll('tr')).toHaveLength(2);
    expect(body.textContent).toContain('Great flying, everyone!');
    expect(body.textContent).toContain('**** off');
    expect(pageText(p.doc)).not.toContain(SECRET);
    expect(p.$('log-stats').textContent).toContain('the log holds 812,331 lines');
    expect(p.$('log-stats').textContent).toContain('retention 90 days');
    expect(p.$('chat-room').options.map((o) => o.value)).toContain('uid:b:r2');
    // The search itself carried no original-text flag: the server decides what the text matches.
    expect(p.f.of('log')[0]!.body).toEqual({ limit: 100 });

    // "Show originals" for the page: one call for every line in view.
    p.$('chat-originals').click();
    await settle();
    expect(p.f.of('log/reveal')).toHaveLength(1);
    expect(p.f.of('log/reveal')[0]!.body).toEqual({ ids: [11, 13] });
    expect(body.textContent).toContain(`Typed: ${SECRET}`);
    expect(body.textContent).toContain(`Typed: ${SECRET}-2`);
  });
});

describe('T-UI-7: the reauth dialog appears on a 401 `reauth` and retries the call', () => {
  const reauth401 = { status: 401, body: { error: 'Enter your password again to continue.', reauth: true, code: 'reauth' } };

  it('Reveal on a stale session: the dialog, the password, then the same reveal again', async () => {
    let reveals = 0;
    let fresh = false; // the server's step-up state: fresh once the password was given again
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef',
      routes: {
        me: () => meReply(hostSession(fresh ? 10 * 60_000 : 0)), home: HOME, reports: { body: { ok: true, reports: [] } },
        'log/stats': { body: { ok: true, rows: 2, retention: { mode: 'days', days: 90 } } }, 'log/rooms': { body: { ok: true, rooms: [] } },
        log: { body: { ok: true, lines: LOG_ROWS, nextBefore: null } },
        'log/reveal': () => (++reveals === 1 ? reauth401 : { body: { ok: true, originals: [{ id: 11, original: SECRET }] } }),
        reauth: (c) => {
          if (c.body.password !== PASS) return { status: 400, body: { error: 'That password is not right.', wrongPassword: true } };
          fresh = true;
          return { body: { ok: true, session: hostSession() } };
        },
      },
    });
    expect(p.$('fresh-chip').textContent).toMatch(/locked/);
    p.$('tab-btn-chat').click();
    await settle();
    buttonIn(p.$('chat-body'), 'Reveal ★')[0]!.click();
    await settle();
    expect(p.$('reauth-dlg').open).toBe(true);
    expect(p.f.of('log/reveal')).toHaveLength(1);
    expect(pageText(p.doc)).not.toContain(SECRET);

    // A wrong password keeps the dialog open.
    p.$('reauth-pass').value = 'not-the-password';
    submit(p.$('reauth-form'));
    await settle();
    expect(p.$('reauth-dlg').open).toBe(true);
    expect(p.$('reauth-error').textContent).toMatch(/not right/);

    p.$('reauth-pass').value = PASS;
    submit(p.$('reauth-form'));
    await settle();
    expect(p.$('reauth-dlg').open).toBe(false);
    expect(p.$('reauth-pass').value).toBe('');
    const order = p.f.calls.map((c) => c.endpoint).filter((e) => e === 'log/reveal' || e === 'reauth');
    expect(order).toEqual(['log/reveal', 'reauth', 'reauth', 'log/reveal']);
    expect(p.$('chat-body').textContent).toContain(`Typed: ${SECRET}`);
    expect(p.$('fresh-chip').textContent).toMatch(/unlocked/);
    expect(p.app.state().signedIn).toBe(true);
  });

  it('Cancel: no retry, the page stays signed in; Presenting off on a stale session asks first', async () => {
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef',
      local: { [PREFS_KEY]: JSON.stringify({ presenting: true }) },
      routes: {
        me: meReply(hostSession(0)), home: HOME, reports: { body: { ok: true, reports: [] } },
        'log/stats': { body: { ok: true, rows: 2 } }, 'log/rooms': { body: { ok: true, rooms: [] } }, log: { body: { ok: true, lines: LOG_ROWS, nextBefore: null } },
        'log/reveal': reauth401, reauth: { body: { ok: true, session: hostSession() } },
      },
    });
    // Remembered in this browser: Presenting is on after a reload.
    expect(p.app.state().presenting).toBe(true);
    p.$('presenting-btn').click();
    await settle();
    expect(p.$('reauth-dlg').open).toBe(true);
    p.$('reauth-cancel').click();
    await settle();
    expect(p.app.state().presenting).toBe(true);

    p.$('presenting-btn').click();
    await settle();
    p.$('reauth-pass').value = PASS;
    submit(p.$('reauth-form'));
    await settle();
    expect(p.app.state().presenting).toBe(false);

    // Freshness back to stale for the reveal: the reveal's own 401 reauth, then Cancel.
    p.$('tab-btn-chat').click();
    await settle();
    buttonIn(p.$('chat-body'), 'Reveal ★')[0]!.click();
    await settle();
    expect(p.$('reauth-dlg').open).toBe(true);
    p.$('reauth-cancel').click();
    await settle();
    expect(p.f.of('log/reveal')).toHaveLength(1);
    expect(p.$('app-view').hidden).toBe(false);
    expect(p.$('toasts').textContent).toMatch(/Reveal/);
    expect(pageText(p.doc)).not.toContain(SECRET);
  });

  it('a session that ended (plain 401) goes back to the sign-in with the server\'s words', async () => {
    let n = 0;
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef',
      routes: {
        me: () => (++n === 1 ? meReply() : { status: 401, body: { error: 'Signed out after a while without activity. Sign in again.' } }),
        reports: { body: { ok: true, reports: [] } }, home: HOME,
      },
    });
    expect(p.$('app-view').hidden).toBe(false);
    // Back to the tab: `me` is asked again, and the session has ended.
    p.doc.dispatchEvent(new FakeEvent('visibilitychange'));
    await settle();
    expect(p.$('login-view').hidden).toBe(false);
    expect(p.$('login-status').textContent).toMatch(/without activity/);
    expect(p.win.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});

describe('first-run setup (host PC)', () => {
  it('the code from the URL fragment is filled in and removed from the address bar; setup signs in', async () => {
    const p = await bootPanel({
      hash: '#setup=k7qp4mxd',
      routes: {
        'setup/status': { body: { ok: true, needsSetup: true, kind: 'first', retryAfter: 0, attemptsLeft: 5 } },
        setup: (c) => ({ body: { ok: true, token: 'tok-new-0123456789abcdef', session: hostSession(), kind: 'first', echo: c.body } }),
        me: meReply(), home: { body: { ...HOME.body, presentingAtLogin: true } }, reports: { body: { ok: true, reports: [] } },
      },
    });
    expect(p.$('setup-view').hidden).toBe(false);
    expect(p.$('setup-code').value).toBe('K7QP-4MXD');
    expect(p.win.history.replaced).toEqual(['/']);
    p.$('setup-user').value = 'hostadmin';
    p.$('setup-pass').value = PASS;
    p.$('setup-pass2').value = PASS;
    expect(p.$('setup-domain-fields').hidden).toBe(true);
    p.$('setup-school').click();
    expect(p.$('setup-school-fields').hidden).toBe(false);
    expect(p.$('setup-domain-fields').hidden).toBe(false); // owner decision 6: offered in School setup, optional
    p.$('setup-accounts-roster').click();
    p.$('setup-name').value = 'Room 136';
    p.$('setup-domains').value = 'caldwellschools.org';
    p.$('setup-domains-sub').click();
    submit(p.$('setup-form'));
    await settle();
    expect(p.f.of('setup')[0]!.body).toEqual({
      setupCode: 'K7QP-4MXD', username: 'hostadmin', password: PASS, preset: 'school', serverName: 'Room 136', accountsMode: 'roster',
      domains: [{ domain: 'caldwellschools.org', subdomains: true }],
    });
    expect(p.win.sessionStorage.getItem(TOKEN_KEY)).toBe('tok-new-0123456789abcdef');
    expect(p.$('app-view').hidden).toBe(false);
    // School: Presenting is on at a new sign-in.
    expect(p.app.state().presenting).toBe(true);
    expect(p.$('setup-pass').value).toBe('');
  });

  it('a wrong code shows the tries left; a remote device goes to the sign-in', async () => {
    const p = await bootPanel({
      routes: {
        'setup/status': { body: { ok: true, needsSetup: true, kind: 'reset', retryAfter: 0, attemptsLeft: 5 } },
        setup: { status: 400, body: { error: 'That setup code is not right.', attemptsLeft: 4, field: 'setupCode' } },
      },
    });
    expect(p.$('setup-first-fields').hidden).toBe(true); // after "Reset admin password": the login only
    p.$('setup-code').value = 'AAAA-BBBB';
    p.$('setup-user').value = 'hostadmin';
    p.$('setup-pass').value = PASS;
    p.$('setup-pass2').value = PASS;
    submit(p.$('setup-form'));
    await settle();
    expect(p.$('setup-status').textContent).toBe('That setup code is not right. (4 tries left)');
    const remote = await bootPanel({ routes: { 'setup/status': { status: 403, body: { error: 'Setup only works on the host PC.' } } } });
    expect(remote.$('login-view').hidden).toBe(false);
  });
});

describe('the v0.4 moderator API (legacy `npm start`)', () => {
  it('signs in with the game account, keeps originals out of the page, and a Reveal is one audited log read', async () => {
    const p = await bootPanel({
      routes: {
        // no setup/status, no /api/admin/login: 404 (the old server)
        '/api/login': { body: { token: 'tok-legacy-0123456789abcdef', account: { accountId: 'acc-mod', username: 'modpilot' } } },
        me: { body: { ok: true, admin: { accountId: 'acc-mod', username: 'modpilot' } } },
        online: { body: { ok: true, players: [{ playerId: 3, name: 'NovaPilot', accountId: 'acc-nova', username: 'novapilot', address: '192.168.1.23', roomName: 'Flag Run', strikes: 0, muted: null }] } },
        reports: { body: { ok: true, reports: [] } },
        log: { body: { ok: true, lines: LOG_ROWS.map((r) => ({ ...r, display: undefined, tags: undefined, hits: ['profanity:zz'] })), nextBefore: null } },
      },
    });
    expect(p.$('login-view').hidden).toBe(false);
    p.$('login-user').value = 'modpilot';
    p.$('login-pass').value = PASS;
    submit(p.$('login-form'));
    await settle();
    expect(p.f.calls.map((c) => c.endpoint).slice(0, 4)).toEqual(['setup/status', 'login', '/api/login', 'me']);
    const st = p.app.state();
    expect(st.legacy).toBe(true);
    expect(st.tabs).toEqual(['chat', 'rooms', 'reports', 'bans', 'audit']);
    expect(st.currentTab).toBe('rooms');
    expect(p.$('online-body').textContent).toContain('NovaPilot');
    expect(p.win.sessionStorage.getItem(MODE_KEY)).toBe('legacy');

    p.$('tab-btn-chat').click();
    await settle();
    expect(p.$('chat-body').textContent).toContain('PROFANITY'); // tags from the hit labels' categories
    expect(pageText(p.doc)).not.toContain(SECRET);
    expect(pageText(p.doc)).not.toContain('zz');
    expect(p.f.of('log')).toHaveLength(1);
    expect(p.app.state().revealed.size).toBe(0);
    // Reveal: the old API has no log/reveal. The page read the page without keeping the originals, so it asks again:
    // one `log` call narrowed to that line (that API audits every log read, "api log …").
    buttonIn(p.$('chat-body'), 'Reveal ★')[0]!.click();
    await settle();
    expect(p.f.of('log/reveal')).toHaveLength(0);
    expect(p.f.of('log')).toHaveLength(2);
    expect(p.f.of('log')[1]!.body).toEqual({ since: LOG_ROWS[0]!.ts, until: LOG_ROWS[0]!.ts, limit: 500, player: 'NovaPilot' });
    expect(p.$('chat-body').textContent).toContain(`Typed: ${SECRET}`);
    expect(p.$('chat-body').textContent).not.toContain(`Typed: ${SECRET}-2`); // only the line that was revealed
    // "Show originals": the lines in view not revealed yet (here one: so narrowed to its pilot too).
    p.$('chat-originals').click();
    await settle();
    expect(p.f.of('log')).toHaveLength(3);
    expect(p.f.of('log')[2]!.body).toEqual({ since: LOG_ROWS[1]!.ts, until: LOG_ROWS[1]!.ts, limit: 500, player: 'VegaWing' });
    expect(p.$('chat-body').textContent).toContain(`Typed: ${SECRET}-2`);
  });

  it('"Show originals" on the old API: one log call over the time span of the page, with its filter', async () => {
    const p = await bootPanel({
      token: 'tok-legacy-0123456789abcdef', legacy: true,
      routes: {
        me: { body: { ok: true, admin: { accountId: 'acc-mod', username: 'modpilot' } } },
        online: { body: { ok: true, players: [] } }, reports: { body: { ok: true, reports: [] } },
        log: { body: { ok: true, lines: LOG_ROWS.map((r) => ({ ...r, display: undefined, tags: undefined })), nextBefore: null } },
      },
    });
    p.$('tab-btn-chat').click();
    await settle();
    p.$('chat-action').value = 'block';
    submit(p.$('chat-filters'));
    await settle();
    expect(pageText(p.doc)).not.toContain(SECRET);
    const filter = { ...p.f.of('log')[1]!.body };
    delete filter.limit;
    p.$('chat-originals').click();
    await settle();
    expect(p.f.of('log')).toHaveLength(3);
    expect(p.f.of('log')[2]!.body).toEqual({ ...filter, since: LOG_ROWS[0]!.ts, until: LOG_ROWS[1]!.ts, limit: 500 });
    expect(p.$('chat-body').textContent).toContain(`Typed: ${SECRET}`);
    expect(p.$('chat-body').textContent).toContain(`Typed: ${SECRET}-2`);
  });

  it('an account that is not a moderator is sent back with that message', async () => {
    const p = await bootPanel({
      token: 'tok-legacy-0123456789abcdef', legacy: true,
      routes: { me: { status: 403, body: { error: 'Not a moderator' } }, '/api/logout': { body: { ok: true } } },
    });
    expect(p.$('login-view').hidden).toBe(false);
    expect(p.$('login-status').textContent).toBe('This account is not a moderator.');
    expect(p.win.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});

describe('a limited moderator (T-UI-3 shape on the page)', () => {
  it('sees Live, Rooms and Reports, no Reveal and no wellbeing line', async () => {
    const caps = capabilitiesOf({ kind: 'moderator', tier: 'limited' });
    const session = { principal: { kind: 'moderator', tier: 'limited' }, username: 'modpilot', expiresAt: Date.now() + 1e6, idleSec: 1800, freshUntil: Date.now() + 1e6, capabilities: caps };
    const p = await bootPanel({
      token: 'tok-mod-0123456789abcdef',
      routes: {
        me: { body: { ok: true, admin: { username: 'modpilot', kind: 'moderator', accountId: 'acc-mod' }, session, capabilities: caps, banners: [] } },
        reports: { body: { ok: true, reports: [] } },
        'chat/live': (c) => ('after' in c.body ? new Promise(() => undefined) : { body: { ok: true, lines: [{ ...LIVE_LINES[0], address: undefined, addressTag: '3f9a', original: undefined, hits: undefined }, LIVE_LINES[2]], next: 103, gap: false } }),
      },
    });
    const visible = TABS.map((t) => t.id).filter((id) => !p.$(`tab-btn-${id}`).hidden);
    expect(visible).toEqual(['live', 'rooms', 'reports']);
    expect(p.app.state().currentTab).toBe('live');
    await settle();
    expect(p.$('live-body').textContent).toContain('address tag 3f9a');
    expect(buttonIn(p.$('live-body'), 'Reveal ★')).toHaveLength(0);
    expect(p.$('live-originals').hidden).toBe(true);
  });
});

// ====================================================================================================================
// Background refreshes, Home alert counts, Presenting and wellbeing, the setup code (B9 fixer round 1)
// ====================================================================================================================

describe('Home alert counts and the Reports badge (pure)', () => {
  it('openReportsOf reads a count or { open, more } from a passive reply', () => {
    expect(openReportsOf({ openReports: 3 })).toEqual({ open: 3, more: false });
    expect(openReportsOf({ openReports: { open: 200, more: true } })).toEqual({ open: 200, more: true });
    for (const r of [null, {}, { openReports: -1 }, { openReports: 'x' }, { openReports: { open: NaN } }]) expect(openReportsOf(r)).toBeNull();
  });

  it('a banner-level wellbeing alert beside an urgent threat: both shown, nothing counted twice', () => {
    expect(homeAlertParts({ urgent: 1, banner: 1, wellbeing: 1, wellbeingUrgent: 0, wellbeingBanner: 1 })).toEqual([
      { text: 'A wellbeing alert needs your attention', urgent: false }, { text: '1 urgent alert', urgent: true },
    ]);
    expect(homeAlertParts({ urgent: 2, banner: 0, wellbeing: 1, wellbeingUrgent: 1, wellbeingBanner: 0 })).toEqual([
      { text: 'A wellbeing alert needs your attention', urgent: true }, { text: '1 urgent alert', urgent: true },
    ]);
    expect(homeAlertParts({ urgent: 0, banner: 3, wellbeing: 0 })).toEqual([{ text: '3 alerts', urgent: false }]);
    expect(homeAlertParts({})).toEqual([]);
  });

  it('without the per-level split the totals are shown whole, so an urgent alert is never hidden', () => {
    expect(homeAlertParts({ urgent: 1, banner: 1, wellbeing: 1 })).toEqual([
      { text: 'A wellbeing alert needs your attention', urgent: true }, { text: '1 urgent alert in all', urgent: true }, { text: '1 alert in all', urgent: false },
    ]);
  });

  it('the background endpoints are all passive routes (no idle-clock or step-up refresh)', () => {
    for (const ep of BACKGROUND_ENDPOINTS) {
      expect(ENDPOINTS, ep).toContain(ep);
      expect(ADMIN_ROUTES[ep]?.passive, ep).toBe(true);
    }
    expect(ADMIN_ROUTES.reports?.passive).toBeFalsy(); // why the badge never polls `reports`
  });
});

describe('background refreshes call passive routes only (§4.10: idle timeout, step-up freshness)', () => {
  const HOME_WITH_REPORTS = { body: { ...HOME.body, openReports: { open: 3, more: false } } };
  const routesFor = (me: Route): Record<string, Route> => ({
    me, home: HOME_WITH_REPORTS, 'chat/live': liveRoute, online: { body: { ok: true, players: [] } },
    reports: { body: { ok: true, reports: [], nextBefore: null } }, bans: { body: { ok: true, bans: [] } }, actions: { body: { ok: true, actions: [], nextBefore: null } },
    'log/stats': { body: { ok: true, rows: 2 } }, 'log/rooms': { body: { ok: true, rooms: [] } }, log: { body: { ok: true, lines: LOG_ROWS, nextBefore: null } },
    'alerts/list': { body: { ok: true, alerts: [] } },
  });
  const background = (calls: FetchCall[]): string[] => calls.map((c) => c.endpoint);
  const expectPassive = (eps: string[], where: string): void => {
    for (const ep of eps) {
      expect(BACKGROUND_ENDPOINTS, `${where}: ${ep}`).toContain(ep);
      expect(ADMIN_ROUTES[ep]?.passive, `${where}: ${ep}`).toBe(true);
    }
  };
  /** Every timer fires at least once, then the page is hidden and shown again. */
  async function idle(p: Panel): Promise<void> {
    vi.advanceTimersByTime(Math.max(REPORTS_POLL_MS, ME_REFRESH_MS, HOME_REFRESH_MS, ONLINE_REFRESH_MS, CLOCK_TICK_MS) + 1000);
    await settle();
    p.doc.hidden = true;
    p.doc.dispatchEvent(new FakeEvent('visibilitychange'));
    p.doc.hidden = false;
    p.doc.dispatchEvent(new FakeEvent('visibilitychange'));
    await settle();
  }

  it('the host: a reload, then every tab left alone — timers and returning to the page never call `reports`', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const p = await bootPanel({ token: 'tok-host-0123456789abcdef', routes: routesFor(meReply()) });
      // A reload (stored token) is not a user action either: everything so far was passive.
      expectPassive(background(p.f.calls), 'reload');
      expect(p.$('reports-count').textContent).toBe('3'); // the badge came from `home`
      const tabs = p.app.state().tabs;
      expect(tabs).toHaveLength(12);
      for (const tab of tabs) {
        p.$(`tab-btn-${tab}`).click(); // deliberate: whatever it loads is allowed
        await settle();
        const mark = p.f.calls.length;
        await idle(p);
        const eps = background(p.f.calls.slice(mark));
        expectPassive(eps, tab);
        expect(eps, tab).toContain('me');
        if (tab !== 'home') expect(eps, tab).toContain('home'); // the Reports badge, passively
      }
      expect(p.f.of('reports').length).toBe(1); // only the Reports tab's own list (a click)
    } finally {
      vi.useRealTimers();
    }
  });

  it('a limited moderator: the badge comes from the counts-only `home`, never from `reports`', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const caps = capabilitiesOf({ kind: 'moderator', tier: 'limited' });
      const session = { principal: { kind: 'moderator', tier: 'limited' }, username: 'modpilot', expiresAt: Date.now() + 1e6, idleSec: 1800, freshUntil: 0, capabilities: caps };
      const routes = routesFor({ body: { ok: true, admin: { username: 'modpilot', kind: 'moderator' }, session, capabilities: caps, banners: [] } });
      routes.home = { body: { ok: true, counts: { online: 2, rooms: 1, playing: 1 }, openReports: { open: 7, more: false } } };
      const p = await bootPanel({ token: 'tok-mod-0123456789abcdef', routes });
      await idle(p);
      expectPassive(background(p.f.calls), 'moderator');
      expect(p.f.of('reports')).toHaveLength(0);
      expect(p.$('reports-count').textContent).toBe('7');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a sign-in and a review are deliberate: they read the report list itself', async () => {
    const p = await bootPanel({
      routes: {
        'setup/status': { body: { ok: true, needsSetup: false } }, login: { body: { ok: true, token: 'tok-host-0123456789abcdef', session: hostSession() } },
        me: meReply(), home: HOME, reports: { body: { ok: true, reports: [{ id: 1 }, { id: 2 }], nextBefore: null } },
      },
    });
    p.$('login-user').value = 'hostadmin';
    p.$('login-pass').value = PASS;
    submit(p.$('login-form'));
    await settle();
    expect(p.f.of('reports')).toHaveLength(1);
    expect(p.$('reports-count').textContent).toBe('2');
  });
});

describe('an unattended panel signs out (§4.10): the real host admin, listener and page', () => {
  const cleanupsE2e: (() => Promise<void> | void)[] = [];
  afterEach(async () => { for (const c of cleanupsE2e.splice(0).reverse()) await c(); });

  interface Res { status: number; json: Record<string, unknown> }
  /** POST to the admin listener as the page on the host PC would. */
  function post(port: number, ep: string, body: unknown, token?: string): Promise<Res> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const headers: Record<string, string> = { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) };
      if (token) headers.Authorization = `Bearer ${token}`;
      const req = httpRequest({ host: '127.0.0.1', port, path: `/api/admin/${ep}`, method: 'POST', headers, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => { let j = {}; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, json: j }); });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }
  /** window.fetch for the booted page: the real listener; `drain()` waits for every call in flight. */
  function listenerFetch(port: number) {
    const inflight = new Set<Promise<unknown>>();
    const endpoints: string[] = [];
    const fn = (url: string, init: { headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<unknown> => {
      endpoints.push(url.replace('/api/admin/', ''));
      const call = new Promise((resolve, reject) => {
        const payload = init.body ?? '';
        const req = httpRequest({
          host: '127.0.0.1', port, path: url, method: 'POST', agent: false,
          headers: { ...(init.headers ?? {}), Host: `localhost:${port}`, Origin: `http://localhost:${port}`, 'Content-Length': String(Buffer.byteLength(payload)) },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (d: Buffer) => chunks.push(d));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            resolve({
              ok: status >= 200 && status < 300, status,
              headers: { get: (k: string) => { const v = res.headers[k.toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null; } },
              json: async () => JSON.parse(text), blob: async () => text,
            });
          });
        });
        req.on('error', reject);
        init.signal?.addEventListener('abort', () => { req.destroy(); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
        req.end(payload);
      });
      inflight.add(call);
      void call.finally(() => inflight.delete(call)).catch(() => undefined);
      return call;
    };
    const drain = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) {
        await settle(4);
        if (!inflight.size) return;
        await Promise.allSettled([...inflight]);
      }
    };
    return { fn, drain, endpoints };
  }

  it('Home left open on the projector: private views lock after 10 minutes and the session ends after 30', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    cleanupsE2e.push(() => { vi.useRealTimers(); });
    let clock = Date.now();
    const start = clock;
    const now = (): number => clock;
    const dir = mkdtempSync(path.join(tmpdir(), 'voidswarm-panel-idle-'));
    const dbPath = path.join(dir, 'voidswarm.db');
    new AuthStore(dbPath).close();
    const policy: AdminPolicy = { ...DEFAULT_ADMIN_POLICY };
    const ha = new HostAdmin({ dbPath, policy: () => policy, passwordParams: { N: 1 << 10, r: 8, p: 1, keylen: 32 }, pepper: randomBytes(32), now });
    const panel = createPanelState({ serverName: () => 'Room 136', join: () => ({ url: 'http://192.168.1.50:7777/' }), openReports: () => 2, now });
    let reportsCalls = 0;
    const handlers: Record<string, AdminRouteHandler> = {
      ...panel.handlers,
      reports: () => { reportsCalls++; return [200, { ok: true, reports: [], nextBefore: null }]; },
      'log/reveal': () => [200, { ok: true, originals: [] }],
    };
    const api = createAdminHttp({ service: null, trustProxy: false, log: () => undefined, hostAdmin: ha, policy: () => policy, handlers, now, limits: { calls: [100000, 60000] } });
    const listener = await startAdminListener({ port: 0, policy: () => ({ remoteAccess: 'off', devicesTrustCert: false }), loopback: ['127.0.0.1'], handle: createAdminSite({ api, pageDir: ADMIN_PAGE_DIR }) });
    cleanupsE2e.push(async () => { panel.close(); await listener.close(); ha.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the WAL briefly */ } });
    const port = listener.port;
    const code = newSetupCode();
    ha.installLaunchCode(code);
    const setup = await post(port, 'setup', { setupCode: formatSetupCode(code), username: 'hostidle', password: PASS, preset: 'home', serverName: 'Den', accountsMode: 'email' });
    expect(setup.status).toBe(200);
    const token = setup.json.token as string;

    // The page reloads with the session (no user action from here on) and stays on Home.
    const net = listenerFetch(port);
    const doc = parseHtml(read('admin.html'));
    const win = fakeWindow({ fetch: net.fn as never, session: { [TOKEN_KEY]: token } });
    const app = boot({ doc, win });
    cleanupsE2e.push(() => app.stop());
    await net.drain();
    expect(app.state().signedIn).toBe(true);
    expect(app.state().currentTab).toBe('home');
    expect(doc.getElementById('reports-count')!.textContent).toBe('2');

    const step = 15_000;
    const until = async (minutes: number): Promise<void> => {
      while (clock - start < minutes * 60_000) {
        clock += step;
        vi.advanceTimersByTime(step);
        await net.drain();
        if (!app.state().signedIn) return;
      }
    };
    // 11 minutes: still signed in, but the ★ unlock from setup has run out (the page's refreshes did not renew it).
    await until(11);
    expect(app.state().signedIn).toBe(true);
    const me = await post(port, 'me', {}, token); // passive: this check does not move the clocks either
    expect(me.status).toBe(200);
    expect((me.json.session as { freshUntil: number }).freshUntil).toBeLessThanOrEqual(clock);
    expect(doc.getElementById('fresh-chip')!.textContent).toMatch(/locked/);
    // 29 minutes: still signed in; 31: the idle timeout has ended the session and the page shows the sign-in.
    await until(29);
    expect(app.state().signedIn).toBe(true);
    await until(31);
    expect(app.state().signedIn).toBe(false);
    expect(doc.getElementById('login-view')!.hidden).toBe(false);
    expect(win.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect((await post(port, 'log/reveal', { ids: [1] }, token)).status).toBe(401);
    // Nothing but passive routes was called by the page, and never the report list.
    expect(reportsCalls).toBe(0);
    for (const ep of new Set(net.endpoints)) expect(ADMIN_ROUTES[ep]?.passive, ep).toBe(true);
  }, 60_000);
});

describe('Presenting: a wellbeing row is the words only (§5.2, §5.11)', () => {
  const WB_LIVE = { seq: 5, ts: Date.now(), roomUid: 'b:r2', roomName: 'Flag Run', label: 'Flag Run · Crimson (team chat)', channel: 'team', team: 0, playerId: 0, name: '', accountId: null, shown: '', action: 'block', display: 'withheld', tags: ['SELF-HARM', 'THREAT'], wellbeing: true, online: false, chatId: 12, alertId: 4 };
  const WB_LOG = { id: 12, ts: Date.now() - 1000, roomId: 'r2', roomUid: 'b:r2', roomName: 'Flag Run', channel: 'team', team: 0, playerId: 0, name: '', accountId: null, shown: '', action: 'block', display: 'withheld', tags: ['SELF-HARM'] };
  const DETAIL = ['Flag Run', 'Crimson', 'team', 'SELF-HARM', 'THREAT', 'Blocked', 'Open', 'Opens with'];

  it('the renderers: no time, room, team, tags, action chip or button while Presenting; the default view keeps them', () => {
    const doc = parseHtml('<body></body>');
    const h = makeH(doc);
    const live = renderLiveLine(h, WB_LIVE, { presenting: true, caps: HOST_CAPS, on: { openWellbeing: () => undefined } });
    const log = renderLogRow(h, WB_LOG, { presenting: true, caps: HOST_CAPS, on: { openWellbeing: () => undefined } });
    expect(live.querySelectorAll('td')).toHaveLength(6);
    expect(log.querySelectorAll('td')).toHaveLength(7);
    for (const row of [live, log]) {
      expect(row.textContent).toBe(WELLBEING_TEXT);
      expect(row.querySelectorAll('button')).toHaveLength(0);
      expect(row.querySelectorAll('[title]')).toHaveLength(0);
    }
    expect(presentingWellbeingRow(h, 5, 2).querySelectorAll('td')[2]!.textContent).toBe(WELLBEING_TEXT);
    const def = renderLiveLine(h, WB_LIVE, { presenting: false, caps: HOST_CAPS, on: { openWellbeing: () => undefined } });
    expect(def.textContent).toContain('Flag Run · Crimson (team chat)');
    expect(buttonIn(def, 'Open ★')).toHaveLength(1);
  });

  it('Live, the Chat log and the Home alert list on the page', async () => {
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef', local: { [PREFS_KEY]: JSON.stringify({ presenting: true }) },
      routes: {
        me: meReply(), home: { body: { ...HOME.body, alerts: { urgent: 1, banner: 0, wellbeing: 1, wellbeingUrgent: 1, wellbeingBanner: 0 } } }, reports: { body: { ok: true, reports: [] } },
        'chat/live': (c) => ('after' in c.body ? new Promise(() => undefined) : { body: { ok: true, lines: [WB_LIVE], next: 5, gap: false } }),
        'log/stats': { body: { ok: true, rows: 1 } }, 'log/rooms': { body: { ok: true, rooms: [] } }, log: { body: { ok: true, lines: [WB_LOG], nextBefore: null } },
        'alerts/list': { body: { ok: true, alerts: [{ id: 4, kind: 'wellbeing', level: 'urgent', at: Date.now(), roomName: 'Flag Run', channel: 'team', chatId: 12, acked: false, wellbeing: true, tags: ['SELF-HARM', 'THREAT'], text: 'A wellbeing alert needs your attention' }] } },
      },
    });
    expect(p.app.state().presenting).toBe(true);
    expect(p.$('home-alerts').textContent).toContain('A wellbeing alert needs your attention');
    p.$('alerts-open').click();
    await settle();
    expect(p.$('alerts-body').textContent).toBe('A wellbeing alert needs your attention');
    p.$('tab-btn-live').click();
    await settle();
    expect(p.$('live-body').textContent).toBe(WELLBEING_TEXT);
    p.$('tab-btn-chat').click();
    await settle();
    expect(p.$('chat-body').textContent).toBe(WELLBEING_TEXT);
    for (const id of ['live-body', 'chat-body', 'alerts-body']) {
      const node = p.$(id);
      expect(node.querySelectorAll('button'), id).toHaveLength(0);
      expect(node.querySelectorAll('[title]'), id).toHaveLength(0);
      for (const d of DETAIL) expect(node.textContent, `${id}: ${d}`).not.toContain(d);
    }
  });
});

describe('Home alert line on the page', () => {
  it('an urgent threat plus a banner-level wellbeing alert: the urgent one is shown, the wellbeing one once', async () => {
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef',
      routes: { me: meReply(), reports: { body: { ok: true, reports: [] } }, home: { body: { ...HOME.body, alerts: { urgent: 1, banner: 1, wellbeing: 1, wellbeingUrgent: 0, wellbeingBanner: 1 } } } },
    });
    const line = p.$('home-alerts');
    expect(line.querySelectorAll('.alert-count').map((n) => n.textContent)).toEqual(['A wellbeing alert needs your attention', '1 urgent alert']);
    expect(line.querySelectorAll('.urgent').map((n) => n.textContent)).toEqual(['1 urgent alert']);
    expect(p.$('home-count').textContent).toBe('2');
  });
});

describe('the setup code leaves the address bar before anything else', () => {
  async function bootWith(o: { token?: string; routes: Record<string, Route> }) {
    const doc = parseHtml(read('admin.html'));
    const hashes: string[] = [];
    const holder: { win: ReturnType<typeof fakeWindow> | null } = { win: null };
    const f = fakeFetch(o.routes);
    const fetchFn = (url: string, init: never): Promise<unknown> => { hashes.push(holder.win!.location.hash); return f.fn(url, init); };
    const win = fakeWindow({ fetch: fetchFn as never, session: o.token ? { [TOKEN_KEY]: o.token } : {}, hash: '#setup=K7QP4MXD' });
    holder.win = win;
    const app = boot({ doc, win });
    cleanups.push(() => app.stop());
    await settle();
    return { doc, f, win, app, hashes, $: (id: string) => doc.getElementById(id)! };
  }

  it('a stale session in the tab: the setup screen opens with the code, which is gone from the URL before any request', async () => {
    const p = await bootWith({
      token: 'tok-stale-0123456789abcdef',
      routes: { me: { status: 401, body: { error: 'Not signed in' } }, 'setup/status': { body: { ok: true, needsSetup: true, kind: 'reset', retryAfter: 0, attemptsLeft: 5 } } },
    });
    expect(p.win.history.replaced).toEqual(['/']);
    expect(p.win.location.hash).toBe('');
    expect(p.hashes.length).toBeGreaterThan(0);
    expect(p.hashes.every((x) => x === '')).toBe(true);
    expect(p.$('setup-view').hidden).toBe(false);
    expect(p.$('login-view').hidden).toBe(true);
    expect(p.$('setup-code').value).toBe('K7QP-4MXD');
    expect(p.f.of('me')).toHaveLength(0); // setup is pending: the old session is not even tried
  });

  it('no setup pending (an old link): the stored session opens the panel; the code is still removed', async () => {
    const p = await bootWith({
      token: 'tok-host-0123456789abcdef',
      routes: { 'setup/status': { body: { ok: true, needsSetup: false } }, me: meReply(), home: HOME, reports: { body: { ok: true, reports: [] } } },
    });
    expect(p.win.history.replaced).toEqual(['/']);
    expect(p.hashes.every((x) => x === '')).toBe(true);
    expect(p.$('app-view').hidden).toBe(false);
    expect(p.app.state().signedIn).toBe(true);
  });

  it('a remote device (setup/status refused) with a stored session: the panel, never the code', async () => {
    const p = await bootWith({
      token: 'tok-host-0123456789abcdef',
      routes: { 'setup/status': { status: 403, body: { error: 'Host PC only' } }, me: meReply(), home: HOME, reports: { body: { ok: true, reports: [] } } },
    });
    expect(p.win.location.hash).toBe('');
    expect(p.$('app-view').hidden).toBe(false);
  });
});

describe('an answer lost on the way (a body-less 400 from the listener, read by Chrome on a stale connection)', () => {
  const lost = { status: 400, body: undefined };
  it('reads are sent once more; the sign-in, log/context, changes, reveals and exports never', async () => {
    expect(isLostAnswer(new ApiError(400, 'x'))).toBe(true);
    expect(isLostAnswer(new ApiError(400, 'Invalid JSON', { error: 'Invalid JSON' }))).toBe(false);
    for (const ep of LOST_ANSWER_RETRY) expect(ADMIN_ROUTES[ep]?.passive || ['log', 'log/rooms', 'log/stats', 'reports', 'bans', 'actions', 'whois', 'settings/get'].includes(ep), ep).toBe(true);
    // The sign-in: a lost answer may still have counted a password failure (5 block the address) or opened a session.
    // log/context: every read is an audit row of its own.
    for (const ep of ['login', 'log/context', 'setup', 'log/reveal', 'log/export', 'log/purge', 'bans/create', 'kick', 'warn', 'announce', 'reports/review', 'alerts/ack', 'settings/update', 'reauth', 'wellbeing/open']) expect(LOST_ANSWER_RETRY, ep).not.toContain(ep);
    // At most one retry.
    expect(LOST_ANSWER_TRIES).toBe(2);
    const f = seqFetch([lost, { status: 200, body: { ok: true, admin: { username: 'h' } } }]);
    const api = createApi({ fetchImpl: f.fn as never, getToken: () => 'tok-0123456789abcdef', onAuthLost: () => undefined });
    await expect(api.admin('me')).resolves.toMatchObject({ ok: true });
    expect(f.calls).toHaveLength(2);
    const g = seqFetch([lost, { status: 200, body: { ok: true, originals: [] } }]);
    const api2 = createApi({ fetchImpl: g.fn as never, getToken: () => 'tok-0123456789abcdef', onAuthLost: () => undefined });
    await expect(api2.admin('log/reveal', { ids: [1] })).rejects.toThrow(/interrupted/);
    expect(g.calls).toHaveLength(1);
    const k = seqFetch([lost]);
    const api3 = createApi({ fetchImpl: k.fn as never, getToken: () => 't', onAuthLost: () => undefined });
    await expect(api3.admin('home')).rejects.toBeInstanceOf(ApiError);
    expect(k.calls).toHaveLength(LOST_ANSWER_TRIES);
    const c = seqFetch([lost, { status: 200, body: { ok: true, anchor: null, before: [], after: [] } }]);
    const api5 = createApi({ fetchImpl: c.fn as never, getToken: () => 't', onAuthLost: () => undefined });
    await expect(api5.admin('log/context', { id: 1 })).rejects.toThrow(/interrupted/);
    expect(c.calls).toHaveLength(1);
    // The sign-in: sent once; the answer says to try again.
    const l = seqFetch([lost, { status: 200, body: { ok: true, token: 'tok-new-0123456789abcdef' } }]);
    const api4 = createApi({ fetchImpl: l.fn as never, getToken: () => null, onAuthLost: () => undefined });
    await expect(api4.login('host', 'hostadmin', PASS)).rejects.toThrow(/interrupted/);
    expect(l.calls.map((x) => x.url)).toEqual(['/api/admin/login']);
  });

  it("one click on Sign in is one login call, even when its answer is lost (the verifier's P4)", async () => {
    let n = 0;
    const p = await bootPanel({
      routes: {
        'setup/status': { body: { ok: true, needsSetup: false } },
        login: () => (++n < 6 ? lost : { status: 401, body: { error: 'Wrong username or password' } }),
      },
    });
    p.$('login-user').value = 'hostadmin';
    p.$('login-pass').value = 'wrong-generated-pass-xx';
    submit(p.$('login-form'));
    await settle(20);
    expect(p.f.of('login')).toHaveLength(1);
    expect(p.$('login-status').textContent).toMatch(/interrupted — try again/);
    expect(p.$('login-view').hidden).toBe(false);
  });

  it('setup whose answer was lost: never sent twice; if the login was made, the sign-in opens with the username', async () => {
    let status = 0;
    const p = await bootPanel({
      hash: '#setup=k7qp4mxd',
      routes: {
        'setup/status': () => (++status === 1 ? { body: { ok: true, needsSetup: true, kind: 'first', retryAfter: 0, attemptsLeft: 5 } } : status === 2 ? lost : { body: { ok: true, needsSetup: false } }),
        setup: lost,
      },
    });
    p.$('setup-user').value = 'hostadmin';
    p.$('setup-pass').value = PASS;
    p.$('setup-pass2').value = PASS;
    p.$('setup-home').click();
    p.$('setup-name').value = 'Den';
    submit(p.$('setup-form'));
    await settle();
    expect(p.f.of('setup')).toHaveLength(1);
    expect(p.f.of('setup/status')).toHaveLength(3); // the start, then the lost answer read again
    expect(p.$('login-view').hidden).toBe(false);
    expect(p.$('login-user').value).toBe('hostadmin');
    expect(p.$('login-status').textContent).toMatch(/Setup is done/);
    expect(p.$('setup-code').value).toBe('');
  });
});

// ====================================================================================================================
// B9 fixer round 2: late answers after Sign out, the step-up lapse, Presenting at sign-in, room names
// ====================================================================================================================

const MOD_CAPS = capabilitiesOf({ kind: 'moderator', tier: 'limited' });
const modMe = (): { body: Record<string, unknown> } => ({
  body: {
    ok: true, admin: { username: 'NovaMod', kind: 'moderator', accountId: 'acc-mod' },
    session: { principal: { kind: 'moderator', tier: 'limited' }, username: 'NovaMod', expiresAt: Date.now() + 30 * 60_000, idleSec: 1800, freshUntil: Date.now() + 10 * 60_000, capabilities: MOD_CAPS },
    capabilities: MOD_CAPS, banners: [],
  },
});
/** A route whose answer the test releases later (a busy worker). */
function held<T = FakeReplyLike>(): { route: Route; release: (r: T) => void; readonly asked: number } {
  let asked = 0;
  const waiting: ((r: T) => void)[] = [];
  return {
    route: () => { asked++; return new Promise((r) => { waiting.push(r as (r: T) => void); }) as never; },
    release: (r: T) => { for (const w of waiting.splice(0)) w(r); },
    get asked() { return asked; },
  };
}
type FakeReplyLike = { status?: number; body?: unknown };
const signOut = async (p: Panel): Promise<void> => { p.$('logout-btn').click(); await settle(); };
async function signInAs(p: Panel, role: 'host' | 'moderator', username: string): Promise<void> {
  p.$('login-user').value = username;
  p.$('login-pass').value = PASS;
  (role === 'moderator' ? p.$('login-role-mod') : p.$('login-role-host')).checked = true;
  submit(p.$('login-form'));
  await settle(20);
}

describe('answers that land after Sign out never reach the next view (verifier round 2, P2 / P2b / P6)', () => {
  it('createApi: an answer after the epoch changed is dropped — no data, no sign-out, no password prompt', async () => {
    let ep = 0;
    let lostCalls = 0;
    let reauthAsks = 0;
    const pending: ((r: unknown) => void)[] = [];
    const seen: (AbortSignal | undefined)[] = [];
    const ctrl = new AbortController();
    const fetchImpl = (_u: string, init: { signal?: AbortSignal }) => { seen.push(init.signal); return new Promise((r) => { pending.push(r); }); };
    const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body });
    const api = createApi({
      fetchImpl: fetchImpl as never, getToken: () => 'tok-0123456789abcdef', onAuthLost: () => { lostCalls++; }, onReauth: () => { reauthAsks++; return true; },
      epoch: () => ep, signal: () => ctrl.signal,
    });
    const reveal = api.admin('log/reveal', { ids: [1] });
    ep++;
    pending.shift()!(res(200, { ok: true, originals: [{ id: 1, original: SECRET }] }));
    await expect(reveal).rejects.toMatchObject({ status: 0, body: { code: 'aborted' } });
    // The old session's 401 is not the new session's sign-out.
    const me = api.admin('me');
    ep++;
    pending.shift()!(res(401, { error: 'Not signed in' }));
    await expect(me).rejects.toMatchObject({ body: { code: 'aborted' } });
    expect(lostCalls).toBe(0);
    // Its 401 `reauth` asks nobody for a password.
    const r2 = api.admin('log/reveal', { ids: [2] });
    ep++;
    pending.shift()!(res(401, { error: 'Enter your password again', code: 'reauth', reauth: true }));
    await expect(r2).rejects.toMatchObject({ body: { code: 'aborted' } });
    expect(reauthAsks).toBe(0);
    // Calls carry the session's signal unless they bring their own (the Live long-poll).
    const own = new AbortController();
    void api.admin('home').catch(() => undefined);
    void api.admin('chat/live', {}, { signal: own.signal }).catch(() => undefined);
    void api.login('host', 'hostadmin', PASS).catch(() => undefined);
    expect(seen.slice(-3)).toEqual([ctrl.signal, own.signal, undefined]);
  });

  it("P2: a Live reveal answered after Sign out is dropped; the moderator who signs in next never sees it", async () => {
    const reveal = held();
    let who: 'host' | 'mod' = 'host';
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef', ignoreAbort: true,
      routes: {
        me: () => (who === 'host' ? meReply() : modMe()), home: HOME, reports: { body: { ok: true, reports: [] } },
        'chat/live': liveRoute, 'log/reveal': reveal.route, logout: { body: { ok: true } },
        login: { body: { ok: true, token: 'tok-mod-0123456789abcdef', session: null } }, 'setup/status': { status: 403, body: { error: 'Setup only works on the host PC' } },
      },
    });
    p.$('tab-btn-live').click();
    await settle();
    buttonIn(p.$('live-body'), 'Reveal ★')[0]!.click();
    await settle();
    expect(reveal.asked).toBe(1);
    const revealCall = p.f.of('log/reveal')[0]!;
    await signOut(p);
    // The worker is slow: the moderator has signed in on this tab before the host's reveal is answered.
    who = 'mod';
    await signInAs(p, 'moderator', 'NovaMod');
    expect(p.app.state().signedIn).toBe(true);
    expect(p.app.state().caps).not.toContain('reveal');
    reveal.release({ body: { ok: true, originals: [{ id: 11, original: SECRET }] } });
    await settle();
    expect(p.app.state().revealed.size).toBe(0);
    expect(p.$('live-body').textContent).toContain('Great flying, everyone!');
    expect(pageText(p.doc)).not.toContain(SECRET);
    expect(revealCall.url).toBe('/api/admin/log/reveal');
  });

  it('P2 (answered while signed out): dropped too, and the next sign-in starts with nothing revealed', async () => {
    const reveal = held();
    let who: 'host' | 'mod' = 'host';
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef', ignoreAbort: true,
      routes: {
        me: () => (who === 'host' ? meReply() : modMe()), home: HOME, reports: { body: { ok: true, reports: [] } },
        'chat/live': liveRoute, 'log/reveal': reveal.route, logout: { body: { ok: true } },
        login: { body: { ok: true, token: 'tok-mod-0123456789abcdef', session: null } }, 'setup/status': { status: 403, body: { error: 'x' } },
      },
    });
    p.$('tab-btn-live').click();
    await settle();
    buttonIn(p.$('live-body'), 'Reveal ★')[0]!.click();
    await settle();
    await signOut(p);
    reveal.release({ body: { ok: true, originals: [{ id: 11, original: SECRET }] } });
    await settle();
    expect(p.app.state().revealed.size).toBe(0);
    who = 'mod';
    await signInAs(p, 'moderator', 'NovaMod');
    expect(p.app.state().revealed.size).toBe(0);
    expect(pageText(p.doc)).not.toContain(SECRET);
  });

  it('P2 (the browser path): Sign out aborts the calls still in flight', async () => {
    const reveal = held();
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef',
      routes: { me: meReply(), home: HOME, reports: { body: { ok: true, reports: [] } }, 'chat/live': liveRoute, 'log/reveal': reveal.route, logout: { body: { ok: true } }, 'setup/status': { status: 403, body: { error: 'x' } } },
    });
    p.$('tab-btn-live').click();
    await settle();
    buttonIn(p.$('live-body'), 'Reveal ★')[0]!.click();
    await settle();
    const call = p.f.of('log/reveal')[0]!;
    expect(call.signal?.aborted).toBe(false);
    await signOut(p);
    expect(call.signal?.aborted).toBe(true);
    reveal.release({ body: { ok: true, originals: [{ id: 11, original: SECRET }] } });
    await settle();
    expect(pageText(p.doc)).not.toContain(SECRET);
    expect(p.$('toasts').textContent).not.toMatch(/Reveal/);
  });

  it('P2b: a wellbeing/open answered after Sign out opens nothing over the sign-in screen', async () => {
    const open = held();
    const WB = { ...LIVE_LINES[1]! };
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef', ignoreAbort: true,
      routes: {
        me: meReply(), home: HOME, reports: { body: { ok: true, reports: [] } }, logout: { body: { ok: true } }, 'setup/status': { status: 403, body: { error: 'x' } },
        'chat/live': (c) => ('after' in c.body ? new Promise(() => undefined) : { body: { ok: true, lines: [WB], next: 102, gap: false } }),
        'wellbeing/open': open.route,
      },
    });
    p.$('tab-btn-live').click();
    await settle();
    buttonIn(p.$('live-body'), 'Open ★')[0]!.click();
    await settle();
    expect(open.asked).toBe(1);
    await signOut(p);
    open.release({ body: { ok: true, student: { username: 'KiddoStudent' }, line: { ts: Date.now(), original: SECRET, roomName: 'Arena' }, context: [] } });
    await settle();
    expect(p.$('login-view').hidden).toBe(false);
    expect(p.$('dlg').open).toBe(false);
    expect(pageText(p.doc)).not.toContain('KiddoStudent');
    expect(pageText(p.doc)).not.toContain(SECRET);
  });

  it('P2b (the 501 fallback): Sign out between its steps stops it — no context read, no dialog', async () => {
    const reveal = held();
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef', ignoreAbort: true,
      routes: {
        me: meReply(), home: HOME, reports: { body: { ok: true, reports: [] } }, logout: { body: { ok: true } }, 'setup/status': { status: 403, body: { error: 'x' } },
        'chat/live': (c) => ('after' in c.body ? new Promise(() => undefined) : { body: { ok: true, lines: [LIVE_LINES[1]], next: 102, gap: false } }),
        'wellbeing/open': { status: 501, body: { error: 'Not in this version yet.' } },
        'log/reveal': reveal.route,
        'log/context': { body: { ok: true, anchor: { id: 12, ts: Date.now(), name: 'KiddoStudent', roomName: 'Arena' }, before: [], after: [], scope: 'room' } },
      },
    });
    p.$('tab-btn-live').click();
    await settle();
    buttonIn(p.$('live-body'), 'Open ★')[0]!.click();
    await settle();
    expect(reveal.asked).toBe(1);
    await signOut(p);
    reveal.release({ body: { ok: true, originals: [{ id: 12, original: SECRET }] } });
    await settle();
    expect(p.f.of('log/context')).toHaveLength(0);
    expect(p.$('dlg').open).toBe(false);
    expect(p.app.state().revealed.size).toBe(0);
    expect(pageText(p.doc)).not.toContain(SECRET);
  });

  it('P6: a context answered after Sign out does not open the drawer over the sign-in screen', async () => {
    const context = held();
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef', ignoreAbort: true,
      routes: {
        me: meReply(), home: HOME, reports: { body: { ok: true, reports: [] } }, logout: { body: { ok: true } }, 'setup/status': { status: 403, body: { error: 'x' } },
        'log/stats': { body: { ok: true, rows: 2 } }, 'log/rooms': { body: { ok: true, rooms: [] } }, log: { body: { ok: true, lines: LOG_ROWS, nextBefore: null } },
        'log/context': context.route,
      },
    });
    p.$('tab-btn-chat').click();
    await settle();
    buttonIn(p.$('chat-body'), 'Context')[0]!.click();
    await settle();
    expect(context.asked).toBe(1);
    await signOut(p);
    context.release({ body: { ok: true, anchor: LOG_ROWS[0], before: [{ ...LOG_ROWS[1], id: 10, name: 'VegaWing', shown: 'hello there' }], after: [], scope: 'room' } });
    await settle();
    expect(p.$('ctx-dlg').open).toBe(false);
    expect(p.$('login-view').hidden).toBe(false);
    expect(p.$('ctx-body').textContent).toBe('');
    expect(pageText(p.doc)).not.toContain('192.168.1.23');
    expect(pageText(p.doc)).not.toContain('hello there');
  });

  it("an old session's 401 that lands after the next sign-in does not sign that person out", async () => {
    const oldLog = held();
    let who: 'host' | 'mod' = 'host';
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef', ignoreAbort: true,
      routes: {
        me: () => (who === 'host' ? meReply() : modMe()), home: HOME, reports: { body: { ok: true, reports: [] } }, 'chat/live': liveRoute,
        'log/stats': { body: { ok: true, rows: 2 } }, 'log/rooms': { body: { ok: true, rooms: [] } }, log: oldLog.route,
        logout: { body: { ok: true } }, login: { body: { ok: true, token: 'tok-mod-0123456789abcdef', session: null } }, 'setup/status': { status: 403, body: { error: 'x' } },
      },
    });
    p.$('tab-btn-chat').click();
    await settle();
    expect(oldLog.asked).toBe(1);
    await signOut(p);
    who = 'mod';
    await signInAs(p, 'moderator', 'NovaMod');
    expect(p.app.state().signedIn).toBe(true);
    oldLog.release({ status: 401, body: { error: 'Your session ended' } });
    await settle();
    expect(p.app.state().signedIn).toBe(true);
    expect(p.win.sessionStorage.getItem(TOKEN_KEY)).toBe('tok-mod-0123456789abcdef');
    expect(p.$('app-view').hidden).toBe(false);
  });
});

describe('the ★ window lapses: what a reveal showed leaves the page (§4.10; verifier round 2, P1)', () => {
  it('Chat log and Live: the originals go when `me` says the session is stale; Reveal ★ is offered again', async () => {
    let fresh = true;
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef',
      routes: {
        me: () => meReply(hostSession(fresh ? 10 * 60_000 : 0)), home: HOME, reports: { body: { ok: true, reports: [] } }, 'chat/live': liveRoute,
        'log/stats': { body: { ok: true, rows: 2 } }, 'log/rooms': { body: { ok: true, rooms: [] } }, log: { body: { ok: true, lines: LOG_ROWS, nextBefore: null } },
        'log/reveal': (c) => ({ body: { ok: true, originals: (c.body.ids as number[]).map((id) => ({ id, original: id === 11 ? SECRET : 'other' })) } }),
      },
    });
    p.$('tab-btn-chat').click();
    await settle();
    buttonIn(p.$('chat-body'), 'Reveal ★')[0]!.click();
    await settle();
    expect(p.$('chat-body').textContent).toContain(`Typed: ${SECRET}`);
    // The reveal read `me` again (the ★ call refreshed the server's window): still fresh, still shown.
    expect(p.f.of('me').length).toBeGreaterThanOrEqual(2);
    p.doc.dispatchEvent(new FakeEvent('visibilitychange'));
    await settle();
    expect(p.$('chat-body').textContent).toContain(`Typed: ${SECRET}`);
    fresh = false;
    p.doc.dispatchEvent(new FakeEvent('visibilitychange'));
    await settle();
    expect(p.$('fresh-chip').textContent).toMatch(/locked/);
    expect(p.app.state().revealed.size).toBe(0);
    expect(pageText(p.doc)).not.toContain(SECRET);
    expect(buttonIn(p.$('chat-body'), 'Reveal ★').length).toBe(2);
    p.$('tab-btn-live').click();
    await settle();
    expect(pageText(p.doc)).not.toContain(SECRET);
    expect(p.app.state().signedIn).toBe(true);
  });

  it('the clock alone: no call needed, the originals go when freshUntil passes', async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: t0 });
    try {
      const p = await bootPanel({
        token: 'tok-host-0123456789abcdef',
        routes: {
          // A `me` that keeps the first freshUntil (the server's window is not extended: nothing deliberate happened).
          me: meReply({ ...hostSession(), freshUntil: t0 + 60_000, expiresAt: t0 + 30 * 60_000 }), home: HOME, reports: { body: { ok: true, reports: [] } }, 'chat/live': liveRoute,
          'log/stats': { body: { ok: true, rows: 2 } }, 'log/rooms': { body: { ok: true, rooms: [] } }, log: { body: { ok: true, lines: LOG_ROWS, nextBefore: null } },
          'log/reveal': () => ({ body: { ok: true, originals: [{ id: 11, original: SECRET }] } }),
        },
      });
      p.$('tab-btn-chat').click();
      await settle();
      buttonIn(p.$('chat-body'), 'Reveal ★')[0]!.click();
      await settle();
      expect(p.$('chat-body').textContent).toContain(SECRET);
      vi.advanceTimersByTime(61_000);
      await settle();
      expect(p.$('fresh-chip').textContent).toMatch(/locked/);
      expect(pageText(p.doc)).not.toContain(SECRET);
    } finally { vi.useRealTimers(); }
  });

  it('an open wellbeing dialog closes, and the context drawer keeps its lines but loses their originals', async () => {
    let fresh = true;
    const WB = { ...LIVE_LINES[1]! };
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef',
      routes: {
        me: () => meReply(hostSession(fresh ? 10 * 60_000 : 0)), home: HOME, reports: { body: { ok: true, reports: [] } },
        'chat/live': (c) => ('after' in c.body ? new Promise(() => undefined) : { body: { ok: true, lines: [WB, LIVE_LINES[0]], next: 102, gap: false } }),
        'wellbeing/open': { body: { ok: true, student: { username: 'KiddoStudent' }, line: { ts: Date.now(), original: 'WB-TYPED-zz1', roomName: 'Arena' }, context: [] } },
        'log/reveal': () => ({ body: { ok: true, originals: [{ id: 11, original: SECRET }] } }),
        'log/context': { body: { ok: true, anchor: LOG_ROWS[0], before: [{ ...LOG_ROWS[1], id: 10, shown: 'hello there' }], after: [], scope: 'room' } },
      },
    });
    p.$('tab-btn-live').click();
    await settle();
    buttonIn(p.$('live-body'), 'Open ★')[0]!.click();
    await settle();
    expect(p.$('dlg').open).toBe(true);
    expect(p.$('dlg-target').textContent).toContain('WB-TYPED-zz1');
    fresh = false;
    p.doc.dispatchEvent(new FakeEvent('visibilitychange'));
    await settle();
    expect(p.$('dlg').open).toBe(false);
    expect(pageText(p.doc)).not.toContain('KiddoStudent');
    expect(pageText(p.doc)).not.toContain('WB-TYPED-zz1');
    // Fresh again (the password was given): a context drawer with a revealed line, then a lapse.
    fresh = true;
    p.doc.dispatchEvent(new FakeEvent('visibilitychange'));
    await settle();
    buttonIn(p.$('live-body'), 'Context')[0]!.click();
    await settle();
    expect(p.$('ctx-dlg').open).toBe(true);
    buttonIn(p.$('ctx-body'), 'Reveal ★')[0]!.click();
    await settle();
    expect(p.$('ctx-body').textContent).toContain(SECRET);
    fresh = false;
    p.doc.dispatchEvent(new FakeEvent('visibilitychange'));
    await settle();
    expect(p.$('ctx-dlg').open).toBe(true);
    expect(p.$('ctx-body').textContent).toContain('hello there');
    expect(pageText(p.doc)).not.toContain(SECRET);
  });
});

describe('Presenting at sign-in follows School for every role, and fails closed (verifier round 2, P3)', () => {
  const schoolHome = { body: { ...HOME.body, presentingAtLogin: true } };
  it('a limited moderator signing in on a School server starts with Presenting on', async () => {
    const p = await bootPanel({
      routes: {
        'setup/status': { status: 403, body: { error: 'x' } }, login: { body: { ok: true, token: 'tok-mod-0123456789abcdef', session: null } },
        me: modMe(), home: { body: { ok: true, counts: { online: 1, rooms: 1, playing: 0 }, presentingAtLogin: true } }, reports: { body: { ok: true, reports: [] } },
        'chat/live': liveRoute,
      },
    });
    await signInAs(p, 'moderator', 'NovaMod');
    expect(p.app.state().signedIn).toBe(true);
    expect(p.app.state().presenting).toBe(true);
    expect(p.f.of('home').length).toBeGreaterThanOrEqual(1);
    expect(p.$('live-body').textContent).not.toContain('NovaPilot');
    expect(p.$('live-body').textContent).toContain(PRESENT_NAME);
  });

  it('a moderator on a Home server: off (the default stands)', async () => {
    const p = await bootPanel({
      routes: {
        'setup/status': { status: 403, body: { error: 'x' } }, login: { body: { ok: true, token: 'tok-mod-0123456789abcdef', session: null } },
        me: modMe(), home: { body: { ok: true, counts: { online: 1, rooms: 1, playing: 0 }, presentingAtLogin: false } }, reports: { body: { ok: true, reports: [] } }, 'chat/live': liveRoute,
      },
    });
    await signInAs(p, 'moderator', 'NovaMod');
    expect(p.app.state().presenting).toBe(false);
  });

  it("a `home` without the flag (the verifier's P3 reply) says nothing about School: Presenting starts on", async () => {
    const p = await bootPanel({
      routes: {
        'setup/status': { status: 403, body: { error: 'x' } }, login: { body: { ok: true, token: 'tok-mod-0123456789abcdef', session: null } },
        me: modMe(), home: { body: { ok: true, counts: { online: 1, rooms: 1, playing: 0 } } }, reports: { body: { ok: true, reports: [] } }, 'chat/live': liveRoute,
      },
    });
    await signInAs(p, 'moderator', 'NovaMod');
    expect(p.app.state().presenting).toBe(true);
    expect(p.$('live-body').textContent).not.toContain('NovaPilot');
    expect(p.win.localStorage.getItem(PREFS_KEY)).toBeNull();
  });

  it('a host whose sign-in `home` read fails starts with Presenting on (not remembered); School still on when it works', async () => {
    const p = await bootPanel({
      routes: {
        'setup/status': { body: { ok: true, needsSetup: false } }, login: { body: { ok: true, token: 'tok-host-0123456789abcdef', session: null } },
        me: meReply(), home: { status: 503, body: { error: 'busy' } }, reports: { body: { ok: true, reports: [] } }, 'chat/live': liveRoute,
      },
    });
    await signInAs(p, 'host', 'hostadmin');
    expect(p.app.state().signedIn).toBe(true);
    expect(p.app.state().presenting).toBe(true);
    expect(p.win.localStorage.getItem(PREFS_KEY)).toBeNull();
    // Switching it off right after the sign-in needs no password (fresh).
    p.$('presenting-btn').click();
    await settle();
    expect(p.app.state().presenting).toBe(false);
    expect(p.$('reauth-dlg').open).toBe(false);

    const q = await bootPanel({
      routes: {
        'setup/status': { body: { ok: true, needsSetup: false } }, login: { body: { ok: true, token: 'tok-host-0123456789abcdef', session: null } },
        me: meReply(), home: schoolHome, reports: { body: { ok: true, reports: [] } },
      },
    });
    await signInAs(q, 'host', 'hostadmin');
    expect(q.app.state().presenting).toBe(true);
  });

  it('a host sign-in whose `home` says 401 goes back to the sign-in (it never opens the app)', async () => {
    let meCalls = 0;
    const p = await bootPanel({
      routes: {
        'setup/status': { body: { ok: true, needsSetup: false } }, login: { body: { ok: true, token: 'tok-host-0123456789abcdef', session: null } },
        me: () => { meCalls++; return meReply(); }, home: { status: 401, body: { error: 'Your session ended' } }, reports: { body: { ok: true, reports: [] } },
      },
    });
    await signInAs(p, 'host', 'hostadmin');
    expect(meCalls).toBe(1);
    expect(p.app.state().signedIn).toBe(false);
    expect(p.$('login-view').hidden).toBe(false);
    expect(p.$('app-view').hidden).toBe(true);
  });
});

describe('Presenting shows rooms by number, never by name (a room is named after its creator; verifier round 2, P5)', () => {
  const NAMED = { ...LIVE_LINES[0]!, roomName: "NovaPilot's Arena", label: "NovaPilot's Arena · Crimson" };
  const NAMED_ROW = { ...LOG_ROWS[0]!, roomName: "NovaPilot's Arena" };
  it('presentingRoomLabel and whereLabel', () => {
    expect(presentingRoomLabel({ roomId: 'r2', roomName: "NovaPilot's Arena" })).toBe('Room 2');
    expect(presentingRoomLabel({ roomUid: 'k3j9:r14' })).toBe('Room 14');
    expect(presentingRoomLabel({ roomName: 'x' })).toBe('Room');
    expect(whereLabel(NAMED)).toBe("NovaPilot's Arena · Crimson");
    expect(whereLabel(NAMED, true)).toBe('Room 2 · Crimson');
    expect(whereLabel({ ...NAMED_ROW, channel: 'team', team: 1 }, true)).toBe('Room 2 · Azure (team chat)');
    expect(whereLabel({ roomUid: 'b:zone', channel: 'all', team: -1 }, true)).toBe('Zone lobby');
  });

  it('Live, the Chat log and their room filters on the page', async () => {
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef', local: { [PREFS_KEY]: JSON.stringify({ presenting: true }) },
      routes: {
        me: meReply(), home: HOME, reports: { body: { ok: true, reports: [] } },
        'chat/live': (c) => ('after' in c.body ? new Promise(() => undefined) : { body: { ok: true, lines: [NAMED], next: 101, gap: false } }),
        'log/stats': { body: { ok: true, rows: 1 } }, 'log/rooms': { body: { ok: true, rooms: [{ roomUid: 'b:r2', roomId: 'r2', name: "NovaPilot's Arena", firstTs: Date.now() - 1000, lastTs: Date.now() }] } },
        log: { body: { ok: true, lines: [NAMED_ROW], nextBefore: null } },
      },
    });
    expect(p.app.state().presenting).toBe(true);
    p.$('tab-btn-live').click();
    await settle();
    expect(p.$('live-body').textContent).toContain('Room 2 · Crimson');
    p.$('tab-btn-chat').click();
    await settle();
    expect(p.$('chat-body').textContent).toContain('Room 2');
    expect(pageText(p.doc)).not.toContain('NovaPilot');
    // Presenting off (fresh session): the names are back for the host.
    p.$('presenting-btn').click();
    await settle();
    expect(p.app.state().presenting).toBe(false);
    expect(p.$('chat-body').textContent).toContain("NovaPilot's Arena");
    expect(p.$('chat-room').textContent).toContain("NovaPilot's Arena");
    expect(p.$('live-room').textContent).toContain("NovaPilot's Arena");
  });
});

// ====================================================================================================================
// 0.6.0-m1.1: banner buttons for a host without administrator rights ("Don't warn me again", the firewall's Dismiss)
// ====================================================================================================================

describe('banner buttons (0.6.0-m1.1)', () => {
  const PERM = { code: 'permissions', level: 'warn', text: "Other accounts on this PC can change Voidswarm's files or read its data." };
  const FIREWALL = { code: 'preflight-firewall-blocked', level: 'warn', text: "Other devices probably can't connect: Windows Firewall has no rule allowing Voidswarm on this network (the Domain profile)." };
  const OTHER = { code: 'x', level: 'warn', text: 'No recovery file yet.' };
  const meWith = (banners: unknown[], session = hostSession()) => ({ body: { ...meReply(session).body, banners } });

  it('bannerAction: by code; the setting needs the settings capability; unknown codes and inherited keys have none', () => {
    expect(bannerAction(PERM, HOST_CAPS)).toMatchObject({ kind: 'setting', label: "Don't warn me again", patch: { launcher: { permissions: 'off' } } });
    expect(bannerAction({ code: 'permissions-unchecked' }, HOST_CAPS)).toBe(BANNER_ACTIONS.permissions);
    expect(bannerAction(PERM, MOD_CAPS)).toBeNull();
    expect(bannerAction(FIREWALL, MOD_CAPS)).toMatchObject({ kind: 'session', label: 'Dismiss' });
    for (const b of [OTHER, { code: 'toString' }, { code: '__proto__' }, {}, null, { text: 'x' }]) expect(bannerAction(b, HOST_CAPS)).toBeNull();
  });

  it('"Don\'t warn me again": settings/get, then settings/update with its rev and launcher.permissions = off; the banner goes now and stays gone', async () => {
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef',
      routes: {
        me: meWith([PERM, OTHER]), home: HOME, reports: { body: { ok: true, reports: [], nextBefore: null } },
        'settings/get': { body: { ok: true, rev: 7, settings: { preset: 'home', launcher: { elevated: 'warn', permissions: 'warn' } } } },
        'settings/update': { body: { ok: true, rev: 8 } },
      },
    });
    const banners = p.$('banners');
    expect(banners.textContent).toContain("Other accounts on this PC can change Voidswarm's files");
    const btn = buttonIn(banners, "Don't warn me again");
    expect(btn).toHaveLength(1);
    expect(buttonIn(banners, 'Dismiss')).toHaveLength(0); // the other banner has no button
    btn[0]!.click();
    await settle();
    expect(p.f.of('settings/get')).toHaveLength(1);
    expect(p.f.of('settings/update').map((c) => c.body)).toEqual([{ rev: 7, patch: { launcher: { permissions: 'off' } } }]);
    expect(banners.textContent).not.toContain("Other accounts on this PC can change Voidswarm's files");
    expect(banners.textContent).toContain('No recovery file yet.');
    expect(p.$('toasts').textContent).toMatch(/won't check who can reach its folder/);
  });

  it('"Don\'t warn me again": a 409 (changed in between) reads the rev again once; a failure keeps the banner and says why', async () => {
    let updates = 0;
    const p = await bootPanel({
      token: 'tok-host-0123456789abcdef',
      routes: {
        me: meWith([PERM]), home: HOME, reports: { body: { ok: true, reports: [], nextBefore: null } },
        'settings/get': () => ({ body: { ok: true, rev: 7 + updates, settings: {} } }),
        'settings/update': () => (++updates === 1 ? { status: 409, body: { error: 'The settings changed.', rev: 8 } } : { status: 500, body: { error: 'Disk full.' } }),
      },
    });
    buttonIn(p.$('banners'), "Don't warn me again")[0]!.click();
    await settle(16);
    expect(p.f.of('settings/update').map((c) => c.body.rev)).toEqual([7, 8]);
    expect(p.$('banners').textContent).toContain("Other accounts on this PC can change Voidswarm's files");
    expect(buttonIn(p.$('banners'), "Don't warn me again")[0]!.disabled).toBe(false);
    expect(p.$('toasts').textContent).toContain('Disk full.');
  });

  it('a moderator sees the permission banner (if sent) without the button; the firewall banner\'s Dismiss hides it for this tab only', async () => {
    const mod = await bootPanel({ token: 'tok-mod-0123456789abcdef', routes: { me: { body: { ...modMe().body, banners: [PERM] } }, reports: { body: { ok: true, reports: [] } } } });
    expect(buttonIn(mod.$('banners'), "Don't warn me again")).toHaveLength(0);

    const p = await bootPanel({ token: 'tok-host-0123456789abcdef', routes: { me: meWith([FIREWALL, OTHER]), home: HOME, reports: { body: { ok: true, reports: [], nextBefore: null } } } });
    expect(p.$('banners').textContent).toContain("Other devices probably can't connect");
    buttonIn(p.$('banners'), 'Dismiss')[0]!.click();
    await settle();
    expect(p.$('banners').textContent).not.toContain("Other devices probably can't connect");
    expect(p.$('banners').textContent).toContain('No recovery file yet.');
    expect(p.f.of('settings/update')).toHaveLength(0); // nothing saved on the server
    expect(JSON.parse(p.win.sessionStorage.getItem(DISMISSED_KEY) ?? '[]')).toEqual(['preflight-firewall-blocked']);

    // A new tab (its own sessionStorage): shown again while it is still true (the next test: the same tab).
    const again = await bootPanel({ token: 'tok-host-0123456789abcdef', routes: { me: meWith([FIREWALL]), home: HOME, reports: { body: { ok: true, reports: [], nextBefore: null } } } });
    expect(again.$('banners').textContent).toContain("Other devices probably can't connect");
  });

  it('a dismissal remembered in this tab hides the firewall banner from the start', async () => {
    const doc = parseHtml(read('admin.html'));
    const f = fakeFetch({ me: meWith([FIREWALL]), home: HOME, reports: { body: { ok: true, reports: [], nextBefore: null } } });
    const win = fakeWindow({ fetch: f.fn as never, session: { [TOKEN_KEY]: 'tok-host-0123456789abcdef', [DISMISSED_KEY]: JSON.stringify(['preflight-firewall-blocked']) } });
    const app = boot({ doc, win });
    cleanups.push(() => app.stop());
    await settle();
    expect(doc.getElementById('banners')!.textContent).not.toContain("Other devices probably can't connect");
  });

  it('the page wires the buttons with listeners (no inline handlers: the CSP)', () => {
    const js = read('admin.js');
    expect(js).toContain("btn.addEventListener('click'");
    expect(read('admin.html')).not.toMatch(/\son[a-z]+=/i);
  });
});
