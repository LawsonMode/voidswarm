// OWNER: ADMIN DASHBOARD builder. Voidswarm moderation dashboard, served by the game server at /admin.
// Contract: ../adminApi.md (SERVER MODERATION owns it). No build step, no dependencies, CSP-safe:
//   - no inline script / handlers (this file is an ES module loaded by admin.html), no eval, no CDN;
//   - ALL server/user text (chat, names, reasons, addresses) is rendered with textContent — never innerHTML;
//   - the session token lives in sessionStorage only and travels in the Authorization header, never in a URL.
// Pure helpers are exported (admin.test.ts runs them under node); the DOM app boots only inside the page.

// ============================================================================================================
// Pure helpers (no DOM)
// ============================================================================================================

export const TOKEN_KEY = 'voidswarm.admin.token';
export const LIVE_REFRESH_MS = 5000;
export const REPORTS_POLL_MS = 60000;
export const PAGE_SIZE = 50;
export const REASON_MAX = 200;
export const NOTE_MAX = 500;
export const GREP_MAX = 100;
export const NAME_MAX = 64;
export const HOT_STRIKES = 3;

/** Every admin endpoint the page calls (adminApi.md "Endpoints"). */
export const ENDPOINTS = Object.freeze([
  'me', 'online', 'log', 'reports', 'reports/review', 'bans', 'bans/create', 'bans/revoke', 'kick', 'warn', 'whois', 'actions',
]);

export const DURATION_PRESETS = Object.freeze([
  Object.freeze({ id: '10m', label: '10 min' }),
  Object.freeze({ id: '1h', label: '1 hour' }),
  Object.freeze({ id: '1d', label: '1 day' }),
  Object.freeze({ id: '7d', label: '7 days' }),
  Object.freeze({ id: 'perm', label: 'Permanent' }),
]);
/** Classroom-safe defaults: short mutes, one-day bans. Permanent is always an explicit choice. */
export const DEFAULT_DURATION = Object.freeze({ ban: '1d', mute: '10m' });

export function isDurationPreset(id) {
  return DURATION_PRESETS.some((p) => p.id === id);
}

export function durationLabel(id) {
  const p = DURATION_PRESETS.find((x) => x.id === id);
  return p ? p.label : String(id ?? '');
}

/** Chat filter outcomes (adminApi.md `Action`). `hidden` = other players did not see the line. */
export const CHAT_ACTIONS = Object.freeze({
  pass: Object.freeze({ label: 'Passed', hidden: false }),
  mask: Object.freeze({ label: 'Masked', hidden: false }),
  block: Object.freeze({ label: 'Blocked', hidden: true }),
  spam: Object.freeze({ label: 'Spam', hidden: true }),
  muted: Object.freeze({ label: 'Muted', hidden: true }),
});

export function chatActionInfo(action) {
  const known = Object.prototype.hasOwnProperty.call(CHAT_ACTIONS, action) ? CHAT_ACTIONS[action] : null;
  return known
    ? { id: action, label: known.label, hidden: known.hidden }
    : { id: 'unknown', label: String(action || '?'), hidden: false };
}

/** Table-row class for a chat line: blocked lines are highlighted red, masked yellow, spam/muted dimmed. */
export function chatRowClass(action) {
  if (action === 'block') return 'row-block';
  if (action === 'mask') return 'row-mask';
  if (action === 'spam' || action === 'muted') return 'row-spam';
  return '';
}

export const CHANNEL_LABELS = Object.freeze({ team: 'Team', name: 'Callsign', room: 'Room name' });

const pad2 = (n) => String(n).padStart(2, '0');

function validTime(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 && ms < 8.64e15;
}

