// OWNER: ADMIN DASHBOARD builder. Tests for the dashboard's pure helpers + API client (node, no DOM), plus static
// checks that the page stays CSP-safe (no inline script / handlers) and never renders markup from strings.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  ApiError, CHAT_ACTIONS, DEFAULT_DURATION, DURATION_PRESETS, ENDPOINTS, TOKEN_KEY,
  actionDurationText, actionTargetText, banCreateBody, banTargetText, buildLogQuery, chatActionInfo, chatRowClass,
  checkReason, cleanText, createApi, createTokenStore, errorText, formatDateTime, formatExpiry, formatShortTime,
  formatSpan, isDashboardRead, latestOnly, manualBanBody, nextTabIndex, pagerCursor, pagerInit, pagerLabel, pagerLoaded,
  pagerNewer, pagerOlder, parseLocalDateTime, scopeChoices, toSubject,
} from './admin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string): string => readFileSync(path.join(here, f), 'utf8');

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
    };
  });
  return { fn, calls };
}

describe('durations', () => {
  it('offers exactly the classroom presets, with safe defaults', () => {
    expect(DURATION_PRESETS.map((p) => p.id)).toEqual(['10m', '1h', '1d', '7d', 'perm']);
    expect(DEFAULT_DURATION).toEqual({ ban: '1d', mute: '10m' });
  });
});