/** Local `YYYY-MM-DD HH:MM:SS`; '—' for a missing / invalid time. */
export function formatDateTime(ms) {
  if (!validTime(ms)) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Compact table time: `HH:MM:SS` today, `MM-DD HH:MM` this year, else `YYYY-MM-DD`. */
export function formatShortTime(ms, now = Date.now()) {
  if (!validTime(ms)) return '—';
  const d = new Date(ms);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }
  if (d.getFullYear() === n.getFullYear()) return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** A span of time, two units at most: `45s`, `12m`, `3h 5m`, `2d 4h`. */
export function formatSpan(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Expiry cell text: `Permanent`, `Ended`, or `in 3h 5m`. */
export function formatExpiry(expiresAt, now = Date.now()) {
  if (expiresAt === null || expiresAt === undefined) return 'Permanent';
  if (!validTime(expiresAt)) return '—';
  if (expiresAt <= now) return 'Ended';
  return `in ${formatSpan(expiresAt - now)}`;
}

/** `<input type="datetime-local">` value (`YYYY-MM-DDTHH:MM[:SS]`, local time) → epoch ms, or null. */
export function parseLocalDateTime(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== mi) return null;
  return date.getTime();
}

/** Trim, collapse control characters, cap length. Non-strings → ''. */
export function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

/**
 * Chat-log search form → the `log` request body (only the fields that are set) or `{ error }`.
 * `form`: { player, grep, address, roomId, action, range ('' | '1h' | '1d' | '7d' | 'custom'), from, to } (strings).
 */
export function buildLogQuery(form, before, limit = PAGE_SIZE) {
  const q = {};
  const player = cleanText(form.player, NAME_MAX);
  const grep = cleanText(form.grep, GREP_MAX);
  const address = cleanText(form.address, NAME_MAX);
  const roomId = cleanText(form.roomId, NAME_MAX);
  const action = cleanText(form.action, 16);
  if (player) q.player = player;
  if (grep) q.grep = grep;
  if (address) q.address = address;
  if (roomId) q.roomId = roomId;
  if (action) {
    if (action !== 'flagged' && !Object.prototype.hasOwnProperty.call(CHAT_ACTIONS, action)) return { error: 'Unknown filter action.' };
    q.action = action;
  }
  const range = cleanText(form.range, 16);
  if (range === 'custom') {
    const fromRaw = cleanText(form.from, 32);
    const toRaw = cleanText(form.to, 32);
    const from = fromRaw ? parseLocalDateTime(fromRaw) : null;
    const to = toRaw ? parseLocalDateTime(toRaw) : null;
    if (fromRaw && from === null) return { error: 'The "From" time is not valid.' };
    if (toRaw && to === null) return { error: 'The "To" time is not valid.' };
    if (from !== null && to !== null && from > to) return { error: '"From" must be before "To".' };
    if (from !== null) q.since = from;
    if (to !== null) q.until = to;
  } else if (range) {
    if (!/^\d{1,3}[mhdw]$/.test(range)) return { error: 'Unknown time range.' };
    q.since = range;
  }
  q.limit = Math.max(1, Math.min(1000, Math.floor(limit) || PAGE_SIZE));
  if (typeof before === 'number' && Number.isFinite(before)) q.before = before;
  return { query: q };
}

/** Reason / note field check. Returns { value } or { error }. */
export function checkReason(raw, { required = true, max = REASON_MAX, what = 'A reason' } = {}) {
  const value = cleanText(raw, max + 1);
  if (value.length > max) return { error: `${what} can be at most ${max} characters.` };
  if (required && !value) return { error: `${what} is required — the player sees it.` };
  return { value };
}

/**
 * Cursor pager state for newest-first lists (`before` = the previous page's `nextBefore`).
 * Immutable: every step returns a new object.
 */
export function pagerInit() {
  return { stack: [null], next: null };
}
export function pagerCursor(p) {
  return p.stack[p.stack.length - 1];
}
export function pagerLoaded(p, nextBefore) {
  return { stack: p.stack, next: typeof nextBefore === 'number' && Number.isFinite(nextBefore) ? nextBefore : null };
}
export function pagerOlder(p) {
  return p.next === null ? p : { stack: [...p.stack, p.next], next: null };
}
export function pagerNewer(p) {
  return p.stack.length <= 1 ? p : { stack: p.stack.slice(0, -1), next: null };
}
export function pagerLabel(p, shown) {
  const page = p.stack.length;
  if (!shown) return page > 1 ? `Page ${page} · no more rows` : 'No rows';
  return `Page ${page} · ${shown} row${shown === 1 ? '' : 's'}${p.next === null ? ' · end of list' : ''}`;
}

/**
 * "Latest request wins": each call to the returned function starts a request and returns `isCurrent()`, which is
 * false once a newer request has started — so a slow, stale answer never overwrites a newer one.
 */
export function latestOnly() {
  let seq = 0;
  return () => {
    const mine = ++seq;
    return () => mine === seq;
  };
}

/** Arrow-key navigation across a tab list. */
export function nextTabIndex(current, key, count) {
  if (count <= 0) return current;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (current + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return current;
}

/** Who a BanRow applies to, in words. */
export function banTargetText(b) {
  if (!b || typeof b !== 'object') return '?';
  if (b.scope === 'account') return b.username || (b.accountId ? `account ${String(b.accountId).slice(0, 8)}` : 'account ?');
  if (b.scope === 'address') return `everyone on ${b.address || '?'}`;
  if (b.scope === 'guest') return b.username ? `guest "${b.username}" on ${b.address || '?'}` : `all guests on ${b.address || '?'}`;
  return b.username || b.address || '?';
}

export const SCOPE_LABELS = Object.freeze({ account: 'Account', address: 'Network', guest: 'Guest' });

/** ActionRow → its target in words. */
export function actionTargetText(a) {
  if (!a || typeof a !== 'object') return '';
  const parts = [];
  if (a.targetName) parts.push(String(a.targetName));
  if (a.targetAddress) parts.push(`@ ${a.targetAddress}`);
  if (!parts.length && a.targetAccountId) parts.push(`account ${String(a.targetAccountId).slice(0, 8)}`);
  return parts.join(' ');
}

/** ActionRow → its duration cell. */
export function actionDurationText(a) {
  if (!a || (a.action !== 'ban' && a.action !== 'mute')) return '';
  if (typeof a.durationSec === 'number' && Number.isFinite(a.durationSec) && a.durationSec > 0) return formatSpan(a.durationSec * 1000);
  return a.expiresAt === null || a.expiresAt === undefined ? 'Permanent' : '';
}

/** Dashboard reads are audited as `note` rows whose reason starts with "api " (adminApi.md "Request rules"). */
export function isDashboardRead(a) {
  return !!a && a.action === 'note' && typeof a.reason === 'string' && /^api\s/.test(a.reason);
}

/**
 * A person the moderator acts on, from any list: OnlinePlayer, ChatLogRow, report Party or whois.
 * { name, playerId, accountId, username, address, online }
 */
export function toSubject(src, online = false) {
  const o = src && typeof src === 'object' ? src : {};
  const str = (v) => (typeof v === 'string' && v ? v : null);
  return {
    name: str(o.name) || str(o.username) || '?',
    playerId: typeof o.playerId === 'number' && Number.isFinite(o.playerId) ? o.playerId : null,
    accountId: str(o.accountId),
    username: str(o.username),
    address: str(o.address),
    online: !!online,
  };
}

/**
 * Scope choices for a ban / mute of `subject` (adminApi.md `bans/create`). Accounts are sanctioned per account.
 * A guest mute can target just that callsign on its network; a guest ban has to cover the network's guests
 * (or everyone on it) — the dashboard says plainly that this usually means the whole classroom.
 */
export function scopeChoices(kind, subject) {
  if (subject.accountId || subject.username) {
    return [{ value: 'account', label: `Only this account (${subject.username || subject.name})`, hint: '' }];
  }
  const addr = subject.address || 'their network';
  const out = [];
  if (kind === 'mute') out.push({ value: 'guest-name', label: `Only the guest "${subject.name}" on ${addr}`, hint: '' });
  if (subject.address) {
    out.push({ value: 'guest', label: `Every guest on ${addr}`, hint: 'Everyone not signed in on that network — in a school that is usually the whole class.' });
    out.push({ value: 'address', label: `Everyone on ${addr} (accounts too)`, hint: 'Every pilot on that network, signed in or not. Use only as a last resort.' });
  }
  return out;
}

/** `bans/create` body for `subject`, or `{ error }`. `scope` is a value from scopeChoices(). */
export function banCreateBody({ kind, subject, scope, duration, reason, confirm = false }) {
  if (kind !== 'ban' && kind !== 'mute') return { error: 'Unknown kind.' };
  if (!isDurationPreset(duration)) return { error: 'Pick a duration.' };
  const r = checkReason(reason);
  if (r.error) return { error: r.error };
  const body = { kind, duration, reason: r.value };
  if (scope === 'account') {
    if (subject.accountId) body.accountId = subject.accountId;
    else if (subject.username) body.target = subject.username;
    else return { error: 'That player has no account.' };
    body.scope = 'account';
  } else if (scope === 'guest-name') {
    if (kind !== 'mute') return { error: 'Only a mute can target a single guest callsign.' };
    if (!subject.name || subject.name === '?') return { error: 'Unknown callsign.' };
    body.target = subject.name;
    if (subject.address) body.address = subject.address;
    body.scope = 'guest';
  } else if (scope === 'guest' || scope === 'address') {
    if (!subject.address) return { error: 'Their network address is unknown.' };
    body.address = subject.address;
    body.scope = scope;
  } else {
    return { error: 'Pick who this applies to.' };
  }
  if (confirm) body.confirm = true;
  return { body };
}

/** The "New ban or mute" form → `bans/create` body, or `{ error }`. */
export function manualBanBody({ kind, scope, target, duration, reason, confirm = false }) {
  if (kind !== 'ban' && kind !== 'mute') return { error: 'Unknown kind.' };
  const t = cleanText(target, NAME_MAX);
  if (!t) return { error: scope === 'target' ? 'Enter a callsign or username.' : 'Enter a network address.' };
  if (!isDurationPreset(duration)) return { error: 'Pick a duration.' };
  const r = checkReason(reason);
  if (r.error) return { error: r.error };
  const body = { kind, duration, reason: r.value };
  if (scope === 'target') body.target = t;
  else if (scope === 'guest' || scope === 'address') { body.address = t; body.scope = scope; }
  else return { error: 'Pick who this applies to.' };
  if (confirm) body.confirm = true;
  return { body };
}

export class ApiError extends Error {
  constructor(status, message, body = null, retryAfterSec = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.retryAfterSec = retryAfterSec;
  }
}

function statusMessage(status) {
  if (status === 401) return 'Not logged in.';
  if (status === 403) return 'Not a moderator.';
  if (status === 404) return 'Not found.';
  if (status === 429) return 'Too many requests — wait a moment.';
  if (status === 503) return 'Moderation is unavailable on this server.';
  if (status >= 500) return 'Server error — try again.';
  return `Request failed (${status}).`;
}

/**
 * Tiny JSON-over-POST client. `fetchImpl(url, init)` is window.fetch in the page, a mock in tests.
 * `onAuthLost(status, message)` fires on a 401 / 403 from an admin endpoint (session gone / not a moderator).
 */
export function createApi({ fetchImpl, getToken, onAuthLost }) {
  async function post(path, body, auth) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (auth) {
      const token = getToken();
      if (!token) {
        const err = new ApiError(401, 'Not logged in.');
        onAuthLost?.(401, err.message);
        throw err;
      }
      headers.Authorization = `Bearer ${token}`;
    }
    let res;
    try {
      res = await fetchImpl(path, {
        method: 'POST', headers, body: JSON.stringify(body ?? {}),
        credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
      });
    } catch {
      throw new ApiError(0, 'Cannot reach the server.');
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const msg = data && typeof data.error === 'string' && data.error ? data.error : statusMessage(res.status);
      const ra = Number(res.headers?.get?.('Retry-After'));
      const err = new ApiError(res.status, msg, data && typeof data === 'object' ? data : null, Number.isFinite(ra) && ra > 0 ? ra : null);
      if (auth && (res.status === 401 || res.status === 403)) onAuthLost?.(res.status, msg);
      throw err;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ApiError(res.status, 'Unexpected answer from the server.');
    return data;
  }
  return {
    login: (login, password) => post('/api/login', { login, password }, false),
    logout: (token) => post('/api/logout', { token }, false),
    admin: (endpoint, body = {}) => {
      if (!ENDPOINTS.includes(endpoint)) return Promise.reject(new ApiError(0, `Unknown endpoint ${endpoint}`));
      return post(`/api/admin/${endpoint}`, body, true);
    },
  };
}

/** Human text for a failed call (adds the Retry-After wait to a 429). */
export function errorText(err) {
  if (err instanceof ApiError) {
    if (err.status === 429 && err.retryAfterSec) return `${err.message} (try again in ${formatSpan(err.retryAfterSec * 1000)})`;
    return err.message;
  }
  return 'Something went wrong.';
}

/** sessionStorage-backed token with an in-memory fallback (storage may be blocked / throw). */
export function createTokenStore(getStorage) {
  let memory = null;
  const storage = () => { try { return getStorage() ?? null; } catch { return null; } };
  return {
    get() {
      try {
        const v = storage()?.getItem(TOKEN_KEY);
        if (typeof v === 'string' && v) return v;
      } catch { /* blocked storage */ }
      return memory;
    },
    set(token) {
      memory = token;
      try { storage()?.setItem(TOKEN_KEY, token); } catch { /* memory only */ }
    },
    clear() {
      memory = null;
      try { storage()?.removeItem(TOKEN_KEY); } catch { /* nothing stored */ }
    },
  };
}

// ============================================================================================================
// DOM app
// ============================================================================================================

/** Allowed element properties for h(); everything else is refused, so no markup / handler string can slip in. */
const SAFE_ATTRS = new Set(['id', 'type', 'value', 'name', 'title', 'role', 'tabindex', 'colspan', 'for', 'maxlength', 'placeholder', 'autocomplete']);

/**
 * Element builder: h('td', { class: 'msg', text: userText }, child, …). Strings become text nodes (textContent),
 * `on: { click: fn }` adds listeners. There is deliberately no way to set innerHTML.
 */
function h(tag, props, ...children) {
  const n = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = String(v);
      else if (k === 'text') n.textContent = String(v);
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
      else if (k === 'data') for (const [dk, dv] of Object.entries(v)) n.dataset[dk] = String(dv);
      else if (k === 'checked' || k === 'disabled' || k === 'hidden') n[k] = !!v;
      else if (k.startsWith('aria-') || SAFE_ATTRS.has(k)) n.setAttribute(k, String(v));
      else throw new Error(`h(): refusing attribute ${k}`);
    }
  }
  appendAll(n, children);
  return n;
}