describe('formatting', () => {
  it('formatSpan uses at most two units', () => {
    expect(formatSpan(0)).toBe('0s');
    expect(formatSpan(45_000)).toBe('45s');
    expect(formatSpan(12 * 60_000)).toBe('12m');
    expect(formatSpan(3 * 3600_000 + 5 * 60_000)).toBe('3h 5m');
    expect(formatSpan(3600_000)).toBe('1h');
    expect(formatSpan(2 * 86400_000 + 4 * 3600_000 + 59 * 60_000)).toBe('2d 4h');
    expect(formatSpan(7 * 86400_000)).toBe('7d');
    expect(formatSpan(-1)).toBe('—');
    expect(formatSpan(Number.NaN)).toBe('—');
  });

  it('formatExpiry: permanent / ended / remaining', () => {
    const now = 1_700_000_000_000;
    expect(formatExpiry(null, now)).toBe('Permanent');
    expect(formatExpiry(undefined, now)).toBe('Permanent');
    expect(formatExpiry(now - 1, now)).toBe('Ended');
    expect(formatExpiry(now + 90 * 60_000, now)).toBe('in 1h 30m');
  });

  it('formatDateTime / formatShortTime are local and reject junk', () => {
    const t = new Date(2026, 8, 27, 9, 5, 7).getTime();
    expect(formatDateTime(t)).toBe('2026-09-27 09:05:07');
    expect(formatShortTime(t, new Date(2026, 8, 27, 23, 0, 0).getTime())).toBe('09:05:07');
    expect(formatShortTime(t, new Date(2026, 10, 1).getTime())).toBe('09-27 09:05');
    expect(formatShortTime(t, new Date(2027, 0, 1).getTime())).toBe('2026-09-27');
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('2026')).toBe('—');
    expect(formatDateTime(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('parseLocalDateTime round-trips datetime-local values and rejects impossible dates', () => {
    const ms = parseLocalDateTime('2026-09-27T14:30');
    expect(ms).toBe(new Date(2026, 8, 27, 14, 30, 0).getTime());
    expect(parseLocalDateTime('2026-09-27T14:30:15')).toBe(new Date(2026, 8, 27, 14, 30, 15).getTime());
    expect(parseLocalDateTime('2026-02-31T10:00')).toBeNull();
    expect(parseLocalDateTime('yesterday')).toBeNull();
    expect(parseLocalDateTime('')).toBeNull();
    expect(parseLocalDateTime(undefined)).toBeNull();
  });

  it('cleanText trims, strips control characters and caps length', () => {
    expect(cleanText('  hi\u0000there\n ', 50)).toBe('hi there');
    expect(cleanText('abcdef', 3)).toBe('abc');
    expect(cleanText(42, 10)).toBe('');
  });
});

describe('chat actions', () => {
  it('knows every contract action; blocked / spam / muted are "not shown"', () => {
    expect(Object.keys(CHAT_ACTIONS).sort()).toEqual(['block', 'flag', 'mask', 'muted', 'pass', 'spam']);
    expect(chatActionInfo('flag')).toMatchObject({ id: 'flag', label: 'For review', hidden: false });
    expect(chatActionInfo('block')).toMatchObject({ id: 'block', hidden: true });
    expect(chatActionInfo('spam').hidden).toBe(true);
    expect(chatActionInfo('muted').hidden).toBe(true);
    expect(chatActionInfo('mask').hidden).toBe(false);
    expect(chatActionInfo('pass').hidden).toBe(false);
    expect(chatActionInfo('toString').id).toBe('unknown'); // no prototype lookups
    expect(chatActionInfo(undefined).id).toBe('unknown');
  });

  it('highlights blocked rows', () => {
    expect(chatRowClass('block')).toBe('row-block');
    expect(chatRowClass('mask')).toBe('row-mask');
    expect(chatRowClass('spam')).toBe('row-spam');
    expect(chatRowClass('muted')).toBe('row-spam');
    expect(chatRowClass('flag')).toBe('row-flag');
    expect(chatRowClass('pass')).toBe('');
  });
});

describe('buildLogQuery', () => {
  it('sends only the fields that are set', () => {
    const r = buildLogQuery({ player: ' Bob ', grep: '', address: '', roomId: '', action: '', range: '' }, null);
    expect(r.query).toEqual({ player: 'Bob', limit: 50 });
  });

  it('maps a quick range to a duration and the cursor to before', () => {
    const r = buildLogQuery({ grep: 'hello', action: 'flagged', range: '1d', roomId: 'r7' }, 1234, 25);
    expect(r.query).toEqual({ grep: 'hello', action: 'flagged', since: '1d', roomId: 'r7', limit: 25, before: 1234 });
    expect(buildLogQuery({ action: 'flag' }, null).query).toEqual({ action: 'flag', limit: 50 });
  });

  it('custom range → since / until in ms; validates order and format', () => {
    const ok = buildLogQuery({ range: 'custom', from: '2026-09-27T08:00', to: '2026-09-27T09:00' }, null);
    expect(ok.query?.since).toBe(new Date(2026, 8, 27, 8, 0).getTime());
    expect(ok.query?.until).toBe(new Date(2026, 8, 27, 9, 0).getTime());
    expect(buildLogQuery({ range: 'custom', from: '2026-09-27T10:00', to: '2026-09-27T09:00' }, null).error).toMatch(/before/);
    expect(buildLogQuery({ range: 'custom', from: 'nope' }, null).error).toMatch(/From/);
    expect(buildLogQuery({ range: 'custom' }, null).query).toEqual({ limit: 50 });
  });

  it('rejects unknown actions / ranges and caps text lengths', () => {
    expect(buildLogQuery({ action: 'drop table' }, null).error).toBeTruthy();
    expect(buildLogQuery({ range: 'forever' }, null).error).toBeTruthy();
    const long = buildLogQuery({ grep: 'x'.repeat(500), player: 'y'.repeat(500) }, null);
    expect(String(long.query?.grep).length).toBe(100);
    expect(String(long.query?.player).length).toBe(64);
    expect(buildLogQuery({}, null, 99999).query?.limit).toBe(1000);
  });
});

describe('checkReason', () => {
  it('requires a reason by default and caps it at 200', () => {
    expect(checkReason('  ').error).toMatch(/required/);
    expect(checkReason('spamming').value).toBe('spamming');
    expect(checkReason('x'.repeat(201)).error).toMatch(/200/);
    expect(checkReason('x'.repeat(200)).value).toHaveLength(200);
    expect(checkReason('', { required: false }).value).toBe('');
  });
});

describe('pager', () => {
  it('walks older / newer with a cursor stack', () => {
    let p = pagerInit();
    expect(pagerCursor(p)).toBeNull();
    p = pagerLoaded(p, 900);
    expect(pagerLabel(p, 50)).toBe('Page 1 · 50 rows');
    p = pagerOlder(p);
    expect(pagerCursor(p)).toBe(900);
    p = pagerLoaded(p, null);
    expect(pagerLabel(p, 3)).toBe('Page 2 · 3 rows · end of list');
    expect(pagerOlder(p)).toBe(p); // no more
    p = pagerNewer(p);
    expect(pagerCursor(p)).toBeNull();
    expect(pagerNewer(p)).toBe(p);
    expect(pagerLoaded(pagerInit(), 'x').next).toBeNull();
    expect(pagerLabel(pagerInit(), 0)).toBe('No rows');
  });
});

describe('latestOnly', () => {
  it('only the newest request stays current', () => {
    const start = latestOnly();
    const a = start();
    expect(a()).toBe(true);
    const b = start();
    expect(a()).toBe(false);
    expect(b()).toBe(true);
    const other = latestOnly()(); // independent sequences
    expect(other()).toBe(true);
    expect(b()).toBe(true);
  });
});

describe('nextTabIndex', () => {
  it('wraps with arrows and jumps with Home / End', () => {
    expect(nextTabIndex(0, 'ArrowRight', 5)).toBe(1);
    expect(nextTabIndex(4, 'ArrowRight', 5)).toBe(0);
    expect(nextTabIndex(0, 'ArrowLeft', 5)).toBe(4);
    expect(nextTabIndex(2, 'Home', 5)).toBe(0);
    expect(nextTabIndex(2, 'End', 5)).toBe(4);
    expect(nextTabIndex(2, 'a', 5)).toBe(2);
  });
});

describe('ban / action rows in words', () => {
  it('banTargetText covers every scope', () => {
    expect(banTargetText({ scope: 'account', username: 'bob' })).toBe('bob');
    expect(banTargetText({ scope: 'address', address: '10.0.0.5' })).toBe('everyone on 10.0.0.5');
    expect(banTargetText({ scope: 'guest', address: '10.0.0.5', username: 'Pilot7' })).toBe('guest "Pilot7" on 10.0.0.5');
    expect(banTargetText({ scope: 'guest', address: '10.0.0.5', username: null })).toBe('all guests on 10.0.0.5');
    expect(banTargetText(null)).toBe('?');
  });

  it('actionTargetText / actionDurationText', () => {
    expect(actionTargetText({ targetName: 'bob', targetAddress: '1.2.3.4' })).toBe('bob @ 1.2.3.4');
    expect(actionTargetText({ targetAccountId: 'abcdef1234567' })).toBe('account abcdef12');
    expect(actionDurationText({ action: 'ban', durationSec: 3600, expiresAt: 1 })).toBe('1h');
    expect(actionDurationText({ action: 'mute', durationSec: null, expiresAt: null })).toBe('Permanent');
    expect(actionDurationText({ action: 'kick', durationSec: null })).toBe('');
  });

  it('isDashboardRead spots audited reads only', () => {
    expect(isDashboardRead({ action: 'note', reason: 'api log player=Bob' })).toBe(true);
    expect(isDashboardRead({ action: 'note', reason: 'talked to the student' })).toBe(false);
    expect(isDashboardRead({ action: 'ban', reason: 'api x' })).toBe(false);
  });
});

describe('sanction targeting (bans/create bodies)', () => {
  const account = toSubject({ name: 'Ace', playerId: 4, accountId: 'acc-1', username: 'ace', address: '10.0.0.9' }, true);
  const guest = toSubject({ name: 'Pilot7', playerId: 9, accountId: null, address: '10.0.0.9' }, true);
  const guestNoAddr = toSubject({ name: 'Ghost', playerId: 2 }, false);

  it('accounts are sanctioned by account id only', () => {
    expect(scopeChoices('ban', account).map((c) => c.value)).toEqual(['account']);
    const r = banCreateBody({ kind: 'ban', subject: account, scope: 'account', duration: '1d', reason: 'slurs' });
    expect(r.body).toEqual({ kind: 'ban', duration: '1d', reason: 'slurs', accountId: 'acc-1', scope: 'account' });
  });

  it('a guest mute can target the callsign; a guest ban needs a network scope and warns about classrooms', () => {
    expect(scopeChoices('mute', guest).map((c) => c.value)).toEqual(['guest-name', 'guest', 'address']);
    const ban = scopeChoices('ban', guest);
    expect(ban.map((c) => c.value)).toEqual(['guest', 'address']);
    expect(ban.every((c) => /class|network|last resort/i.test(c.hint))).toBe(true);
    expect(banCreateBody({ kind: 'mute', subject: guest, scope: 'guest-name', duration: '10m', reason: 'spam' }).body)
      .toEqual({ kind: 'mute', duration: '10m', reason: 'spam', target: 'Pilot7', address: '10.0.0.9', scope: 'guest' });
    expect(banCreateBody({ kind: 'ban', subject: guest, scope: 'guest-name', duration: '1d', reason: 'x' }).error).toBeTruthy();
    expect(banCreateBody({ kind: 'ban', subject: guest, scope: 'address', duration: 'perm', reason: 'x', confirm: true }).body)
      .toEqual({ kind: 'ban', duration: 'perm', reason: 'x', address: '10.0.0.9', scope: 'address', confirm: true });
  });

  it('refuses incomplete or unknown input', () => {
    expect(scopeChoices('ban', guestNoAddr)).toEqual([]);
    expect(banCreateBody({ kind: 'ban', subject: guestNoAddr, scope: 'guest', duration: '1d', reason: 'x' }).error).toBeTruthy();
    expect(banCreateBody({ kind: 'nuke', subject: account, scope: 'account', duration: '1d', reason: 'x' }).error).toBeTruthy();
    expect(banCreateBody({ kind: 'ban', subject: account, scope: 'account', duration: '99y', reason: 'x' }).error).toBeTruthy();
    expect(banCreateBody({ kind: 'ban', subject: account, scope: 'account', duration: '1d', reason: ' ' }).error).toBeTruthy();
    expect(banCreateBody({ kind: 'ban', subject: guest, scope: 'account', duration: '1d', reason: 'x' }).error).toBeTruthy();
  });

  it('manual form: by name, or network-wide by address', () => {
    expect(manualBanBody({ kind: 'mute', scope: 'target', target: ' bob ', duration: '1h', reason: 'caps' }).body)
      .toEqual({ kind: 'mute', duration: '1h', reason: 'caps', target: 'bob' });
    expect(manualBanBody({ kind: 'ban', scope: 'guest', target: '10.0.0.9', duration: '7d', reason: 'x' }).body)
      .toEqual({ kind: 'ban', duration: '7d', reason: 'x', address: '10.0.0.9', scope: 'guest' });
    expect(manualBanBody({ kind: 'ban', scope: 'target', target: '', duration: '1d', reason: 'x' }).error).toBeTruthy();
    expect(manualBanBody({ kind: 'ban', scope: 'everyone', target: 'a', duration: '1d', reason: 'x' }).error).toBeTruthy();
  });

  it('toSubject tolerates junk', () => {
    expect(toSubject(null)).toEqual({ name: '?', playerId: null, accountId: null, username: null, address: null, online: false });
    expect(toSubject({ username: 'amy', playerId: 'x' }).name).toBe('amy');
  });
});

describe('createApi', () => {
  it('POSTs JSON with a Bearer token and never puts the token in the URL', async () => {
    const { fn, calls } = mockFetch(200, { ok: true, players: [] });
    const api = createApi({ fetchImpl: fn, getToken: () => 'tok123' });
    const r = await api.admin('online', {});
    expect(r).toEqual({ ok: true, players: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/admin/online');
    expect(calls[0]!.url).not.toContain('tok123');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers.Authorization).toBe('Bearer tok123');
    expect(calls[0]!.init.headers['Content-Type']).toBe('application/json');
    expect(calls[0]!.init.body).toBe('{}');
  });

  it('login / logout use the accounts API without an Authorization header', async () => {
    const { fn, calls } = mockFetch(200, { token: 't', account: {} });
    const api = createApi({ fetchImpl: fn, getToken: () => 'old' });
    await api.login('mod', 'pw');
    await api.logout('t');
    expect(calls.map((c) => c.url)).toEqual(['/api/login', '/api/logout']);
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ login: 'mod', password: 'pw' });
    expect(JSON.parse(calls[1]!.init.body)).toEqual({ token: 't' });
    expect(calls.every((c) => !('Authorization' in c.init.headers))).toBe(true);
  });

  it('401 / 403 from an admin endpoint report the lost session', async () => {
    for (const status of [401, 403]) {
      const { fn } = mockFetch(status, { error: status === 401 ? 'Not logged in' : 'Not a moderator' });
      const lost = vi.fn();
      const api = createApi({ fetchImpl: fn, getToken: () => 't', onAuthLost: lost });
      const err = await api.admin('me').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(status);
      expect(lost).toHaveBeenCalledWith(status, status === 401 ? 'Not logged in' : 'Not a moderator');
    }
  });

  it('a wrong password on /api/login is not a lost admin session', async () => {
    const { fn } = mockFetch(401, { error: 'Invalid login or password' });
    const lost = vi.fn();
    const api = createApi({ fetchImpl: fn, getToken: () => null, onAuthLost: lost });
    await expect(api.login('a', 'b')).rejects.toMatchObject({ status: 401 });
    expect(lost).not.toHaveBeenCalled();
  });

  it('no token → no request, auth lost', async () => {
    const { fn } = mockFetch(200, { ok: true });
    const lost = vi.fn();
    const api = createApi({ fetchImpl: fn, getToken: () => null, onAuthLost: lost });
    await expect(api.admin('online')).rejects.toMatchObject({ status: 401 });
    expect(fn).not.toHaveBeenCalled();
    expect(lost).toHaveBeenCalledOnce();
  });

  it('409 needsConfirm keeps its body; 429 carries Retry-After', async () => {
    const c = mockFetch(409, { error: 'Shared address', needsConfirm: true, sharing: 23 });
    const e409 = (await createApi({ fetchImpl: c.fn, getToken: () => 't' }).admin('bans/create', { kind: 'ban' }).catch((e: unknown) => e)) as ApiError;
    expect(e409.status).toBe(409);
    expect(e409.body).toMatchObject({ needsConfirm: true, sharing: 23 });

    const r = mockFetch(429, { error: 'Too many requests' }, { 'Retry-After': '90' });
    const e429 = (await createApi({ fetchImpl: r.fn, getToken: () => 't' }).admin('online').catch((e: unknown) => e)) as ApiError;
    expect(e429.retryAfterSec).toBe(90);
    expect(errorText(e429)).toBe('Too many requests (try again in 1m)');
  });

  it('network failures, non-JSON and odd bodies become ApiErrors', async () => {
    const down = createApi({ fetchImpl: async () => { throw new TypeError('offline'); }, getToken: () => 't' });
    await expect(down.admin('online')).rejects.toMatchObject({ status: 0, message: 'Cannot reach the server.' });
    const html = mockFetch(502, undefined);
    await expect(createApi({ fetchImpl: html.fn, getToken: () => 't' }).admin('online')).rejects.toMatchObject({ status: 502 });
    const arr = mockFetch(200, [1, 2]);
    await expect(createApi({ fetchImpl: arr.fn, getToken: () => 't' }).admin('online')).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses endpoints outside the contract (no path tricks)', async () => {
    const { fn } = mockFetch(200, { ok: true });
    const api = createApi({ fetchImpl: fn, getToken: () => 't' });
    await expect(api.admin('../login')).rejects.toBeInstanceOf(ApiError);
    await expect(api.admin('online?token=x')).rejects.toBeInstanceOf(ApiError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('every contract endpoint is in the allowlist', () => {
    const contract = readFileSync(path.join(here, '..', 'adminApi.md'), 'utf8');
    const documented = [...contract.matchAll(/^### `([a-z/]+)`/gm)].map((m) => m[1]);
    for (const e of ENDPOINTS) expect(documented).toContain(e);
  });
});

describe('createTokenStore', () => {
  it('uses sessionStorage under one key', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
    const s = createTokenStore(() => storage);
    expect(s.get()).toBeNull();
    s.set('abc');
    expect(data.get(TOKEN_KEY)).toBe('abc');
    expect(s.get()).toBe('abc');
    s.clear();
    expect(data.size).toBe(0);
    expect(s.get()).toBeNull();
  });

  it('falls back to memory when storage throws', () => {
    const boom = () => { throw new Error('SecurityError'); };
    const s = createTokenStore(() => ({ getItem: boom, setItem: boom, removeItem: boom }));
    s.set('abc');
    expect(s.get()).toBe('abc');
    s.clear();
    expect(s.get()).toBeNull();
    const none = createTokenStore(() => { throw new Error('no storage'); });
    none.set('x');
    expect(none.get()).toBe('x');
  });
});

describe('static safety of the shipped files', () => {
  const js = read('admin.js');
  const html = read('admin.html');
  const css = read('admin.css');
  const code = js.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'); // ignore comment lines

  it('admin.js never renders markup from strings or evaluates code', () => {
    for (const bad of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\s*\(/,
      /createContextualFragment/, /DOMParser/, /setTimeout\(\s*['"`]/, /setInterval\(\s*['"`]/]) {
      expect(code).not.toMatch(bad);
    }
  });

  it('admin.js keeps the token out of URLs and out of localStorage', () => {
    expect(code).not.toMatch(/localStorage/);
    expect(code).not.toMatch(/[?&]token=/);
    expect(code).not.toMatch(/location\.(href|search|hash)\s*=/);
  });

  it('admin.html has no inline script, handlers, styles or external origins', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBe(1);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\bsrc="\/admin\/admin\.js"/);
      expect(attrs).toMatch(/type="module"/);
      expect(body!.trim()).toBe('');
    }
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).toMatch(/href="\/admin\/admin\.css"/);
  });

  it('admin.css loads nothing from other origins', () => {
    expect(css).not.toMatch(/@import/i);
    expect(css).not.toMatch(/url\(\s*['"]?https?:/i);
  });

  it('every id the script looks up exists in the page', () => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const wanted = new Set<string>();
    for (const m of js.matchAll(/\$\('([a-z0-9-]+)'\)/g)) wanted.add(m[1]!);
    for (const m of js.matchAll(/\$\(`tab-(?:btn-)?\$\{t\}`\)/g)) void m;
    for (const t of ['live', 'chat', 'reports', 'bans', 'actions']) { wanted.add(`tab-${t}`); wanted.add(`tab-btn-${t}`); }
    const missing = [...wanted].filter((id) => !ids.has(id) && id !== 'dlg-reason'); // dlg-reason is built at runtime
    expect(missing).toEqual([]);
  });
});