function appendAll(parent, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendAll(parent, c);
    else if (typeof c === 'object' && 'nodeType' in c) parent.appendChild(c);
    else parent.appendChild(document.createTextNode(String(c)));
  }
}

function pill(text, cls) {
  return h('span', { class: `pill ${cls || ''}`.trim(), text });
}

function boot() {
  const $ = (id) => {
    const n = document.getElementById(id);
    if (!n) throw new Error(`admin.html is missing #${id}`);
    return n;
  };

  const tokens = createTokenStore(() => window.sessionStorage);
  let signedIn = false;
  let me = null;

  const api = createApi({
    fetchImpl: (url, init) => window.fetch(url, init),
    getToken: () => tokens.get(),
    onAuthLost: (status) => authLost(status),
  });

  // ---------------------------------------------------------------- small UI utilities
  function setStatus(node, text, kind = '') {
    node.textContent = text || '';
    node.classList.toggle('error', kind === 'error');
    node.classList.toggle('ok', kind === 'ok');
  }

  function toast(text, kind = '') {
    const host = $('toasts');
    const t = h('div', { class: `toast ${kind}`.trim(), role: kind === 'error' ? 'alert' : 'status', text });
    host.appendChild(t);
    while (host.childElementCount > 4) host.firstElementChild?.remove();
    setTimeout(() => t.remove(), kind === 'error' ? 8000 : 5000);
  }

  /** A call failed: show it, unless the session just ended (authLost already showed the login screen). */
  function failStatus(node, err, prefix = '') {
    if (!signedIn) return;
    setStatus(node, `${prefix}${errorText(err)}`, 'error');
  }
  function failToast(prefix, err) {
    if (!signedIn) return;
    toast(`${prefix}: ${errorText(err)}`, 'error');
  }

  function fillRows(tbody, rows, colCount, emptyText, rowFn) {
    const out = [];
    for (const r of rows) {
      try { out.push(rowFn(r)); } catch (e) { console.warn('admin: skipped a malformed row', e); }
    }
    if (!out.length) out.push(h('tr', { class: 'empty' }, h('td', { colspan: colCount, text: emptyText })));
    tbody.replaceChildren(...out);
  }

  function timeCell(ms) {
    return h('td', { class: 'nowrap', title: formatDateTime(ms), text: formatShortTime(ms) });
  }

  /** A player name that opens the lookup. */
  function nameButton(name, lookup) {
    const label = name || '?';
    return h('button', {
      class: 'link-btn', type: 'button', text: label, title: `Look up ${label}`,
      on: { click: () => { if (lookup) void runWhois(lookup); } },
    });
  }

  function accountPill(accountId, username) {
    return accountId || username ? pill(username ? `acct ${username}` : 'account', 'pill-account') : pill('guest', 'pill-guest');
  }

  function chatActionCell(row) {
    const info = chatActionInfo(row.action);
    const td = h('td', { class: 'nowrap' }, pill(info.label, `pill-${info.id}`));
    const hits = Array.isArray(row.hits) ? row.hits.filter((x) => typeof x === 'string' && x).slice(0, 8) : [];
    if (hits.length) td.appendChild(h('div', { class: 'hits', text: hits.join(', ') }));
    return td;
  }

  function shownCell(row) {
    const info = chatActionInfo(row.action);
    if (info.hidden || !row.shown) return h('td', { class: 'msg' }, h('span', { class: 'not-shown', text: '(not shown)' }));
    return h('td', { class: 'msg', text: row.shown });
  }

  function originalCell(row) {
    const td = h('td', { class: 'msg', text: row.original ?? '' });
    const ch = CHANNEL_LABELS[row.channel];
    if (ch) td.prepend(pill(ch, 'pill-channel'), ' ');
    return td;
  }

  async function withBusy(button, fn) {
    if (button) button.disabled = true;
    try { return await fn(); } finally { if (button) button.disabled = false; }
  }

  // ---------------------------------------------------------------- dialog
  const dlg = $('dlg');
  let dlgResolve = null;
  let dlgValidate = null;

  /**
   * Modal form. opts: { title, text, target, okLabel, okKind ('danger'|'warn'|'accent'|'primary'),
   *   duration?: presetId, scopes?: [{value,label,hint}], reason?: { label, required, max, value, placeholder } }.
   * Resolves { duration, scope, reason } or null (cancelled).
   */
  function openDialog(opts) {
    if (dlgResolve) return Promise.resolve(null);
    $('dlg-title').textContent = opts.title || '';
    $('dlg-text').textContent = opts.text || '';
    $('dlg-text').hidden = !opts.text;
    $('dlg-target').textContent = opts.target || '';
    $('dlg-target').hidden = !opts.target;
    setStatus($('dlg-error'), '');
    const ok = $('dlg-ok');
    ok.textContent = opts.okLabel || 'Confirm';
    ok.className = `btn btn-${opts.okKind || 'danger'}`;

    const fields = [];
    let duration = opts.duration || null;
    if (opts.duration) {
      const group = h('div', { class: 'presets', role: 'group', 'aria-label': 'Duration' });
      const sync = () => { for (const b of group.children) b.setAttribute('aria-pressed', String(b.dataset.id === duration)); };
      for (const p of DURATION_PRESETS) {
        group.appendChild(h('button', {
          class: 'preset', type: 'button', text: p.label, data: { id: p.id }, 'aria-pressed': 'false',
          on: { click: () => { duration = p.id; sync(); } },
        }));
      }
      sync();
      fields.push(h('div', { class: 'lbl' }, 'Duration', group));
    }
    let scope = null;
    const scopeHint = h('p', { class: 'hint warn-hint', hidden: true });
    if (opts.scopes && opts.scopes.length) {
      scope = opts.scopes[0].value;
      const list = h('div', { class: 'scope-list', role: 'radiogroup', 'aria-label': 'Applies to' });
      const showHint = () => {
        const c = opts.scopes.find((s) => s.value === scope);
        scopeHint.textContent = c?.hint || '';
        scopeHint.hidden = !c?.hint;
      };
      opts.scopes.forEach((s, i) => {
        const input = h('input', { type: 'radio', name: 'dlg-scope', value: s.value, checked: i === 0 });
        input.addEventListener('change', () => { if (input.checked) { scope = s.value; showHint(); } });
        list.appendChild(h('label', { class: 'check scope' }, input, ' ', s.label));
      });
      showHint();
      fields.push(h('div', { class: 'lbl' }, 'Applies to', list), scopeHint);
    }
    let reasonInput = null;
    if (opts.reason) {
      const max = opts.reason.max || REASON_MAX;
      reasonInput = h('input', {
        class: 'field', id: 'dlg-reason', maxlength: max, autocomplete: 'off', placeholder: opts.reason.placeholder || '',
      });
      reasonInput.value = opts.reason.value || '';
      fields.push(h('label', { class: 'lbl', for: 'dlg-reason' }, opts.reason.label || 'Reason', reasonInput));
    }
    $('dlg-fields').replaceChildren(...fields);

    dlgValidate = () => {
      let reason = '';
      if (opts.reason) {
        const r = checkReason(reasonInput.value, {
          required: !!opts.reason.required, max: opts.reason.max || REASON_MAX, what: opts.reason.what || 'A reason',
        });
        if (r.error) { reasonInput.focus(); return { error: r.error }; }
        reason = r.value;
      }
      if (opts.duration && !isDurationPreset(duration)) return { error: 'Pick a duration.' };
      if (opts.scopes && opts.scopes.length && !scope) return { error: 'Pick who this applies to.' };
      return { value: { duration, scope, reason } };
    };

    return new Promise((resolve) => {
      dlgResolve = resolve;
      dlg.showModal();
      (reasonInput || $('dlg-cancel')).focus();
    });
  }

  function finishDialog(value) {
    const r = dlgResolve;
    dlgResolve = null;
    dlgValidate = null;
    if (dlg.open) dlg.close();
    $('dlg-fields').replaceChildren();
    r?.(value);
  }

  $('dlg-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const res = dlgValidate ? dlgValidate() : { value: {} };
    if (res.error) { setStatus($('dlg-error'), res.error, 'error'); return; }
    finishDialog(res.value);
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); finishDialog(null); });
  // A close event is queued: by the time it fires, a follow-up dialog may already be open (dlg.open) — leave that one alone.
  dlg.addEventListener('close', () => { if (dlgResolve && !dlg.open) finishDialog(null); });
  $('dlg-cancel').addEventListener('click', () => finishDialog(null));

  async function confirmBox(title, text, okLabel = 'Confirm', okKind = 'danger') {
    return (await openDialog({ title, text, okLabel, okKind })) !== null;
  }

  // ---------------------------------------------------------------- moderation actions (shared by every tab)
  /** After a change: refresh whatever lists are affected. */
  function afterChange() {
    void loadOnline(true);
    if (currentTab === 'bans') void loadBans();
    if (currentTab === 'chat') void loadLog();
    if (currentTab === 'actions') void loadActions();
    if (whoisQuery) void runWhois(whoisQuery, true);
  }

  /** bans/create with the 409 needsConfirm round trip. Returns the answer or null (cancelled / failed). */
  async function createBan(body, describe) {
    try {
      return await api.admin('bans/create', body);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body?.needsConfirm) {
        const n = Number(err.body.sharing) || 0;
        const go = await confirmBox(
          'Other pilots share this network',
          `${err.message || `${n} other online pilot${n === 1 ? '' : 's'} share that network.`} In a classroom that is usually everyone. Continue?`,
          `Yes, ${body.kind} them all`,
        );
        if (!go) return null;
        try {
          return await api.admin('bans/create', { ...body, confirm: true });
        } catch (err2) {
          failToast(describe, err2);
          return null;
        }
      }
      failToast(describe, err);
      return null;
    }
  }

  /** Ban or mute `subject` via the dialog. Returns true when something was created. */
  async function sanctionSubject(kind, subject, extra = {}) {
    const scopes = scopeChoices(kind, subject);
    if (!scopes.length) { toast(`Can't ${kind} ${subject.name}: their network address is unknown and they have no account.`, 'error'); return false; }
    const isBan = kind === 'ban';
    const v = await openDialog({
      title: isBan ? 'Ban player' : 'Mute player',
      text: isBan
        ? 'A ban disconnects them now and keeps them out until it ends.'
        : 'A mute keeps them in the game but nobody sees their chat until it ends.',
      target: `${subject.name}${subject.username && subject.username !== subject.name ? ` (account ${subject.username})` : ''}${subject.address ? ` · ${subject.address}` : ''}`,
      okLabel: isBan ? 'Ban' : 'Mute',
      okKind: isBan ? 'danger' : 'warn',
      duration: DEFAULT_DURATION[kind],
      scopes,
      reason: { label: 'Reason (shown to the player)', required: true, value: extra.reason || '' },
    });
    if (!v) return false;
    if (isBan && v.duration === 'perm') {
      const sure = await confirmBox('Permanent ban?', `${subject.name} will be banned until a moderator lifts it. A 1-day or 7-day ban is usually enough.`, 'Ban permanently');
      if (!sure) return false;
    }
    const built = banCreateBody({ kind, subject, scope: v.scope, duration: v.duration, reason: v.reason });
    if (built.error) { toast(built.error, 'error'); return false; }
    const res = await createBan(built.body, `${isBan ? 'Ban' : 'Mute'} ${subject.name}`);
    if (!res) return false;
    const kicked = Number(res.kicked) || 0;
    toast(`${isBan ? 'Banned' : 'Muted'} ${subject.name} (${durationLabel(v.duration)})${isBan && kicked ? ` — ${kicked} connection${kicked === 1 ? '' : 's'} closed` : ''}.`, 'ok');
    extra.onDone?.(v, res);
    afterChange();
    return true;
  }

  function subjectRef(subject) {
    return subject.playerId !== null && subject.online ? { playerId: subject.playerId } : { target: subject.username || subject.name };
  }

  async function kickSubject(subject) {
    const v = await openDialog({
      title: 'Kick player', text: 'They are disconnected now but can reconnect right away.', target: subject.name,
      okLabel: 'Kick', okKind: 'warn', reason: { label: 'Reason (shown to the player, optional)', required: false },
    });
    if (!v) return;
    try {
      const r = await api.admin('kick', { ...subjectRef(subject), reason: v.reason });
      toast(Number(r.kicked) ? `Kicked ${subject.name}.` : `${subject.name} is not online.`, Number(r.kicked) ? 'ok' : '');
      afterChange();
    } catch (err) { failToast(`Kick ${subject.name}`, err); }
  }

  /** Returns true when the warning was delivered. */
  async function warnSubject(subject, extra = {}) {
    const v = await openDialog({
      title: 'Warn player', text: 'They see "Warning from a moderator: <your message>" in their chat.', target: subject.name,
      okLabel: 'Send warning', okKind: 'accent', reason: { label: 'Message', required: true, what: 'A message', value: extra.reason || '' },
    });
    if (!v) return false;
    try {
      const r = await api.admin('warn', { ...subjectRef(subject), reason: v.reason });
      if (!Number(r.warned)) { toast(`${subject.name} is not online, so the warning was not delivered.`, 'error'); return false; }
      toast(`Warned ${subject.name}.`, 'ok');
      extra.onDone?.(v);
      afterChange();
      return true;
    } catch (err) {
      failToast(`Warn ${subject.name}`, err);
      return false;
    }
  }

  async function revokeBan(b) {
    const what = `${b.kind === 'ban' ? 'ban' : 'mute'} on ${banTargetText(b)}`;
    if (!(await confirmBox(b.kind === 'ban' ? 'Lift ban?' : 'Lift mute?', `Lift the ${what}?`, 'Lift', 'primary'))) return;
    try {
      await api.admin('bans/revoke', { id: b.id });
      toast(`Lifted the ${what}.`, 'ok');
      afterChange();
    } catch (err) { failToast(`Lift ${what}`, err); }
  }

  async function unmuteSubject(subject) {
    if (!(await confirmBox('Lift mute?', `Lift every active mute that applies to ${subject.name}? This includes a network-wide mute on their address, which unmutes everyone it covered.`, 'Unmute', 'primary'))) return;
    try {
      const r = await api.admin('bans/revoke', { target: subject.username || subject.name, kind: 'mute' });
      const n = Number(r.revoked) || 0;
      toast(n ? `Unmuted ${subject.name} (${n} mute${n === 1 ? '' : 's'} lifted).` : `No active mute found for ${subject.name}.`, n ? 'ok' : 'error');
      afterChange();
    } catch (err) { failToast(`Unmute ${subject.name}`, err); }
  }

  // ---------------------------------------------------------------- tabs
  const TABS = ['live', 'chat', 'reports', 'bans', 'actions'];
  let currentTab = 'live';
  const tabButtons = TABS.map((t) => $(`tab-btn-${t}`));
  const loaded = new Set();

  function showTab(name, focus = false) {
    if (!TABS.includes(name)) return;
    currentTab = name;
    TABS.forEach((t, i) => {
      const on = t === name;
      tabButtons[i].setAttribute('aria-selected', String(on));
      tabButtons[i].tabIndex = on ? 0 : -1;
      $(`tab-${t}`).hidden = !on;
    });
    if (focus) tabButtons[TABS.indexOf(name)].focus();
    if (name === 'live') void loadOnline();
    else if (!loaded.has(name)) {
      loaded.add(name);
      if (name === 'chat') void loadLog();
      if (name === 'reports') void loadReports();
      if (name === 'bans') void loadBans();
      if (name === 'actions') void loadActions();
    }
  }
  tabButtons.forEach((b, i) => {
    b.addEventListener('click', () => showTab(TABS[i]));
    b.addEventListener('keydown', (e) => {
      const j = nextTabIndex(i, e.key, TABS.length);
      if (j !== i) { e.preventDefault(); showTab(TABS[j], true); }
    });
  });

  // ---------------------------------------------------------------- LIVE
  const knownRooms = new Map(); // roomId -> roomName (chat-log room filter)
  let liveTimer = 0;
  let liveBusy = false;
  let lastOnline = [];
  let lastOnlineSig = '';

  function noteRoom(id, name) {
    if (typeof id !== 'string' || !id || knownRooms.has(id)) return;
    knownRooms.set(id, typeof name === 'string' && name ? name : id);
    const sel = $('chat-room');
    sel.appendChild(h('option', { value: id, text: knownRooms.get(id) }));
  }

  function renderOnline(players, force = false) {
    // Unchanged list: keep the rows (and whatever button has focus) instead of rebuilding them every 5 s.
    const sig = JSON.stringify(players);
    if (!force && sig === lastOnlineSig) return;
    lastOnlineSig = sig;
    lastOnline = players;
    $('live-count').textContent = `(${players.length})`;
    fillRows($('live-body'), players, 7, 'Nobody is online.', (p) => {
      const subject = toSubject(p, true);
      noteRoom(p.roomId, p.roomName);
      const strikes = Number(p.strikes) || 0;
      const muted = p.muted && typeof p.muted === 'object' ? p.muted : null;
      const status = h('td');
      if (muted) {
        status.appendChild(pill(muted.until === null ? 'muted · perm' : `muted · ${formatExpiry(muted.until)}`, 'pill-muted'));
        if (muted.reason) status.appendChild(h('div', { class: 'hits', text: muted.reason }));
      } else status.appendChild(h('span', { class: 'muted', text: '—' }));
      const self = !!(me && p.accountId && p.accountId === me.accountId);
      const buttons = self ? [pill('you', 'pill-admin')] : [
        h('button', { class: 'btn btn-small btn-accent', type: 'button', text: 'Warn', on: { click: () => void warnSubject(subject) } }),
        h('button', { class: 'btn btn-small btn-warn', type: 'button', text: 'Kick', on: { click: () => void kickSubject(subject) } }),
        muted
          ? h('button', { class: 'btn btn-small btn-ghost', type: 'button', text: 'Unmute', on: { click: () => void unmuteSubject(subject) } })
          : h('button', { class: 'btn btn-small btn-warn', type: 'button', text: 'Mute', on: { click: () => void sanctionSubject('mute', subject) } }),
        h('button', { class: 'btn btn-small btn-danger', type: 'button', text: 'Ban', on: { click: () => void sanctionSubject('ban', subject) } }),
      ];
      return h('tr', { class: strikes >= HOT_STRIKES ? 'row-hot' : '' },
        h('td', null, nameButton(p.name, p.username || p.name), p.admin ? [' ', pill('mod', 'pill-admin')] : null),
        h('td', null, accountPill(p.accountId, p.username)),
        h('td', { text: p.roomName || 'Zone lobby' }),
        h('td', { class: 'mono', text: p.address || '—' }),
        h('td', null, h('span', { class: `strikes${strikes >= HOT_STRIKES ? ' hot' : ''}`, text: String(strikes) })),
        status,
        h('td', { class: 'actions' }, h('div', { class: 'btn-row' }, buttons)),
      );
    });
  }

  const liveSeq = latestOnly();
  /** `force`: after a change — always runs and always re-renders. Timer ticks skip while a request is in flight. */
  async function loadOnline(force = false) {
    if (!signedIn || (!force && liveBusy)) return;
    const isCurrent = liveSeq();
    liveBusy = true;
    try {
      const r = await api.admin('online', {});
      if (!isCurrent()) return;
      renderOnline(Array.isArray(r.players) ? r.players : [], force);
      setStatus($('live-status'), `Updated ${formatShortTime(Date.now())}`);
    } catch (err) {
      if (isCurrent()) failStatus($('live-status'), err);
    } finally {
      if (isCurrent()) liveBusy = false;
    }
  }

  function scheduleLive() {
    clearInterval(liveTimer);
    liveTimer = setInterval(() => {
      if (!signedIn || document.hidden || currentTab !== 'live' || !$('live-auto').checked || dlg.open) return;
      void loadOnline();
    }, LIVE_REFRESH_MS);
  }
  $('live-refresh').addEventListener('click', () => void loadOnline());

  // ---------------------------------------------------------------- WHOIS
  let whoisQuery = '';
  const whoisSeq = latestOnly();

  async function runWhois(query, quiet = false) {
    const q = cleanText(query, NAME_MAX);
    if (!q) { setStatus($('whois-status'), 'Enter a callsign or username.', 'error'); return; }
    whoisQuery = q;
    $('whois-input').value = q;
    if (!quiet) {
      if (currentTab !== 'live') showTab('live');
      $('whois-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      setStatus($('whois-status'), `Looking up ${q}…`);
    }
    const isCurrent = whoisSeq();
    try {
      const r = await api.admin('whois', { target: q });
      if (!isCurrent()) return;
      renderWhois(r.whois || {});
      setStatus($('whois-status'), '');
    } catch (err) {
      if (!isCurrent()) return;
      $('whois-view').hidden = true;
      if (!signedIn) return;
      setStatus($('whois-status'), err instanceof ApiError && err.status === 404 ? `Nobody called "${q}" found (online, as an account, or in the chat log).` : errorText(err), 'error');
    }
  }

  function renderWhois(w) {
    const online = Array.isArray(w.online) ? w.online : [];
    const account = w.account && typeof w.account === 'object' ? w.account : null;
    const addresses = Array.isArray(w.addresses) ? w.addresses.filter((a) => typeof a === 'string') : [];
    const first = online[0] || null;
    const subject = first
      ? toSubject(first, true)
      : toSubject({ name: account?.username || w.query, accountId: account?.accountId, username: account?.username, address: addresses[0] || null });

    const meta = [];
    const row = (k, ...v) => meta.push(h('dt', { text: k }), h('dd', null, ...v));
    row('Lookup', String(w.query ?? ''));
    row('Online', online.length
      ? online.map((p, i) => [i ? ', ' : '', `${p.name} in ${p.roomName || 'Zone lobby'}`])
      : h('span', { class: 'muted', text: 'not online' }));
    row('Account', account
      ? [account.username, account.admin ? [' ', pill('mod', 'pill-admin')] : null, h('span', { class: 'muted', text: ` · created ${formatDateTime(account.createdAt)} · last login ${formatDateTime(account.lastLogin)}` })]
      : h('span', { class: 'muted', text: 'guest (no account)' }));
    row('Addresses', addresses.length ? h('span', { class: 'mono', text: addresses.join(', ') }) : h('span', { class: 'muted', text: '—' }));
    const strikes = Number(w.strikes) || 0;
    row('Strikes', h('span', { class: `strikes${strikes >= HOT_STRIKES ? ' hot' : ''}`, text: `${strikes} in the last 10 min` }), ` · ${Number(w.flagged24h) || 0} flagged lines in 24 h`);
    $('whois-meta').replaceChildren(...meta);

    const btn = (text, cls, fn) => h('button', { class: `btn btn-small ${cls}`, type: 'button', text, on: { click: fn } });
    $('whois-buttons').replaceChildren(
      btn('Chat log', 'btn-primary', () => openLogFor({ player: subject.username || subject.name })),
      subject.online ? btn('Warn', 'btn-accent', () => void warnSubject(subject)) : null,
      subject.online ? btn('Kick', 'btn-warn', () => void kickSubject(subject)) : null,
      btn('Mute', 'btn-warn', () => void sanctionSubject('mute', subject)),
      btn('Ban', 'btn-danger', () => void sanctionSubject('ban', subject)),
    );

    fillRows($('whois-bans'), Array.isArray(w.activeBans) ? w.activeBans : [], 7, 'No active bans or mutes.', (b) => banRow(b, false));
    fillRows($('whois-actions'), Array.isArray(w.recentActions) ? w.recentActions : [], 5, 'No moderation history.', (a) => h('tr', null,
      timeCell(a.ts),
      h('td', { text: a.actor ?? '' }),
      h('td', null, pill(String(a.action ?? '?'), `pill-${a.action}`)),
      h('td', { class: 'nowrap', text: actionDurationText(a) }),
      h('td', { class: 'msg', text: a.reason ?? '' }),
    ));
    $('whois-view').hidden = false;
  }

  $('whois-form').addEventListener('submit', (e) => { e.preventDefault(); void runWhois($('whois-input').value); });

  // ---------------------------------------------------------------- CHAT LOG
  let logPager = pagerInit();
  const logSeq = latestOnly();
  const chatForm = /** @type {HTMLFormElement} */ ($('chat-filters'));

  function readChatForm() {
    const f = new FormData(chatForm);
    const get = (k) => String(f.get(k) ?? '');
    return { player: get('player'), grep: get('grep'), address: get('address'), roomId: get('roomId'), action: get('action'), range: get('range'), from: get('from'), to: get('to') };
  }

  function syncRange() {
    const custom = $('chat-range').value === 'custom';
    for (const n of chatForm.querySelectorAll('[data-custom-range]')) n.hidden = !custom;
  }
  $('chat-range').addEventListener('change', syncRange);

  function chatRow(row) {
    const subject = toSubject({ name: row.name, playerId: row.playerId, accountId: row.accountId, address: row.address }, isOnline(row));
    noteRoom(row.roomId, row.roomName);
    const roomBtn = row.roomId
      ? h('button', { class: 'link-btn', type: 'button', text: row.roomName || row.roomId, title: 'Only this room', on: { click: () => openLogFor({ roomId: row.roomId }) } })
      : h('span', { text: row.roomName || 'Zone' });
    const addr = row.address
      ? h('button', { class: 'link-btn mono small', type: 'button', text: row.address, title: 'Only this address', on: { click: () => openLogFor({ address: row.address }) } })
      : null;
    return h('tr', { class: chatRowClass(row.action) },
      timeCell(row.ts),
      h('td', null, roomBtn),
      h('td', null, nameButton(row.name, row.name), ' ', row.accountId ? pill('acct', 'pill-account') : pill('guest', 'pill-guest'), addr ? [h('br'), addr] : null),
      originalCell(row),
      shownCell(row),
      chatActionCell(row),
      h('td', { class: 'actions' }, h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-small btn-warn', type: 'button', text: 'Mute', on: { click: () => void sanctionSubject('mute', subject) } }),
        h('button', { class: 'btn btn-small btn-danger', type: 'button', text: 'Ban', on: { click: () => void sanctionSubject('ban', subject) } }),
      )),
    );
  }

  function isOnline(row) {
    return lastOnline.some((p) => p.playerId === row.playerId && p.name === row.name);
  }

  function syncLogButtons() {
    $('chat-prev').disabled = logPager.stack.length <= 1;
    $('chat-first').disabled = logPager.stack.length <= 1;
    $('chat-next').disabled = logPager.next === null;
  }

  async function loadLog() {
    if (!signedIn) return;
    const built = buildLogQuery(readChatForm(), pagerCursor(logPager));
    if (built.error) { setStatus($('chat-status'), built.error, 'error'); return; }
    const isCurrent = logSeq();
    // Until this page arrives, "Older" has no cursor to follow.
    logPager = pagerLoaded(logPager, null);
    syncLogButtons();
    setStatus($('chat-status'), 'Searching…');
    try {
      const r = await api.admin('log', built.query);
      if (!isCurrent()) return;
      const lines = Array.isArray(r.lines) ? r.lines : [];
      logPager = pagerLoaded(logPager, r.nextBefore);
      fillRows($('chat-body'), lines, 7, 'No chat lines match.', chatRow);
      $('chat-page-info').textContent = pagerLabel(logPager, lines.length);
      setStatus($('chat-status'), '');
    } catch (err) {
      if (isCurrent()) failStatus($('chat-status'), err);
    } finally {
      if (isCurrent()) syncLogButtons();
    }
  }

  /** Jump to the chat log with only these filters set. */
  function openLogFor(filters) {
    chatForm.reset();
    for (const [k, v] of Object.entries(filters)) {
      const input = chatForm.elements.namedItem(k);
      if (input && 'value' in input) {
        if (k === 'roomId' && typeof v === 'string' && !knownRooms.has(v)) noteRoom(v, v);
        input.value = String(v);
      }
    }
    syncRange();
    logPager = pagerInit();
    loaded.add('chat');
    showTab('chat');
    void loadLog();
  }

  chatForm.addEventListener('submit', (e) => { e.preventDefault(); logPager = pagerInit(); void loadLog(); });
  $('chat-clear').addEventListener('click', () => { chatForm.reset(); syncRange(); logPager = pagerInit(); void loadLog(); });
  $('chat-next').addEventListener('click', () => { logPager = pagerOlder(logPager); void loadLog(); });
  $('chat-prev').addEventListener('click', () => { logPager = pagerNewer(logPager); void loadLog(); });
  $('chat-first').addEventListener('click', () => { logPager = pagerInit(); void loadLog(); });

  // ---------------------------------------------------------------- REPORTS
  let reportsPager = pagerInit();
  let reportRows = [];
  let selectedReport = null;
  let reportsTimer = 0;

  const partyText = (p) => (p && typeof p === 'object' ? String(p.name || '?') : '?');

  function reportStatusPill(status) {
    return pill(String(status || '?'), `pill-${status === 'open' ? 'open' : status === 'dismissed' ? 'dismissed' : 'reviewed'}`);
  }

  const reportsSeq = latestOnly();
  async function loadReports() {
    if (!signedIn) return;
    const isCurrent = reportsSeq();
    reportsPager = pagerLoaded(reportsPager, null);
    $('reports-next').disabled = true;
    setStatus($('reports-list-status'), 'Loading…');
    const status = $('reports-status').value;
    const body = { status, limit: PAGE_SIZE };
    const cur = pagerCursor(reportsPager);
    if (cur !== null) body.before = cur;
    try {
      const r = await api.admin('reports', body);
      if (!isCurrent()) return;
      reportRows = Array.isArray(r.reports) ? r.reports : [];
      reportsPager = pagerLoaded(reportsPager, r.nextBefore);
      renderReportList();
      $('reports-page-info').textContent = pagerLabel(reportsPager, reportRows.length);
      setStatus($('reports-list-status'), '');
      if (status === 'open' && reportsPager.stack.length === 1) setOpenCount(reportRows.length, reportsPager.next !== null);
      if (selectedReport) {
        const fresh = reportRows.find((x) => x.id === selectedReport.id);
        if (fresh) showReport(fresh);
      }
    } catch (err) {
      if (isCurrent()) failStatus($('reports-list-status'), err);
    } finally {
      if (isCurrent()) {
        $('reports-prev').disabled = reportsPager.stack.length <= 1;
        $('reports-next').disabled = reportsPager.next === null;
      }
    }
  }

  function renderReportList() {
    fillRows($('reports-body'), reportRows, 5, 'No reports here.', (rep) => {
      const tr = h('tr', {
        class: `clickable${selectedReport && selectedReport.id === rep.id ? ' row-selected' : ''}`, tabindex: 0,
        'aria-label': `Report on ${partyText(rep.target)}`,
      },
      timeCell(rep.ts),
      h('td', { class: 'strong-cell', text: partyText(rep.target) }),
      h('td', { text: partyText(rep.reporter) }),
      h('td', { class: 'msg', text: rep.reason ?? '' }),
      h('td', null, reportStatusPill(rep.status)));
      tr.addEventListener('click', () => showReport(rep));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showReport(rep); } });
      return tr;
    });
  }

  function setOpenCount(n, more) {
    const c = $('reports-count');
    c.textContent = more ? `${n}+` : String(n);
    c.hidden = n === 0;
  }

  /** The Reports tab badge. Timer polls pause while the page is hidden; `force` (sign-in, after a review) always runs. */
  async function pollOpenReports(force = false) {
    if (!signedIn || (!force && document.hidden)) return;
    try {
      const r = await api.admin('reports', { status: 'open', limit: 200 });
      const rows = Array.isArray(r.reports) ? r.reports : [];
      setOpenCount(rows.length, r.nextBefore !== null && r.nextBefore !== undefined);
    } catch { /* the badge is best effort */ }
  }

  function showReport(rep) {
    selectedReport = rep;
    renderReportList();
    $('report-empty').hidden = true;
    $('report-view').hidden = false;
    setStatus($('report-status'), '');
    const t = rep.target && typeof rep.target === 'object' ? rep.target : {};
    const meta = [];
    const row = (k, ...v) => meta.push(h('dt', { text: k }), h('dd', null, ...v));
    row('Reported', nameButton(t.name, t.name), ' ', t.accountId ? pill('account', 'pill-account') : pill('guest', 'pill-guest'),
      t.address ? h('span', { class: 'mono muted', text: ` · ${t.address}` }) : null);
    row('Reported by', String(partyText(rep.reporter)));
    row('Reason', h('span', { class: 'quote', text: rep.reason ?? '' }));
    row('Room', String(rep.room || '—'));
    row('Filed', formatDateTime(rep.ts));
    row('Status', reportStatusPill(rep.status),
      rep.reviewedBy ? h('span', { class: 'muted', text: ` by ${rep.reviewedBy} · ${formatDateTime(rep.reviewedAt)}` }) : null);
    if (rep.note) row('Note', h('span', { class: 'quote', text: rep.note }));
    $('report-meta').replaceChildren(...meta);
    const chat = Array.isArray(rep.recentChat) ? rep.recentChat : [];
    fillRows($('report-chat-body'), chat, 5, 'No chat was attached.', (c) => h('tr', { class: chatRowClass(c.action) },
      timeCell(c.ts), h('td', { text: c.roomName || 'Zone' }), originalCell(c), shownCell(c), chatActionCell(c)));
    const open = rep.status === 'open';
    for (const id of ['report-ban', 'report-mute', 'report-warn', 'report-dismiss']) $(id).hidden = !open;
    $('report-reopen').hidden = open;
  }

  function reportSubject(rep) {
    const t = rep.target && typeof rep.target === 'object' ? rep.target : {};
    // Only trust the report's playerId while that same pilot is still connected (ids are per connection).
    return toSubject(t, typeof t.playerId === 'number' && lastOnline.some((p) => p.playerId === t.playerId && p.name === t.name));
  }

  async function reviewReport(rep, status, note) {
    try {
      const r = await api.admin('reports/review', { id: rep.id, status, ...(note ? { note: note.slice(0, NOTE_MAX) } : {}) });
      if (r.report && typeof r.report === 'object') showReport(r.report);
      setStatus($('report-status'), status === 'open' ? 'Report reopened.' : `Report ${status}.`, 'ok');
      void loadReports();
      void pollOpenReports(true);
      return true;
    } catch (err) {
      failStatus($('report-status'), err, 'Could not update the report: ');
      return false;
    }
  }

  $('report-ban').addEventListener('click', () => {
    const rep = selectedReport;
    if (!rep) return;
    // The reason is shown to the player, so it is never prefilled with the reporter's words.
    void sanctionSubject('ban', reportSubject(rep), {
      onDone: (v) => void reviewReport(rep, 'reviewed', `Banned (${durationLabel(v.duration)}): ${v.reason}`),
    });
  });
  $('report-mute').addEventListener('click', () => {
    const rep = selectedReport;
    if (!rep) return;
    void sanctionSubject('mute', reportSubject(rep), {
      onDone: (v) => void reviewReport(rep, 'reviewed', `Muted (${durationLabel(v.duration)}): ${v.reason}`),
    });
  });
  $('report-warn').addEventListener('click', () => {
    const rep = selectedReport;
    if (!rep) return;
    // Not connected under the same id → warn by name (the server finds them if they are online under it).
    void warnSubject(reportSubject(rep), { onDone: (v) => void reviewReport(rep, 'reviewed', `Warned: ${v.reason}`) });
  });
  $('report-dismiss').addEventListener('click', async () => {
    const rep = selectedReport;
    if (!rep) return;
    const v = await openDialog({
      title: 'Dismiss report', text: 'No action is taken against the player.', target: `Report on ${partyText(rep.target)}`,
      okLabel: 'Dismiss', okKind: 'primary', reason: { label: 'Note (optional)', required: false, max: NOTE_MAX, what: 'A note' },
    });
    if (v) void reviewReport(rep, 'dismissed', v.reason);
  });
  $('report-reopen').addEventListener('click', () => { if (selectedReport) void reviewReport(selectedReport, 'open', ''); });
  $('report-log').addEventListener('click', () => {
    const t = selectedReport?.target;
    if (t && typeof t === 'object' && t.name) openLogFor({ player: String(t.name) });
  });
  $('reports-status').addEventListener('change', () => { reportsPager = pagerInit(); void loadReports(); });
  $('reports-refresh').addEventListener('click', () => { reportsPager = pagerInit(); void loadReports(); });
  $('reports-next').addEventListener('click', () => { reportsPager = pagerOlder(reportsPager); void loadReports(); });
  $('reports-prev').addEventListener('click', () => { reportsPager = pagerNewer(reportsPager); void loadReports(); });

  // ---------------------------------------------------------------- BANS & MUTES
  let banDuration = DEFAULT_DURATION.ban;
  const banPresets = $('ban-presets');

  function syncBanPresets() {
    for (const b of banPresets.children) b.setAttribute('aria-pressed', String(b.dataset.id === banDuration));
  }
  for (const p of DURATION_PRESETS) {
    banPresets.appendChild(h('button', {
      class: 'preset', type: 'button', text: p.label, data: { id: p.id }, 'aria-pressed': 'false',
      on: { click: () => { banDuration = p.id; syncBanPresets(); } },
    }));
  }
  syncBanPresets();

  function syncBanForm() {
    const kind = $('ban-kind').value;
    const scope = $('ban-scope').value;
    $('ban-submit').textContent = kind === 'ban' ? 'Ban' : 'Mute';
    $('ban-submit').className = `btn ${kind === 'ban' ? 'btn-danger' : 'btn-warn'}`;
    $('ban-target-label').textContent = scope === 'target' ? 'Callsign or username' : 'Network address (as shown on the Live tab)';
    const hint = $('ban-scope-hint');
    hint.textContent = scope === 'address'
      ? 'Everyone on that network is affected, signed in or not. A whole school usually shares one address.'
      : scope === 'guest'
        ? 'Every guest (not signed in) on that network is affected. In a classroom that is usually most students.'
        : 'Account holders are sanctioned by account. A guest can be muted by callsign; banning a guest needs a network scope.';
    hint.className = `hint wide ${scope === 'target' ? 'info-hint' : 'warn-hint'}`;
    hint.hidden = false;
  }
  $('ban-kind').addEventListener('change', () => {
    banDuration = DEFAULT_DURATION[$('ban-kind').value] || '1d';
    syncBanPresets();
    syncBanForm();
  });
  $('ban-scope').addEventListener('change', syncBanForm);
  syncBanForm();

  $('ban-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = { kind: $('ban-kind').value, scope: $('ban-scope').value, target: $('ban-target').value, duration: banDuration, reason: $('ban-reason').value };
    const built = manualBanBody(form);
    if (built.error) { setStatus($('ban-status'), built.error, 'error'); return; }
    const b = built.body;
    const who = b.target ? String(b.target) : `${b.scope === 'address' ? 'everyone' : 'all guests'} on ${b.address}`;
    const verb = b.kind === 'ban' ? 'Ban' : 'Mute';
    const ok = await confirmBox(`${verb} ${who}?`,
      `${verb} for ${durationLabel(b.duration)}. Reason shown to the player: "${b.reason}"`,
      verb, b.kind === 'ban' ? 'danger' : 'warn');
    if (!ok) return;
    if (b.kind === 'ban' && b.duration === 'perm'
      && !(await confirmBox('Permanent ban?', 'This lasts until a moderator lifts it. A 1-day or 7-day ban is usually enough.', 'Ban permanently'))) return;
    await withBusy($('ban-submit'), async () => {
      const res = await createBan(b, `${verb} ${who}`);
      if (!res) { setStatus($('ban-status'), ''); return; }
      setStatus($('ban-status'), `${b.kind === 'ban' ? 'Banned' : 'Muted'} ${who}.`, 'ok');
      $('ban-target').value = '';
      $('ban-reason').value = '';
      afterChange();
      void loadBans();
    });
  });

  function banRow(b, withCreated = true) {
    const kindPill = pill(b.kind === 'ban' ? 'ban' : 'mute', b.kind === 'ban' ? 'pill-ban' : 'pill-muted');
    const active = b.active !== false;
    const cells = [
      h('td', null, kindPill, active ? null : [' ', pill(b.revokedAt ? 'lifted' : 'ended', 'pill-ended')]),
      h('td', null, pill(SCOPE_LABELS[b.scope] || String(b.scope || '?'), `pill-scope-${b.scope}`)),
      h('td', { class: 'msg', text: banTargetText(b) }),
      h('td', { class: 'msg', text: b.reason ?? '' }),
      h('td', { text: b.by ?? '' }),
    ];
    if (withCreated) cells.push(timeCell(b.createdAt));
    cells.push(h('td', { class: 'nowrap', title: b.expiresAt ? formatDateTime(b.expiresAt) : 'Permanent', text: active ? formatExpiry(b.expiresAt) : '—' }));
    cells.push(h('td', { class: 'actions' }, active
      ? h('button', { class: 'btn btn-small btn-ghost', type: 'button', text: 'Lift', on: { click: () => void revokeBan(b) } })
      : null));
    return h('tr', { class: active ? '' : 'row-ended' }, ...cells);
  }

  const bansSeq = latestOnly();
  async function loadBans() {
    if (!signedIn) return;
    const isCurrent = bansSeq();
    setStatus($('bans-status'), 'Loading…');
    try {
      const r = await api.admin('bans', { kind: $('bans-kind').value, includeInactive: $('bans-inactive').checked, limit: 500 });
      if (!isCurrent()) return;
      const rows = Array.isArray(r.bans) ? r.bans : [];
      fillRows($('bans-body'), rows, 8, $('bans-inactive').checked ? 'No bans or mutes yet.' : 'No active bans or mutes.', (b) => banRow(b));
      setStatus($('bans-status'), `${rows.length} shown`);
    } catch (err) {
      if (isCurrent()) failStatus($('bans-status'), err);
    }
  }
  $('bans-refresh').addEventListener('click', () => void loadBans());
  $('bans-kind').addEventListener('change', () => void loadBans());
  $('bans-inactive').addEventListener('change', () => void loadBans());

  // ---------------------------------------------------------------- ACTIONS (audit trail)
  let actionsPager = pagerInit();

  const actionsSeq = latestOnly();
  async function loadActions() {
    if (!signedIn) return;
    const isCurrent = actionsSeq();
    actionsPager = pagerLoaded(actionsPager, null);
    $('actions-next').disabled = true;
    setStatus($('actions-status'), 'Loading…');
    const body = { limit: 100 };
    const target = cleanText($('actions-target').value, NAME_MAX);
    if (target) body.target = target;
    const cur = pagerCursor(actionsPager);
    if (cur !== null) body.before = cur;
    try {
      const r = await api.admin('actions', body);
      if (!isCurrent()) return;
      const all = Array.isArray(r.actions) ? r.actions : [];
      const showReads = $('actions-reads').checked;
      const rows = showReads ? all : all.filter((a) => !isDashboardRead(a));
      actionsPager = pagerLoaded(actionsPager, r.nextBefore);
      fillRows($('actions-body'), rows, 6, all.length ? 'Only dashboard reads on this page (tick "Show dashboard reads").' : 'No moderation actions yet.', (a) => h('tr', null,
        timeCell(a.ts),
        h('td', { text: a.actor ?? '' }),
        h('td', null, pill(String(a.action ?? '?'), `pill-${a.action}`)),
        h('td', { class: 'msg', text: actionTargetText(a) }),
        h('td', { class: 'nowrap', text: actionDurationText(a) }),
        h('td', { class: 'msg', text: a.reason ?? '' }),
      ));
      const hidden = all.length - rows.length;
      $('actions-page-info').textContent = pagerLabel(actionsPager, rows.length) + (hidden ? ` · ${hidden} read${hidden === 1 ? '' : 's'} hidden` : '');
      setStatus($('actions-status'), '');
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof ApiError && err.status === 404 && target) { if (signedIn) setStatus($('actions-status'), `Nobody called "${target}" found.`, 'error'); }
      else failStatus($('actions-status'), err);
    } finally {
      if (isCurrent()) {
        $('actions-prev').disabled = actionsPager.stack.length <= 1;
        $('actions-next').disabled = actionsPager.next === null;
      }
    }
  }
  $('actions-form').addEventListener('submit', (e) => { e.preventDefault(); actionsPager = pagerInit(); void loadActions(); });
  $('actions-reads').addEventListener('change', () => { actionsPager = pagerInit(); void loadActions(); });
  $('actions-next').addEventListener('click', () => { actionsPager = pagerOlder(actionsPager); void loadActions(); });
  $('actions-prev').addEventListener('click', () => { actionsPager = pagerNewer(actionsPager); void loadActions(); });

  // ---------------------------------------------------------------- sign in / out
  function clearData() {
    for (const id of ['live-body', 'whois-meta', 'whois-buttons', 'whois-bans', 'whois-actions', 'chat-body', 'reports-body',
      'report-meta', 'report-chat-body', 'bans-body', 'actions-body']) $(id).replaceChildren();
    for (const id of ['live-count', 'chat-page-info', 'reports-page-info', 'actions-page-info', 'who-name']) $(id).textContent = '';
    for (const id of ['live-status', 'whois-status', 'chat-status', 'reports-list-status', 'report-status', 'bans-status', 'ban-status', 'actions-status']) setStatus($(id), '');
    $('whois-view').hidden = true;
    $('report-view').hidden = true;
    $('report-empty').hidden = false;
    $('reports-count').hidden = true;
    $('whois-input').value = '';
    chatForm.reset();
    syncRange();
    const roomSel = $('chat-room');
    while (roomSel.options.length > 1) roomSel.remove(1);
    knownRooms.clear();
    lastOnline = [];
    lastOnlineSig = '';
    reportRows = [];
    selectedReport = null;
    whoisQuery = '';
    logPager = pagerInit();
    reportsPager = pagerInit();
    actionsPager = pagerInit();
    loaded.clear();
  }

  function stopTimers() {
    clearInterval(liveTimer);
    clearInterval(reportsTimer);
    liveTimer = 0;
    reportsTimer = 0;
  }

  function showLogin(message = '', kind = '') {
    $('boot-msg').hidden = true;
    $('app-view').hidden = true;
    $('login-view').hidden = false;
    setStatus($('login-status'), message, kind);
    $('login-pass').value = '';
    ($('login-user').value ? $('login-pass') : $('login-user')).focus();
  }

  function showApp() {
    $('boot-msg').hidden = true;
    $('login-view').hidden = true;
    $('app-view').hidden = false;
    $('who-name').textContent = me?.username || '?';
    signedIn = true;
    showTab('live');
    scheduleLive();
    clearInterval(reportsTimer);
    reportsTimer = setInterval(() => void pollOpenReports(), REPORTS_POLL_MS);
    void pollOpenReports(true);
  }

  function leaveApp() {
    signedIn = false;
    me = null;
    stopTimers();
    if (dlgResolve) finishDialog(null);
    clearData();
  }

  /** 401 / 403 from any admin call: the session is gone or the account is not (or no longer) a moderator. */
  function authLost(status) {
    const token = tokens.get();
    const wasIn = signedIn;
    tokens.clear();
    leaveApp();
    // A valid session that is not a moderator's: end it, it's the account's normal 30-day game session.
    if (status === 403 && token) api.logout(token).catch(() => { /* best effort */ });
    if (status === 403) showLogin('This account is not a moderator.', 'error');
    else showLogin(wasIn ? 'Your session ended — sign in again.' : '', wasIn ? 'error' : '');
  }

  async function enter() {
    try {
      const r = await api.admin('me', {});
      if (!r.admin || typeof r.admin !== 'object') throw new ApiError(0, 'Unexpected answer from the server.');
      me = r.admin;
      showApp();
      return true;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return false; // authLost showed the login
      showLogin(errorText(err), 'error');
      return false;
    }
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const login = cleanText($('login-user').value, 254);
    const password = $('login-pass').value;
    if (!login || !password) { setStatus($('login-status'), 'Enter your username and password.', 'error'); return; }
    await withBusy($('login-submit'), async () => {
      setStatus($('login-status'), 'Signing in…');
      try {
        const r = await api.login(login, password);
        if (typeof r.token !== 'string' || !r.token) throw new ApiError(0, 'Unexpected answer from the server.');
        tokens.set(r.token);
        $('login-pass').value = '';
        const ok = await enter();
        if (ok) setStatus($('login-status'), '');
      } catch (err) {
        $('login-pass').value = '';
        setStatus($('login-status'), err instanceof ApiError && err.status === 401 ? 'Wrong username or password.' : errorText(err), 'error');
      }
    });
  });

  $('logout-btn').addEventListener('click', () => {
    const token = tokens.get();
    tokens.clear();
    leaveApp();
    showLogin('Signed out.', 'ok');
    if (token) api.logout(token).catch(() => { /* best effort: the local copy is already gone */ });
  });

  // Returning to the tab: refresh the live list at once instead of waiting for the timer.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !signedIn) return;
    if (currentTab === 'live') void loadOnline();
    void pollOpenReports();
  });

  // ---------------------------------------------------------------- start
  syncRange();
  if (tokens.get()) {
    $('boot-msg').textContent = 'Checking your session…';
    void enter();
  } else {
    showLogin();
  }
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.getElementById('login-view')) {
  try {
    boot();
  } catch (e) {
    const m = document.getElementById('boot-msg');
    if (m) { m.hidden = false; m.textContent = 'The dashboard failed to start — see the browser console.'; }
    console.error(e);
  }
}
