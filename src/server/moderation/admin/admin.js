// OWNER: ADMIN UI (B9). The Voidswarm Host Control Panel (docs/LAN-EDITION-proposal.md §5.2-§5.6, §5.15): `/` on the
// admin listener (http://localhost:7778) and `/admin` on the main port. Contract: ../adminApi.md and §5.15.
// No build step, no dependencies, CSP-safe (`script-src 'self'`, no `data:` images):
//   - no inline script / handlers (this file is an ES module loaded by admin.html), no eval, no CDN;
//   - ALL server/user text (chat, names, reasons, addresses) is rendered with textContent — never innerHTML;
//   - the admin session token lives in sessionStorage only and travels in the Authorization header, never in a URL;
//     localStorage holds one per-browser preference (Presenting), never a token.
// Privacy rules the page keeps (§5.2, §5.4, §5.5):
//   - Live and the Chat log show what OTHER players saw (the shown text, tag chips, the action). The original text is
//     never in the default DOM: it arrives only from log/reveal ★ (one audited call per click) and is shown under
//     the line; a substituted line is labelled, never presented as the student's words.
//   - SELF-HARM lines are the nameless "Wellbeing alert — needs your attention" until opened (★); while Presenting
//     such a row is those words only (no time, room, team, tags or buttons).
//   - Presenting hides names, chat text and emails, and locks Conduct and Accounts (a reauth to switch it off when the
//     session is stale). Home is projector-safe: counts, the Join card (the join address as text, no QR code:
//     owner decision 7) and rooms, never chat or names.
//   - A ★ call answered 401 `reauth` opens the password dialog in place and is retried once.
//   - Background refreshes (timers, returning to the tab) call PASSIVE routes only (http.ts ADMIN_ROUTES `passive`):
//     any other call counts as deliberate activity, which would keep an unattended panel signed in and its ★ step-up
//     fresh for ever (§4.10). The Reports badge therefore comes from `home`'s `openReports`, not from `reports`.
//   - The launcher's `#setup=` code is read once at start and removed from the address bar before any request.
// Two servers speak to this page: the LAN edition / host admin API (login { role, username, password }, `me` with
// capabilities), and — until app.ts wires the host admin on `npm start` — the v0.4 moderator API (a game account's
// /api/login and a fixed moderator capability set). The page finds out which one on sign-in.
// Pure helpers are exported (admin.test.ts runs them under node); the DOM app boots only inside the page, or in a test
// with a fake document (boot({ doc, win })).

// ============================================================================================================
// Constants
// ============================================================================================================

export const TOKEN_KEY = 'voidswarm.admin.token';
/** sessionStorage: 'legacy' when the token is a game-account token (the v0.4 moderator API). */
export const MODE_KEY = 'voidswarm.admin.mode';
/** localStorage: per-browser preferences (Presenting). Never a token. */
export const PREFS_KEY = 'voidswarm.admin.prefs';
export const ONLINE_REFRESH_MS = 5000;
export const HOME_REFRESH_MS = 5000;
export const ME_REFRESH_MS = 30000;
export const REPORTS_POLL_MS = 60000;
export const CLOCK_TICK_MS = 15000;
/** chat/live long-poll wait (s; the server caps it at 25). */
export const LIVE_WAIT_SEC = 25;
/** Live lines kept on the page. */
export const LIVE_KEEP = 500;
/** A Live poll that came back at once with nothing new waits this long (ms) before the next. */
export const LIVE_MIN_GAP_MS = 1000;
export const LIVE_RETRY_MS = 3000;
export const LIVE_BUSY_RETRY_MS = 5000;
/** Chat log page (§5.5: 100 per page). */
export const PAGE_SIZE = 100;
export const REVEAL_MAX = 100;
export const REASON_MAX = 200;
export const NOTE_MAX = 500;
export const GREP_MAX = 200;
export const NAME_MAX = 64;
export const ANNOUNCE_MAX = 200;
export const HOT_STRIKES = 3;
/** "This class period" and a named period: at most this many day ranges in one request (8 KB body limit). */
export const MAX_PERIOD_DAYS = 100;
/** §5.4: what a SELF-HARM line shows until it is opened (★). */
export const WELLBEING_TEXT = 'Wellbeing alert — needs your attention';
/** Shown instead of a name / chat text while Presenting. */
export const PRESENT_NAME = 'Player';
export const PRESENT_TEXT = 'Hidden while presenting';
/** §5.6 quick buttons. */
export const ANNOUNCE_QUICK = Object.freeze(['5 minutes left', 'Finish your match', 'Server restarting soon']);

/** Every admin endpoint the page calls (adminApi.md "Endpoints"; docs/LAN-EDITION-proposal.md §5.15). */
export const ENDPOINTS = Object.freeze([
  // session (setup/status, setup and login need no token)
  'setup/status', 'setup', 'login', 'reauth', 'logout', 'me',
  // Home, alerts
  'home', 'alerts/list', 'alerts/ack', 'wellbeing/open', 'wellbeing/ack',
  // Live, log, announcements
  'chat/live', 'log', 'log/context', 'log/reveal', 'log/rooms', 'log/stats', 'log/export', 'log/purge', 'announce',
  // settings (retention)
  'settings/get', 'settings/update',
  // moderation
  'online', 'reports', 'reports/review', 'bans', 'bans/create', 'bans/revoke', 'kick', 'warn', 'whois', 'actions',
  // custom terms (host only; M1: list, add, remove, test)
  'customTerms/list', 'customTerms/add', 'customTerms/remove', 'customTerms/test',
]);
/** The endpoints called without a session. */
export const SESSIONLESS = Object.freeze(['setup/status', 'setup', 'login']);

/**
 * The 12 tabs (§5.2) and the capability each needs. `me` returns the caller's capabilities; the page shows only the
 * tabs they allow (T-UI-3: a limited moderator sees Live, Rooms and Reports). `locked`: greyed out while Presenting.
 */
export const TABS = Object.freeze([
  Object.freeze({ id: 'home', label: 'Home', cap: 'status', locked: false }),
  Object.freeze({ id: 'live', label: 'Live', cap: 'live', locked: false }),
  Object.freeze({ id: 'chat', label: 'Chat log', cap: 'log', locked: false }),
  Object.freeze({ id: 'conduct', label: 'Conduct', cap: 'conduct', locked: true }),
  Object.freeze({ id: 'rooms', label: 'Rooms', cap: 'rooms.read', locked: false }),
  Object.freeze({ id: 'accounts', label: 'Accounts', cap: 'accounts', locked: true }),
  Object.freeze({ id: 'reports', label: 'Reports', cap: 'reports', locked: false }),
  Object.freeze({ id: 'bans', label: 'Bans & mutes', cap: 'ban', locked: false }),
  Object.freeze({ id: 'terms', label: 'Custom terms', cap: 'terms', locked: false }),
  Object.freeze({ id: 'settings', label: 'Settings', cap: 'settings', locked: false }),
  Object.freeze({ id: 'server', label: 'Server', cap: 'status', locked: false }),
  Object.freeze({ id: 'audit', label: 'Audit', cap: 'audit', locked: false }),
]);
export const TAB_IDS = Object.freeze(TABS.map((t) => t.id));

/**
 * The v0.4 moderator API (legacy `npm start`, no host admin yet): what a moderator account could do there. It has no
 * Live feed and no reveal endpoint, and its log answers with the original text: the page drops that text on every
 * page load, and Reveal reads it again with one `log` call narrowed to those lines (that API audits every log read), so
 * a reveal is one audited call there too.
 */
export const LEGACY_CAPS = Object.freeze(['rooms.read', 'whois', 'log', 'reports', 'reports.reporter', 'moderate', 'ban', 'addresses', 'audit']);

/** The tabs a capability list opens, in tab order. */
export function visibleTabs(caps) {
  const set = new Set(Array.isArray(caps) ? caps : []);
  return TABS.filter((t) => set.has(t.cap)).map((t) => t.id);
}

/** The first tab to show: Home when allowed (the launcher opens the Home tab), else Live, else Rooms, else the first. */
export function defaultTab(tabs) {
  for (const t of ['home', 'live', 'rooms']) if (tabs.includes(t)) return t;
  return tabs[0] ?? null;
}

/** "Host · this PC", "Host · remote (limited)", "Moderator (limited)". */
export function principalText(p, legacy = false) {
  if (legacy) return 'Moderator';
  if (!p || typeof p !== 'object') return '';
  if (p.kind === 'host') return p.via === 'local' ? 'Host · this PC' : p.via === 'full' ? 'Host · remote' : 'Host · remote (limited)';
  if (p.kind === 'moderator') return `Moderator (${p.tier === 'trusted' ? 'trusted' : 'limited'})`;
  return '';
}

// ============================================================================================================
// Durations
// ============================================================================================================

export const DURATION_PRESETS = Object.freeze([
  Object.freeze({ id: '10m', label: '10 min' }),
  Object.freeze({ id: '1h', label: '1 hour' }),
  Object.freeze({ id: '1d', label: '1 day' }),
  Object.freeze({ id: '7d', label: '7 days' }),
  Object.freeze({ id: 'perm', label: 'Permanent' }),
]);
/** §5.4 one-click mute lengths. */
export const QUICK_MUTES = Object.freeze(['10m', '1h', '1d']);
/** Classroom-safe defaults: short mutes, one-day bans. Permanent is always an explicit choice. */
export const DEFAULT_DURATION = Object.freeze({ ban: '1d', mute: '10m' });

export function isDurationPreset(id) {
  return DURATION_PRESETS.some((p) => p.id === id);
}

export function durationLabel(id) {
  const p = DURATION_PRESETS.find((x) => x.id === id);
  return p ? p.label : String(id ?? '');
}

/** The presets a principal may use for `kind`: without `ban` a mute is at most 1 day (§5.2 "Mute ≤ 24 h"). */
export function durationChoices(kind, caps) {
  const all = DURATION_PRESETS.map((p) => p.id);
  if (kind === 'mute' && !(Array.isArray(caps) && caps.includes('ban'))) return all.filter((d) => d === '10m' || d === '1h' || d === '1d');
  return all;
}

// ============================================================================================================
// Chat rows: actions, display, tags
// ============================================================================================================

/**
 * Chat filter verdicts (§5.15 Action). `hidden` = other players did not see the line (without a display value:
 * rows from before 0.6.0). 'flag' = shown as typed, a review-only term matched (never a strike).
 */
export const CHAT_ACTIONS = Object.freeze({
  pass: Object.freeze({ label: 'Passed', hidden: false }),
  flag: Object.freeze({ label: 'For review', hidden: false }),
  mask: Object.freeze({ label: 'Masked', hidden: false }),
  block: Object.freeze({ label: 'Blocked', hidden: true }),
  spam: Object.freeze({ label: 'Flood', hidden: true }),
  muted: Object.freeze({ label: 'Muted', hidden: true }),
});

export function chatActionInfo(action) {
  const known = Object.prototype.hasOwnProperty.call(CHAT_ACTIONS, action) ? CHAT_ACTIONS[action] : null;
  return known
    ? { id: action, label: known.label, hidden: known.hidden }
    : { id: 'unknown', label: String(action || '?'), hidden: false };
}

/** Table-row class for a chat line: blocked lines are red, masked yellow, for review cyan, flood/muted dimmed. */
export function chatRowClass(action) {
  if (action === 'block') return 'row-block';
  if (action === 'mask') return 'row-mask';
  if (action === 'flag') return 'row-flag';
  if (action === 'spam' || action === 'muted') return 'row-spam';
  return '';
}

/** What the others saw (§5.8 `display`). */
export const DISPLAY_INFO = Object.freeze({
  'as-typed': Object.freeze({ label: 'As typed' }),
  masked: Object.freeze({ label: 'Masked' }),
  substituted: Object.freeze({ label: 'Substituted' }),
  system: Object.freeze({ label: 'Substituted (system line)' }),
  hidden: Object.freeze({ label: 'Not shown' }),
  withheld: Object.freeze({ label: 'Withheld' }),
});

export function displayLabel(display) {
  return Object.prototype.hasOwnProperty.call(DISPLAY_INFO, display) ? DISPLAY_INFO[display].label : '';
}

export const CHANNEL_LABELS = Object.freeze({ all: 'Chat', team: 'Team', name: 'Callsign', room: 'Room name', announce: 'Announcement' });

/** shared/data/teams.ts TEAM_NAMES (the page has no build step to import it). */
export const TEAM_NAMES = Object.freeze(['Crimson', 'Azure', 'Verdant', 'Solar', 'Violet', 'Cyan', 'Ember', 'Rose']);

/** A team number as its name ('' for none: -1 free-for-all, -2 unassigned, the swarm). */
export function teamText(team) {
  return Number.isInteger(team) && team >= 0 && team < 100 ? TEAM_NAMES[team % TEAM_NAMES.length] : '';
}

/**
 * A room as Presenting shows it: "Room 2" from its id (r2, or the uid's `…:r2`), never its name. The client names a
 * new room after its creator by default ("NovaPilot's Arena"), so a room name can be a student's name on a projector.
 */
export function presentingRoomLabel(row) {
  const r = row && typeof row === 'object' ? row : {};
  const uid = typeof r.roomUid === 'string' ? r.roomUid : '';
  const id = typeof r.roomId === 'string' && r.roomId ? r.roomId : uid.slice(uid.lastIndexOf(':') + 1);
  const m = /^r(\d{1,6})$/.exec(id);
  return m ? `Room ${m[1]}` : 'Room';
}

/**
 * Where a line was said (§5.4): "Flag Run · Crimson (team chat)", "Zone lobby", "All rooms (announcement)". A Live
 * line brings its own `label` (service.ts liveLabel); a Chat log row is labelled here the same way. `presenting`:
 * the room by number (presentingRoomLabel), never by name.
 */
export function whereLabel(row, presenting = false) {
  const r = row && typeof row === 'object' ? row : {};
  if (!presenting && typeof r.label === 'string' && r.label) return r.label;
  const roomName = presenting ? presentingRoomLabel(r) : typeof r.roomName === 'string' && r.roomName ? r.roomName : 'Room';
  const inRoom = (typeof r.roomId === 'string' && r.roomId) || (typeof r.roomUid === 'string' && r.roomUid && !r.roomUid.endsWith(':zone'));
  if (r.channel === 'announce') return inRoom ? `${roomName} (announcement)` : 'All rooms (announcement)';
  const base = inRoom ? roomName : 'Zone lobby';
  const team = teamText(r.team);
  switch (r.channel) {
    case 'team': return `${base} · ${team || 'Team'} (team chat)`;
    case 'name': return `${base} (callsign)`;
    case 'room': return `${base} (room name)`;
    default: return team ? `${base} · ${team}` : base;
  }
}

/**
 * How the "what others saw" cell reads (§5.8 "Attribution"): a substitute is never presented as the student's words.
 *  { kind: 'text' | 'substituted' | 'masked' | 'hidden' | 'withheld', text, note }
 */
export function shownView(row) {
  const r = row && typeof row === 'object' ? row : {};
  const shown = typeof r.shown === 'string' ? r.shown : '';
  const display = typeof r.display === 'string' ? r.display : null;
  if (r.wellbeing === true || display === 'withheld') return { kind: 'withheld', text: '', note: 'Withheld (wellbeing)' };
  if (display === 'hidden') return { kind: 'hidden', text: '', note: 'Not shown to others' };
  if (display === 'substituted' || display === 'system') {
    return { kind: 'substituted', text: shown, note: `Others saw: “${shown}” (${display === 'system' ? 'substituted, as a system line' : 'substituted'})` };
  }
  if (display === 'masked') return { kind: 'masked', text: shown, note: 'Masked' };
  if (!display && chatActionInfo(r.action).hidden) return { kind: 'hidden', text: '', note: 'Not shown to others' };
  if (!shown) return { kind: 'hidden', text: '', note: 'Not shown to others' };
  return { kind: 'text', text: shown, note: '' };
}

/** "Others saw: “GG, pilots!” (substituted)" — the attribution line of views and exports. */
export function attributionText(row) {
  const v = shownView(row);
  if (v.kind === 'substituted') return v.note;
  if (v.kind === 'hidden' || v.kind === 'withheld') return v.note;
  return `Others saw: “${v.text}”`;
}

export const TAG_PROFANITY = 'PROFANITY';
export const TAG_VULGAR = 'VULGAR';
export const TAG_HATE = 'HATE';
export const TAG_THREAT = 'THREAT';
export const TAG_SELF_HARM = 'SELF-HARM';
export const TAG_GANG = 'GANG';
/** The built-in tags (§5.8), most severe first. */
export const BUILTIN_TAGS = Object.freeze([TAG_SELF_HARM, TAG_THREAT, TAG_HATE, TAG_VULGAR, TAG_PROFANITY, TAG_GANG]);
const TAG_CLASS = Object.freeze({
  [TAG_SELF_HARM]: 'tag-wellbeing', [TAG_THREAT]: 'tag-threat', [TAG_HATE]: 'tag-hate', [TAG_VULGAR]: 'tag-vulgar',
  [TAG_PROFANITY]: 'tag-profanity', [TAG_GANG]: 'tag-gang',
});
/** Built-in filter categories → tag (shared/room/moderation.ts tagsOf; the words themselves never reach the page). */
const CATEGORY_TAG = Object.freeze({
  profanity: TAG_PROFANITY, mild: TAG_PROFANITY, sexual: TAG_VULGAR, slur: TAG_HATE, hate: TAG_HATE, threat: TAG_THREAT, selfharm: TAG_SELF_HARM,
});

/** A tag chip's class. */
export function tagClass(tag) {
  return Object.prototype.hasOwnProperty.call(TAG_CLASS, tag) ? TAG_CLASS[tag] : 'tag-custom';
}

/** A tag as a safe label: A-Z, digits, '-' (custom categories come as their label). */
export function tagText(tag) {
  return String(tag ?? '').toUpperCase().replace(/[^A-Z0-9-]+/g, '').slice(0, 24);
}

/**
 * The tags of a row: its `tags`, else derived from hit labels (rows from the v0.4 API): `category:term`,
 * `custom:category:term`, `flag:category:term` → one tag per category. Never the terms.
 */
export function rowTags(row) {
  const r = row && typeof row === 'object' ? row : {};
  const out = [];
  const add = (t) => { const s = tagText(t); if (s && !out.includes(s)) out.push(s); };
  if (Array.isArray(r.tags)) { for (const t of r.tags) if (typeof t === 'string') add(t); return out; }
  if (Array.isArray(r.hits)) {
    for (const h of r.hits) {
      if (typeof h !== 'string') continue;
      const parts = h.split(':');
      let cat = parts[0];
      if ((cat === 'custom' || cat === 'flag') && parts.length >= 3) cat = parts[1];
      if (!cat) continue;
      const key = cat.toLowerCase();
      add(Object.prototype.hasOwnProperty.call(CATEGORY_TAG, key) ? CATEGORY_TAG[key] : key === 'gang' ? TAG_GANG : cat);
    }
  }
  return out;
}

/** A row about a self-harm statement (never named in the default views). */
export function isWellbeingRow(row) {
  const r = row && typeof row === 'object' ? row : {};
  return r.wellbeing === true || r.display === 'withheld' || rowTags(r).includes(TAG_SELF_HARM);
}

// ============================================================================================================
// Formatting
// ============================================================================================================

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

/** 812331 → "812,331". */
export function formatCount(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Bytes → "372 MB". */
export function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Aug 25" this year, "Aug 25, 2025" otherwise. */
export function formatDay(ms, now = Date.now()) {
  if (!validTime(ms)) return '—';
  const d = new Date(ms);
  const y = new Date(now).getFullYear();
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() === y ? '' : `, ${d.getFullYear()}`}`;
}

/** `HH:MM` local. */
export function formatClock(ms) {
  if (!validTime(ms)) return '—';
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** A room's time in the log: "Sep 28, 10:02–10:51" (the end's day too when it differs). */
export function roomSpanText(firstTs, lastTs, now = Date.now()) {
  if (!validTime(firstTs)) return '';
  const end = validTime(lastTs) ? lastTs : firstTs;
  const sameDay = isoDay(firstTs) === isoDay(end);
  return `${formatDay(firstTs, now)}, ${formatClock(firstTs)}–${sameDay ? '' : `${formatDay(end, now)}, `}${formatClock(end)}`;
}

/** When something happens next, in words: "tonight", "tomorrow", "Sep 30". */
export function formatWhen(ms, now = Date.now()) {
  if (!validTime(ms)) return '—';
  const d = new Date(ms);
  const n = new Date(now);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(n)) / 86_400_000);
  if (ms <= now) return 'soon';
  if (diff === 0) return d.getHours() >= 17 ? 'tonight' : 'today';
  if (diff === 1) return d.getHours() < 6 ? 'tonight' : 'tomorrow';
  return formatDay(ms, now);
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

/** `<input type="date">` value (`YYYY-MM-DD`) → local midnight in ms (`plusDays` later), or null. */
export function parseLocalDate(value, plusDays = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(y, mo - 1, d);
  if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d) return null;
  return new Date(y, mo - 1, d + plusDays).getTime();
}

/** Epoch ms → `YYYY-MM-DD` (local). */
export function isoDay(ms) {
  if (!validTime(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Trim, collapse control characters, cap length. Non-strings → ''. */
export function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

/** "3 lines" / "1 line". */
export function plural(n, one, many = `${one}s`) {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

// ============================================================================================================
// Class periods (Settings → Chat → Class periods; the Chat log's period filters)
// ============================================================================================================

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A valid period { name, start: 'HH:MM', end, days: 0..6 } or null. */
export function normalizePeriod(p) {
  if (!p || typeof p !== 'object') return null;
  const name = cleanText(p.name, 40);
  if (!name || !HHMM.test(String(p.start)) || !HHMM.test(String(p.end))) return null;
  const days = Array.isArray(p.days) ? p.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
  return { name, start: String(p.start), end: String(p.end), days: days.length ? days : [1, 2, 3, 4, 5] };
}

function atTime(dayMs, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(dayMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
}

/**
 * The time range of `period` on the local day of `dayMs` (end inclusive, to the last ms of the end minute), or null
 * when the period doesn't run that weekday.
 */
export function periodRangeOn(period, dayMs) {
  const p = normalizePeriod(period);
  if (!p) return null;
  const d = new Date(dayMs);
  if (!p.days.includes(d.getDay())) return null;
  const since = atTime(dayMs, p.start);
  let until = atTime(dayMs, p.end) + 59_999;
  if (until < since) until += 86_400_000; // a period past midnight
  return { since, until };
}

/** "This class period": the period running now, else the latest one that ran today; null when none. */
export function currentPeriod(periods, now = Date.now()) {
  const list = (Array.isArray(periods) ? periods : []).map(normalizePeriod).filter(Boolean);
  let best = null;
  for (const p of list) {
    const r = periodRangeOn(p, now);
    if (!r || r.since > now) continue;
    if (now <= r.until) return { period: p, range: r };
    if (!best || r.until > best.range.until) best = { period: p, range: r };
  }
  return best;
}

/** A named period on every day from `since` to `until` (local days), newest first, at most MAX_PERIOD_DAYS. */
export function periodRanges(period, since, until) {
  const out = [];
  if (!validTime(since) || !validTime(until) || until < since) return out;
  const start = new Date(since);
  let day = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  for (let i = 0; day <= until && i < 400; i++) {
    const r = periodRangeOn(period, day);
    if (r && r.until >= since && r.since <= until) out.push({ since: Math.max(r.since, since), until: Math.min(r.until, until) });
    const d = new Date(day);
    day = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  }
  return out.slice(-MAX_PERIOD_DAYS);
}

// ============================================================================================================
// Chat log requests
// ============================================================================================================

/** The "What happened" choices → the log filter (§5.5: shown, substituted, masked, blocked, flagged, flood, muted). */
export const LOG_ACTION_FILTERS = Object.freeze({
  shown: Object.freeze({ display: 'as-typed', legacy: { action: 'pass' } }),
  substituted: Object.freeze({ display: ['substituted', 'system'] }),
  masked: Object.freeze({ action: 'mask' }),
  block: Object.freeze({ action: 'block' }),
  flag: Object.freeze({ action: 'flag' }),
  spam: Object.freeze({ action: 'spam' }),
  muted: Object.freeze({ action: 'muted' }),
  flagged: Object.freeze({ action: 'flagged' }),
});
export const LOG_RANGES = Object.freeze(['', 'today', 'period', '60m', '7d', 'custom']);
export const LOG_CHANNELS = Object.freeze(['lobby', 'all', 'team', 'name', 'room', 'announce']);

/**
 * The Chat log's filter form → the `log` body (only the fields that are set) or `{ error }`.
 * form: { range, from, to, player, room, period, channel, action, tag, q, jump } (strings; `room` is
 * 'uid:<roomUid>' or 'id:<roomId>'). opts: { now, periods, cursor: { before, beforeTs } | number | null, limit, legacy }.
 */
export function buildLogQuery(form, opts = {}) {
  const f = form && typeof form === 'object' ? form : {};
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const legacy = !!opts.legacy;
  const q = {};
  const player = cleanText(f.player, NAME_MAX);
  if (player) q.player = player;
  const text = cleanText(f.q, GREP_MAX);
  if (text) q[legacy ? 'grep' : 'q'] = text;
  const room = cleanText(f.room, 100);
  if (room) {
    if (room.startsWith('uid:') && !legacy) q.roomUid = room.slice(4);
    else if (room.startsWith('id:')) q.roomId = room.slice(3);
    else return { error: 'Unknown room.' };
  }
  const channel = cleanText(f.channel, 16);
  if (channel) {
    if (!LOG_CHANNELS.includes(channel)) return { error: 'Unknown channel.' };
    if (!legacy) q.channel = channel;
  }
  const action = cleanText(f.action, 16);
  if (action) {
    if (!Object.prototype.hasOwnProperty.call(LOG_ACTION_FILTERS, action)) return { error: 'Unknown filter action.' };
    const m = LOG_ACTION_FILTERS[action];
    const use = legacy ? (m.legacy ?? (m.action ? { action: m.action } : null)) : m;
    if (use?.action) q.action = use.action;
    if (!legacy && m.display) q.display = m.display;
  }
  const tag = tagText(f.tag);
  if (tag && !legacy) q.tag = tag;

  const range = cleanText(f.range, 16);
  if (!LOG_RANGES.includes(range)) return { error: 'Unknown time range.' };
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  let since = null;
  let until = null;
  if (range === 'today') since = midnight;
  else if (range === '60m') since = now - 3_600_000;
  else if (range === '7d') since = now - 7 * 86_400_000;
  else if (range === 'custom') {
    const fromRaw = cleanText(f.from, 32);
    const toRaw = cleanText(f.to, 32);
    const from = fromRaw ? parseLocalDateTime(fromRaw) : null;
    const to = toRaw ? parseLocalDateTime(toRaw) : null;
    if (fromRaw && from === null) return { error: 'The "From" time is not valid.' };
    if (toRaw && to === null) return { error: 'The "To" time is not valid.' };
    if (from !== null && to !== null && from > to) return { error: '"From" must be before "To".' };
    since = from;
    until = to;
  } else if (range === 'period') {
    const cur = currentPeriod(opts.periods, now);
    if (!cur) return { error: 'No class period ran today (set class periods in Settings → Chat).' };
    since = cur.range.since;
    until = cur.range.until;
  }
  const jumpRaw = cleanText(f.jump, 16);
  if (jumpRaw) {
    const end = parseLocalDate(jumpRaw, 1);
    if (end === null) return { error: 'The jump date is not valid.' };
    until = until === null ? end - 1 : Math.min(until, end - 1);
  }
  const periodName = cleanText(f.period, 40);
  if (periodName) {
    if (legacy) return { error: 'Class periods need the LAN edition server.' };
    const period = (Array.isArray(opts.periods) ? opts.periods : []).map(normalizePeriod).find((p) => p && p.name === periodName);
    if (!period) return { error: 'Unknown class period.' };
    const lo = since ?? now - 30 * 86_400_000;
    const hi = until ?? now;
    const ranges = periodRanges(period, lo, hi);
    if (!ranges.length) return { error: `"${period.name}" didn't run in that time.` };
    q.ranges = ranges;
  }
  if (since !== null) q.since = since;
  if (until !== null) q.until = until;
  q.limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? PAGE_SIZE) || PAGE_SIZE));
  const c = opts.cursor;
  if (typeof c === 'number' && Number.isFinite(c)) q.before = c;
  else if (c && typeof c === 'object' && typeof c.before === 'number') {
    q.before = c.before;
    if (!legacy && typeof c.beforeTs === 'number') q.beforeTs = c.beforeTs;
  }
  return { query: q };
}

/** Reason / note field check. Returns { value } or { error }. */
export function checkReason(raw, { required = true, max = REASON_MAX, what = 'A reason' } = {}) {
  const value = cleanText(raw, max + 1);
  if (value.length > max) return { error: `${what} can be at most ${max} characters.` };
  if (required && !value) return { error: `${what} is required — the player sees it.` };
  return { value };
}

// ============================================================================================================
// Pager (newest-first lists; cursors are an id, or { before, beforeTs } for the new log)
// ============================================================================================================

/** Immutable: every step returns a new object. */
export function pagerInit() {
  return { stack: [null], next: null };
}
export function pagerCursor(p) {
  return p.stack[p.stack.length - 1];
}
export function pagerLoaded(p, nextBefore, nextBeforeTs) {
  let next = null;
  if (typeof nextBefore === 'number' && Number.isFinite(nextBefore)) {
    next = typeof nextBeforeTs === 'number' && Number.isFinite(nextBeforeTs) ? { before: nextBefore, beforeTs: nextBeforeTs } : nextBefore;
  }
  return { stack: p.stack, next };
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

/** "Showing 1–100" of a page (page size × page index). */
export function pageSpanText(p, shown, size = PAGE_SIZE) {
  if (!shown) return 'Showing none';
  const first = (p.stack.length - 1) * size + 1;
  return `Showing ${formatCount(first)}–${formatCount(first + shown - 1)}`;
}

/**
 * "latest request wins": each call to the returned function starts a request and returns `isCurrent()`, which is
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

// ============================================================================================================
// Live feed
// ============================================================================================================

/** chat/live body: the filters, the cursor and the wait. filters: { roomUid, channel, tag, player, flaggedOnly }. */
export function liveRequestBody(filters, after, waitSec = LIVE_WAIT_SEC) {
  const f = filters && typeof filters === 'object' ? filters : {};
  const b = { limit: LIVE_KEEP };
  if (typeof after === 'number' && Number.isInteger(after) && after >= 0) {
    b.after = after;
    b.wait = Math.max(0, Math.min(LIVE_WAIT_SEC, waitSec));
  }
  const roomUid = cleanText(f.roomUid, 80);
  if (roomUid) b.roomUid = roomUid;
  const channel = cleanText(f.channel, 16);
  if (channel && LOG_CHANNELS.includes(channel)) b.channel = channel;
  const tag = tagText(f.tag);
  if (tag) b.tag = tag;
  const player = cleanText(f.player, NAME_MAX);
  if (player) b.player = player;
  if (f.flaggedOnly === true) b.flaggedOnly = true;
  return b;
}

/** Newest-first merge of Live lines by `seq` (a line seen again replaces the old copy: its chatId may be known now). */
export function mergeLive(current, incoming, keep = LIVE_KEEP) {
  const by = new Map();
  for (const l of Array.isArray(current) ? current : []) if (l && Number.isInteger(l.seq)) by.set(l.seq, l);
  for (const l of Array.isArray(incoming) ? incoming : []) if (l && Number.isInteger(l.seq)) by.set(l.seq, { ...by.get(l.seq), ...l });
  return [...by.values()].sort((a, b) => b.seq - a.seq).slice(0, keep);
}

// ============================================================================================================
// Setup
// ============================================================================================================

/** The setup code the launcher put in the URL fragment (`#setup=K7QP-4MXD`), normalized, or ''. */
export function setupCodeFromHash(hash) {
  const m = /(?:^#|[#&])setup=([A-Za-z0-9-]{4,20})(?:&|$)/.exec(String(hash ?? ''));
  return m ? normalizeSetupCode(m[1]) : '';
}

/** Crockford-style display form: upper case, no spaces, `XXXX-XXXX`. */
export function normalizeSetupCode(v) {
  const s = String(v ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!s) return '';
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s.slice(0, 16);
}

/** At most this many Allowed email domains (the server's MAX_DOMAINS, settings/schema.ts). */
export const DOMAINS_MAX = 20;

/**
 * School setup's optional "Allowed email domains" (owner decision 6) → the list Settings → Accounts takes
 * ([{ domain, subdomains }]), or { error }. Entries are separated by commas, semicolons, spaces or new lines; a leading
 * "@" is dropped; "*.name" means name plus its subdomains, as does the `subdomains` tick for every entry. The server
 * does the real checks (IDN, public suffixes): this only catches what was clearly typed wrong. Empty = any domain.
 */
export function domainListOf(text, subdomains = false) {
  const out = [];
  for (const raw of String(text ?? '').split(/[\s,;]+/)) {
    let d = raw.trim().toLowerCase();
    if (!d) continue;
    let sub = subdomains === true;
    if (d.startsWith('@')) d = d.slice(1);
    if (d.startsWith('*.')) { sub = true; d = d.slice(2); }
    if (d.endsWith('.')) d = d.slice(0, -1);
    if (!d || /[@/\\:*?#]/.test(d) || !d.includes('.') || d.startsWith('.') || d.includes('..') || d.length > 253) {
      return { error: `"${raw.slice(0, 60)}" is not a domain. Type just the part after the @, like example.org.` };
    }
    const same = out.find((x) => x.domain === d);
    if (same) same.subdomains ||= sub;
    else out.push({ domain: d, subdomains: sub });
  }
  if (out.length > DOMAINS_MAX) return { error: `Allow at most ${DOMAINS_MAX} email domains.` };
  return { domains: out };
}

/**
 * The setup form → the `setup` body, or { error, field }. `first`: first run (preset, server name, accounts mode and,
 * for School, the optional Allowed email domains); after "Reset admin password" only the code and the login.
 */
export function setupBody(form, first = true) {
  const f = form && typeof form === 'object' ? form : {};
  const setupCode = normalizeSetupCode(f.setupCode);
  if (!setupCode) return { error: 'Enter the setup code from the Voidswarm window.', field: 'setupCode' };
  const username = cleanText(f.username, 64);
  if (username.length < 3 || username.length > 32) return { error: 'The admin username is 3 to 32 characters.', field: 'username' };
  const password = typeof f.password === 'string' ? f.password : '';
  if (password.length < 10 || password.length > 128) return { error: 'The password is 10 to 128 characters.', field: 'password' };
  if (password !== f.password2) return { error: 'The two passwords are not the same.', field: 'password2' };
  if (password.toLowerCase() === username.toLowerCase()) return { error: 'The password must not be the username.', field: 'password' };
  const body = { setupCode, username, password };
  if (first) {
    if (f.preset !== 'home' && f.preset !== 'school') return { error: 'Choose Home or School.', field: 'preset' };
    const serverName = cleanText(f.serverName, 61);
    if (!serverName || serverName.length > 60) return { error: 'Give the server a name (at most 60 characters).', field: 'serverName' };
    if (password.toLowerCase() === serverName.toLowerCase()) return { error: 'The password must not be the server name.', field: 'password' };
    body.preset = f.preset;
    body.serverName = serverName;
    body.accountsMode = f.preset === 'school' && f.accountsMode === 'email' ? 'email' : f.preset === 'school' ? 'roster' : 'email';
    if (f.preset === 'school') {
      const d = domainListOf(f.domains, f.domainsSubdomains === true);
      if (d.error) return { error: d.error, field: 'domains' };
      if (d.domains.length) body.domains = d.domains;
    }
  }
  return { body };
}

// ============================================================================================================
// Export, purge, announcements, retention
// ============================================================================================================

/** The log filter keys an export carries (§5.15 log/export: "filter + { format, all?, … }"). */
const EXPORT_KEYS = ['player', 'accountId', 'address', 'q', 'grep', 'tag', 'roomId', 'roomUid', 'action', 'display', 'channel', 'ranges', 'since', 'until'];

/**
 * The log/export body. filter: the current `log` query; o: { scope: 'filter'|'range'|'all', from, to (YYYY-MM-DD),
 * format, includeOriginal, includeWellbeing, saveOnHost }. Returns { body } or { error }.
 */
export function exportBody(filter, o = {}) {
  const format = o.format === 'json' ? 'json' : 'csv';
  const body = { format };
  if (o.scope === 'all') body.all = true;
  else if (o.scope === 'range') {
    const since = parseLocalDate(o.from, 0);
    const until = parseLocalDate(o.to, 1);
    if (since === null || until === null) return { error: 'Pick both dates.' };
    if (since >= until) return { error: '"From" must be before "To".' };
    body.since = since;
    body.until = until - 1;
  } else {
    const f = filter && typeof filter === 'object' ? filter : {};
    for (const k of EXPORT_KEYS) if (f[k] !== undefined && f[k] !== null && f[k] !== '') body[k] = f[k];
  }
  if (o.includeOriginal === true) body.includeOriginal = true;
  if (o.includeWellbeing === true) body.includeWellbeing = true;
  if (o.saveOnHost === true) body.saveOnHost = true;
  return { body };
}

/** The announce body, or { error }. target: '' (everyone) or a room id. */
export function announceBody(text, target) {
  const t = cleanText(text, ANNOUNCE_MAX + 1);
  if (!t) return { error: 'Type an announcement.' };
  if (t.length > ANNOUNCE_MAX) return { error: `An announcement is at most ${ANNOUNCE_MAX} characters.` };
  const body = { text: t };
  const room = cleanText(target, 32);
  if (room) body.roomId = room;
  return { body };
}

/** log/stats `retention` → "retention 90 days · next purge tonight". */
export function retentionText(r, now = Date.now()) {
  if (!r || typeof r !== 'object') return '';
  let rule;
  if (r.mode === 'forever') rule = 'kept until you delete it';
  else if (r.mode === 'term') rule = r.termEnd ? `until the term ends (${r.termEnd})` : 'until the term ends';
  else rule = `retention ${plural(Number(r.days) || 90, 'day')}`;
  const next = typeof r.nextPurgeAt === 'number' && r.nextPurgeAt > 0 ? ` · next purge ${formatWhen(r.nextPurgeAt, now)}` : '';
  return `${rule}${next}`;
}

/** The §5.5 header: "the log holds 812,331 lines since Aug 25 · 372 MB · retention 90 days · next purge tonight". */
export function statsText(s, now = Date.now()) {
  if (!s || typeof s !== 'object') return '';
  const parts = [`the log holds ${plural(Number(s.rows) || 0, 'line')}${validTime(s.oldest) ? ` since ${formatDay(s.oldest, now)}` : ''}`];
  const bytes = (Number(s.dbBytes) || 0) + (Number(s.walBytes) || 0);
  if (bytes) parts.push(formatBytes(bytes));
  const ret = retentionText(s.retention ? { ...s.retention, nextPurgeAt: s.nextPurgeAt ?? s.retention.nextPurgeAt } : null, now);
  if (ret) parts.push(ret);
  if (s.indexTidyPending) parts.push('search index tidies overnight');
  if (Number(s.dropped) > 0) parts.push(`${formatCount(Number(s.dropped))} lines NOT logged`);
  return parts.join(' · ');
}

/** The retention form → a settings/update patch, or { error }. */
export function retentionPatch(f, school = false) {
  const mode = f?.mode;
  if (mode !== 'days' && mode !== 'term' && mode !== 'forever') return { error: 'Pick how long chat is kept.' };
  const r = { mode };
  if (mode === 'days') {
    const days = Math.floor(Number(f.days));
    if (!Number.isFinite(days) || days < 1 || days > 3650) return { error: 'Days must be 1 to 3650.' };
    r.days = days;
  }
  if (mode === 'term') {
    if (parseLocalDate(f.termEnd) === null) return { error: "Set the term's end date." };
    r.termEnd = String(f.termEnd);
  }
  if (mode === 'forever' && school) {
    if (f.districtApproved !== true) return { error: 'Tick "My district approved keeping chat until I delete it".' };
    r.districtApproved = true;
  }
  return { patch: { chat: { retention: r } } };
}

// ============================================================================================================
// Session clock (idle and step-up countdowns)
// ============================================================================================================

/** { idleLeftMs, freshLeftMs, fresh } from a §5.15 Session at `now`. */
export function sessionClock(session, now = Date.now()) {
  const s = session && typeof session === 'object' ? session : {};
  const exp = typeof s.expiresAt === 'number' ? s.expiresAt : null;
  const fr = typeof s.freshUntil === 'number' ? s.freshUntil : 0;
  return { idleLeftMs: exp === null ? null : Math.max(0, exp - now), freshLeftMs: Math.max(0, fr - now), fresh: fr > now };
}

/** "Signs out in 23 min" / "Signs out in 45s". */
export function idleText(ms) {
  if (ms === null || ms === undefined) return '';
  if (ms <= 0) return 'Session ended';
  return `Signs out in ${formatSpan(Math.max(1000, Math.round(ms / 60000) * 60000 || ms))} without activity`;
}

/**
 * The page's background refreshes (timers, returning to the tab): they may call these endpoints only. Each is a
 * PASSIVE route on the server (http.ts ADMIN_ROUTES `passive`), which neither resets the idle clock nor keeps a ★
 * step-up fresh (§4.10). admin.test.ts checks both lists agree.
 */
export const BACKGROUND_ENDPOINTS = Object.freeze(['me', 'home', 'online', 'chat/live', 'alerts/list']);

// ============================================================================================================
// Home counts and the Reports badge
// ============================================================================================================

/**
 * The Reports badge from a passive reply (`home`; `me` too once it carries one): { open, more }, or null when the
 * reply has no count. A `reports` call is deliberate activity, so timers never make one (§4.10).
 */
export function openReportsOf(reply) {
  const o = reply && typeof reply === 'object' ? reply.openReports : undefined;
  const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (ok(o)) return { open: Math.floor(o), more: false };
  if (o && typeof o === 'object' && ok(o.open)) return { open: Math.floor(o.open), more: o.more === true };
  return null;
}

/**
 * The Home alert line (§5.3 counts without names, §5.11): the wellbeing alerts first, then the other urgent and banner
 * alerts, as [{ text, urgent }]. A wellbeing alert is urgent or banner (SELF-HARM notify; urgent when an urgent tag was
 * folded into it). With the per-level split (`wellbeingUrgent`, `wellbeingBanner`) each level lists only its other
 * alerts; without it the urgent and banner totals are shown whole ("in all"), so an urgent alert is never hidden.
 */
export function homeAlertParts(alerts) {
  const a = alerts && typeof alerts === 'object' ? alerts : {};
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const urgent = n(a.urgent);
  const banner = n(a.banner);
  const wb = n(a.wellbeing);
  const split = typeof a.wellbeingUrgent === 'number' && typeof a.wellbeingBanner === 'number';
  const wbUrgent = split ? Math.min(n(a.wellbeingUrgent), urgent) : 0;
  const wbBanner = split ? Math.min(n(a.wellbeingBanner), banner) : 0;
  const inAll = wb && !split ? ' in all' : '';
  const parts = [];
  if (wb) parts.push({ text: wb === 1 ? 'A wellbeing alert needs your attention' : `${wb} wellbeing alerts need your attention`, urgent: !split || wbUrgent > 0 });
  const otherUrgent = urgent - wbUrgent;
  const otherBanner = banner - wbBanner;
  if (otherUrgent) parts.push({ text: `${otherUrgent} urgent alert${otherUrgent === 1 ? '' : 's'}${inAll}`, urgent: true });
  if (otherBanner) parts.push({ text: `${otherBanner} alert${otherBanner === 1 ? '' : 's'}${inAll}`, urgent: false });
  return parts;
}

// ============================================================================================================
// Ban / action rows in words (Bans & mutes, Audit)
// ============================================================================================================

/** Who a BanRow applies to, in words. */
export function banTargetText(b) {
  if (!b || typeof b !== 'object') return '?';
  const addr = b.address || b.addressTag ? (b.address || `address ${b.addressTag}`) : '?';
  if (b.scope === 'account') return b.username || (b.accountId ? `account ${String(b.accountId).slice(0, 8)}` : 'account ?');
  if (b.scope === 'address') return `everyone on ${addr}`;
  if (b.scope === 'guest') return b.username ? `guest "${b.username}" on ${addr}` : `all guests on ${addr}`;
  return b.username || addr;
}

export const SCOPE_LABELS = Object.freeze({ account: 'Account', address: 'Network', guest: 'Guest' });

/** ActionRow → its target in words. */
export function actionTargetText(a) {
  if (!a || typeof a !== 'object') return '';
  const parts = [];
  if (a.targetName) parts.push(String(a.targetName));
  if (a.targetAddress) parts.push(`@ ${a.targetAddress}`);
  else if (a.targetAddressTag) parts.push(`@ tag ${a.targetAddressTag}`);
  if (!parts.length && a.targetAccountId) parts.push(`account ${String(a.targetAccountId).slice(0, 8)}`);
  return parts.join(' ');
}

/** ActionRow → its duration cell. */
export function actionDurationText(a) {
  if (!a || (a.action !== 'ban' && a.action !== 'mute')) return '';
  if (typeof a.durationSec === 'number' && Number.isFinite(a.durationSec) && a.durationSec > 0) return formatSpan(a.durationSec * 1000);
  return a.expiresAt === null || a.expiresAt === undefined ? 'Permanent' : '';
}

/** Panel reads are audited as `note` rows whose reason starts with "api " (coalesced per 60 s). */
export function isDashboardRead(a) {
  return !!a && a.action === 'note' && typeof a.reason === 'string' && /^api\s/.test(a.reason);
}

/** The Audit tab's actor / action filter (on the page just loaded). */
export function auditMatches(a, { actor = '', kind = '' } = {}) {
  if (!a || typeof a !== 'object') return false;
  const who = cleanText(actor, NAME_MAX).toLowerCase();
  if (who && !String(a.actor ?? '').toLowerCase().includes(who)) return false;
  if (kind && a.action !== kind) return false;
  return true;
}

// ============================================================================================================
// Sanction targeting (bans/create bodies)
// ============================================================================================================

/**
 * A person the host acts on, from any list: OnlinePlayer, ChatLogRow, LiveLine, report Party or whois.
 * { name, playerId, accountId, username, address, online }
 */
export function toSubject(src, online = false) {
  const o = src && typeof src === 'object' ? src : {};
  const str = (v) => (typeof v === 'string' && v ? v : null);
  return {
    name: str(o.name) || str(o.username) || '?',
    playerId: typeof o.playerId === 'number' && Number.isFinite(o.playerId) && o.playerId > 0 ? o.playerId : null,
    accountId: str(o.accountId),
    username: str(o.username),
    address: str(o.address),
    online: !!online,
  };
}

/**
 * Scope choices for a ban / mute of `subject`. Accounts are sanctioned per account. A guest mute can target just
 * that callsign on its network; a guest ban has to cover the network's guests (or everyone on it) — the panel says
 * plainly that this usually means the whole classroom. Without the address (moderators see a tag), a guest can be
 * muted by callsign only.
 */
export function scopeChoices(kind, subject) {
  if (subject.accountId || subject.username) {
    return [{ value: 'account', label: `Only this account (${subject.username || subject.name})`, hint: '' }];
  }
  const addr = subject.address || 'their network';
  const out = [];
  if (kind === 'mute') out.push({ value: 'guest-name', label: `Only the guest "${subject.name}"${subject.address ? ` on ${addr}` : ''}`, hint: '' });
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
    if (subject.playerId !== null && subject.online) body.playerId = subject.playerId;
    else body.target = subject.name;
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

// ============================================================================================================
// API client
// ============================================================================================================

export class ApiError extends Error {
  constructor(status, message, body = null, retryAfterSec = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * An answer lost on the way: a 400 with no body. The server's own 400s always carry a JSON error; this one is the
 * admin listener closing a connection (listeners.ts clientError), which Chrome can read as the answer to the NEXT
 * request it sends on that idle, pre-opened connection, while the server still runs that request.
 */
export function isLostAnswer(err) {
  return err instanceof ApiError && err.status === 400 && !err.body;
}

/**
 * Read-only endpoints (running them twice changes nothing but a folded read audit row), which the client sends once
 * more when the answer was lost (LOST_ANSWER_TRIES in all). Never the sign-in (a lost answer may still have counted a
 * password failure toward the lockout, or opened a session), a change, a ★ reveal, an export, or log/context (always
 * audited, row by row). The real fix is the listener's (it must not answer idle connections, listeners.ts): this is
 * the page's mitigation until then.
 */
export const LOST_ANSWER_RETRY = Object.freeze(['setup/status', 'me', 'home', 'online', 'chat/live', 'alerts/list', 'log', 'log/rooms', 'log/stats', 'reports', 'bans', 'actions', 'whois', 'settings/get']);
export const LOST_ANSWER_TRIES = 2;

/** The 401 that asks for the password again (§5.15 "401 `reauth`"). */
export function isReauth(err) {
  return err instanceof ApiError && err.status === 401 && !!err.body && (err.body.code === 'reauth' || err.body.reauth === true);
}

function statusMessage(status) {
  // A 400 without a JSON body is the listener refusing a broken connection, not the request's content.
  if (status === 400) return 'The connection was interrupted — try again.';
  if (status === 401) return 'Not signed in.';
  if (status === 403) return 'Not allowed for your role.';
  if (status === 404) return 'Not found.';
  if (status === 409) return 'That needs a confirmation.';
  if (status === 429) return 'Too many requests — wait a moment.';
  if (status === 501) return 'Not available in this version yet.';
  if (status === 503) return 'That is not available on this server right now.';
  if (status >= 500) return 'Server error — try again.';
  return `Request failed (${status}).`;
}

/** `attachment; filename="voidswarm-chat-2026-09-28_101500.csv"` → the file name (safe characters only). */
export function fileNameOf(disposition, fallback = 'export') {
  const m = /filename="?([^";]+)"?/i.exec(String(disposition ?? ''));
  const name = (m ? m[1] : '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return name || fallback;
}

/**
 * JSON-over-POST client. `fetchImpl(url, init)` is window.fetch in the page, a mock in tests.
 *  - onAuthLost(status, message): the session is gone (401, or the v0.4 API's 403 "Not a moderator").
 *  - onReauth(): a ★ call got 401 `reauth`: ask for the password (resolves true once reauth succeeded); the call is
 *    then retried once. Concurrent calls share one prompt.
 *  - isLegacy(): the token came from the v0.4 moderator API.
 *  - epoch(): the page's sign-in generation (bumped at every sign-out). An answer that lands after the epoch changed
 *    is dropped (ApiError 0 `aborted`): it belongs to a session that ended, and must not reach the next person's view,
 *    ask them for a password, or sign them out.
 *  - signal(): an AbortSignal for this sign-in's calls (aborted at sign-out) when the call brings none of its own.
 */
export function createApi({ fetchImpl, getToken, onAuthLost, onReauth, isLegacy = () => false, epoch = () => 0, signal = () => undefined }) {
  let pendingReauth = null;
  const cancelled = () => new ApiError(0, 'Cancelled.', { code: 'aborted' });

  async function raw(path, body, auth, extra = {}) {
    const headers = { 'Content-Type': 'application/json', Accept: extra.file ? '*/*' : 'application/json' };
    if (auth) {
      const token = getToken();
      if (!token) {
        const err = new ApiError(401, 'Not signed in.');
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
        ...(extra.signal ? { signal: extra.signal } : {}),
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new ApiError(0, 'Cancelled.', { code: 'aborted' });
      throw new ApiError(0, 'Cannot reach the server.');
    }
    const type = String(res.headers?.get?.('Content-Type') ?? '');
    if (extra.file && res.ok && !/application\/json/i.test(type)) return { res, data: null };
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const msg = data && typeof data.error === 'string' && data.error ? data.error : statusMessage(res.status);
      const ra = Number(res.headers?.get?.('Retry-After'));
      throw new ApiError(res.status, msg, data && typeof data === 'object' ? data : null, Number.isFinite(ra) && ra > 0 ? ra : null);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ApiError(res.status, 'Unexpected answer from the server.');
    return { res, data };
  }

  function lost(err) {
    if (!(err instanceof ApiError)) return;
    if (err.status === 401 && !isReauth(err)) onAuthLost?.(401, err.message);
    else if (err.status === 403 && isLegacy()) onAuthLost?.(403, err.message);
  }

  function askReauth() {
    if (!onReauth) return Promise.resolve(false);
    if (!pendingReauth) {
      pendingReauth = Promise.resolve().then(() => onReauth()).then((ok) => !!ok, () => false).finally(() => { pendingReauth = null; });
    }
    return pendingReauth;
  }

  /** raw(), sent again while the answer is lost on the way (LOST_ANSWER_RETRY endpoints only). */
  async function rawRetrying(endpoint, body, auth, extra = {}) {
    const again = LOST_ANSWER_RETRY.includes(endpoint);
    for (let i = 1; ; i++) {
      try {
        return await raw(`/api/admin/${endpoint}`, body, auth, extra);
      } catch (err) {
        if (!again || i >= LOST_ANSWER_TRIES || !isLostAnswer(err)) throw err;
      }
    }
  }

  async function call(endpoint, body, extra = {}) {
    if (!ENDPOINTS.includes(endpoint)) throw new ApiError(0, `Unknown endpoint ${endpoint}`);
    const auth = !SESSIONLESS.includes(endpoint);
    const at = epoch();
    const gone = () => epoch() !== at;
    let opts = extra;
    if (auth && !extra.signal) {
      const s = signal();
      if (s) opts = { ...extra, signal: s };
    }
    let out;
    try {
      out = await rawRetrying(endpoint, body, auth, opts);
    } catch (err) {
      if (gone()) throw cancelled();
      if (isReauth(err) && !extra.noReauth && endpoint !== 'reauth') {
        const ok = await askReauth();
        if (gone()) throw cancelled();
        if (!ok) throw err;
        try {
          out = await rawRetrying(endpoint, body, auth, opts);
        } catch (e2) {
          if (gone()) throw cancelled();
          lost(e2);
          throw e2;
        }
        if (gone()) throw cancelled();
        return out;
      }
      if (auth && endpoint !== 'reauth') lost(err);
      else if (endpoint === 'reauth' && err instanceof ApiError && err.status === 401 && !isReauth(err)) lost(err);
      throw err;
    }
    if (gone()) throw cancelled();
    return out;
  }

  return {
    /**
     * Sign in. The LAN edition's host admin API first (login { role, username, password }); a server without it (404:
     * the v0.4 moderator API) takes the game account's /api/login { login, password }.
     * Resolves { token, session, legacy }.
     */
    async login(role, username, password) {
      try {
        const { data } = await rawRetrying('login', { role, username, password }, false);
        if (typeof data.token !== 'string' || !data.token) throw new ApiError(0, 'Unexpected answer from the server.');
        return { token: data.token, session: data.session ?? null, legacy: false };
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 404) throw err;
      }
      const { data } = await raw('/api/login', { login: username, password }, false);
      if (typeof data.token !== 'string' || !data.token) throw new ApiError(0, 'Unexpected answer from the server.');
      return { token: data.token, session: null, legacy: true };
    },
    /** End the session (best effort). */
    async logout(token, legacy = false) {
      if (legacy) { await raw('/api/logout', { token }, false); return; }
      await raw('/api/admin/logout', {}, true);
    },
    async admin(endpoint, body = {}, extra = {}) {
      return (await call(endpoint, body, extra)).data;
    },
    /**
     * A file endpoint (exports): resolves { kind: 'file', blob, filename, rows } for a download, or
     * { kind: 'json', data } when the server answered JSON (Save on this PC).
     */
    async file(endpoint, body = {}, extra = {}) {
      const at = epoch();
      const { res, data } = await call(endpoint, body, { ...extra, file: true });
      if (data) return { kind: 'json', data };
      let blob;
      try { blob = await res.blob(); } catch (e) {
        if (epoch() !== at) throw cancelled();
        throw e;
      }
      if (epoch() !== at) throw cancelled();
      const rows = Number(res.headers?.get?.('X-Row-Count'));
      return { kind: 'file', blob, filename: fileNameOf(res.headers?.get?.('Content-Disposition')), rows: Number.isFinite(rows) ? rows : null };
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

/** sessionStorage-backed value with an in-memory fallback (storage may be blocked / throw). */
function createSessionValue(getStorage, key) {
  let memory = null;
  const storage = () => { try { return getStorage() ?? null; } catch { return null; } };
  return {
    get() {
      try {
        const v = storage()?.getItem(key);
        if (typeof v === 'string' && v) return v;
      } catch { /* blocked storage */ }
      return memory;
    },
    set(v) {
      memory = v;
      try { storage()?.setItem(key, v); } catch { /* memory only */ }
    },
    clear() {
      memory = null;
      try { storage()?.removeItem(key); } catch { /* nothing stored */ }
    },
  };
}

/** The admin session token: sessionStorage only (gone when the tab closes), with an in-memory fallback. */
export function createTokenStore(getStorage) {
  return createSessionValue(getStorage, TOKEN_KEY);
}

/** Per-browser preferences in localStorage (Presenting). Never a token; any failure = no preference. */
export function createPrefs(getStorage) {
  const read = () => {
    try {
      const v = JSON.parse(getStorage()?.getItem(PREFS_KEY) ?? 'null');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch { return {}; }
  };
  return {
    /** true / false, or null when never chosen in this browser. */
    presenting() {
      const v = read().presenting;
      return typeof v === 'boolean' ? v : null;
    },
    setPresenting(on) {
      try { getStorage()?.setItem(PREFS_KEY, JSON.stringify({ ...read(), presenting: !!on })); } catch { /* not remembered */ }
    },
  };
}

/**
 * Presenting at sign-in (§5.2, §5.13): a new sign-in follows the server's "Presenting on at login" (School) when it is
 * on; otherwise, and on a reload, the choice remembered in this browser (default off).
 */
export function presentingAtStart({ remembered, atLogin, freshLogin }) {
  if (freshLogin && atLogin === true) return true;
  return remembered === true;
}

// ============================================================================================================
// DOM helpers (exported for tests with a fake document)
// ============================================================================================================

/** Allowed element properties for h(); everything else is refused, so no markup / handler string can slip in. */
const SAFE_ATTRS = new Set(['id', 'type', 'value', 'name', 'title', 'role', 'tabindex', 'colspan', 'for', 'maxlength', 'placeholder', 'autocomplete', 'min', 'max']);

/**
 * Element builder bound to `doc`: h('td', { class: 'msg', text: userText }, child, …). Strings become text nodes
 * (textContent), `on: { click: fn }` adds listeners. There is deliberately no way to set innerHTML.
 */
export function makeH(doc) {
  function appendAll(parent, children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) appendAll(parent, c);
      else if (typeof c === 'object' && 'nodeType' in c) parent.appendChild(c);
      else parent.appendChild(doc.createTextNode(String(c)));
    }
  }
  return function h(tag, props, ...children) {
    const n = doc.createElement(tag);
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
  };
}

function pill(h, text, cls) {
  return h('span', { class: `pill ${cls || ''}`.trim(), text });
}

function tagChips(h, tags) {
  return tags.map((t) => h('span', { class: `tag ${tagClass(t)}`, text: t }));
}

function timeCell(h, ms, now) {
  return h('td', { class: 'nowrap', title: formatDateTime(ms), text: formatShortTime(ms, now) });
}

/** A player cell: the name (or the Presenting placeholder), account or guest, and the address or its tag. */
function playerCell(h, row, ctx) {
  if (ctx.presenting) return h('td', null, h('span', { class: 'redacted', text: PRESENT_NAME }));
  const name = typeof row.name === 'string' && row.name ? row.name : '?';
  const bits = [h('span', { class: 'who', text: name })];
  if (row.channel !== 'announce') {
    bits.push(' ', row.accountId ? pill(h, 'acct', 'pill-account') : pill(h, 'guest', 'pill-guest'));
    if (typeof row.address === 'string' && row.address) bits.push(h('div', { class: 'mono small muted', text: row.address }));
    else if (typeof row.addressTag === 'string' && row.addressTag) bits.push(h('div', { class: 'mono small muted', text: `address tag ${row.addressTag}` }));
  }
  if (row.online === true) bits.push(' ', h('span', { class: 'online-dot', title: 'Online now', text: '●' }));
  return h('td', null, ...bits);
}

/** The "what others saw" cell (§5.8 attribution), plus the revealed original when there is one. */
function shownCell(h, row, ctx, revealed) {
  const td = h('td', { class: 'msg' });
  if (isWellbeingRow(row)) {
    td.appendChild(h('span', { class: 'wellbeing-line', text: WELLBEING_TEXT }));
    return td;
  }
  if (ctx.presenting) {
    td.appendChild(h('span', { class: 'redacted', text: PRESENT_TEXT }));
    return td;
  }
  const v = shownView(row);
  if (v.kind === 'hidden') td.appendChild(h('span', { class: 'not-shown', text: `(${v.note.toLowerCase()})` }));
  else if (v.kind === 'substituted') {
    td.appendChild(h('span', { class: 'substituted', text: v.text }));
    td.appendChild(h('div', { class: 'attrib', text: v.note }));
  } else td.appendChild(h('span', { class: 'shown', text: v.text }));
  if (typeof revealed === 'string') {
    td.appendChild(h('div', { class: 'revealed' }, h('span', { class: 'revealed-label', text: 'Typed: ' }), h('span', { class: 'revealed-text', text: revealed })));
  }
  return td;
}

function whereCell(h, row, presenting = false) {
  return h('td', { class: 'where', text: whereLabel(row, presenting) });
}

/**
 * A wellbeing row while Presenting (§5.2, §5.11): "Wellbeing alert — needs your attention" and nothing else. The time,
 * the room and team label, the tag and action chips and the buttons would tie a self-harm statement, live on a
 * projector, to a few students on one team. `cols`: the table's column count; the text sits in column `at`.
 */
export function presentingWellbeingRow(h, cols, at = 3, text = WELLBEING_TEXT) {
  const tr = h('tr', { class: 'row-wellbeing' });
  for (let i = 0; i < cols; i++) tr.appendChild(i === at ? h('td', { class: 'msg' }, h('span', { class: 'wellbeing-line', text })) : h('td'));
  return tr;
}

function chipsCell(h, row, withAction) {
  const td = h('td', { class: 'chips' });
  const tags = rowTags(row);
  td.append(...tagChips(h, tags));
  if (withAction) {
    const a = chatActionInfo(row.action);
    if (row.action && row.action !== 'pass') td.appendChild(pill(h, a.label, `pill-${a.id}`));
    const d = row.display && row.display !== 'as-typed' && row.display !== 'withheld' ? displayLabel(row.display) : '';
    if (d) td.appendChild(pill(h, d.toLowerCase(), 'pill-display'));
  }
  return td;
}

/**
 * One Live line (§5.4) as a <tr>. ctx: { presenting, caps, now, revealed: Map<chatId, original>, on: { reveal,
 * context, mute, kick, warn, history, openWellbeing } }. Never renders `original` (the ring never sends it; a stray
 * one would be ignored), and a wellbeing line has no name, text or actions until opened ★.
 */
export function renderLiveLine(h, line, ctx) {
  const caps = new Set(ctx.caps ?? []);
  const on = ctx.on ?? {};
  const wellbeing = isWellbeingRow(line);
  if (wellbeing && ctx.presenting) return presentingWellbeingRow(h, 6);
  const revealed = !ctx.presenting && typeof line.chatId === 'number' ? ctx.revealed?.get(line.chatId) : undefined;
  const tr = h('tr', { class: `${chatRowClass(line.action)} live-line${wellbeing ? ' row-wellbeing' : ''}`.trim(), data: { seq: line.seq } });
  tr.append(timeCell(h, line.ts, ctx.now), whereCell(h, line, !!ctx.presenting));
  tr.appendChild(wellbeing ? h('td', { class: 'muted', text: '—' }) : playerCell(h, line, ctx));
  tr.append(shownCell(h, line, ctx, revealed), chipsCell(h, line, true));
  const acts = h('td', { class: 'actions' });
  const row = h('div', { class: 'btn-row' });
  const btn = (text, cls, fn, title) => h('button', { class: `btn btn-small ${cls}`, type: 'button', text, title, on: { click: fn } });
  if (wellbeing) {
    if (caps.has('wellbeing') && on.openWellbeing) row.appendChild(btn('Open ★', 'btn-accent', () => on.openWellbeing(line), 'Shows the student, the line and its context (asks for your password if needed; recorded)'));
  } else if (line.channel !== 'announce' && !ctx.presenting) {
    if (caps.has('moderate') && line.playerId > 0 && on.mute) row.appendChild(btn('Mute', 'btn-warn', () => on.mute(line)));
    if (caps.has('moderate') && line.playerId > 0 && line.online && on.kick) row.appendChild(btn('Kick', 'btn-warn', () => on.kick(line)));
    if (caps.has('moderate') && line.playerId > 0 && line.online && on.warn) row.appendChild(btn('Warn', 'btn-accent', () => on.warn(line)));
    if (caps.has('log') && on.context) row.appendChild(btn('Context', 'btn-ghost', () => on.context(line)));
    if (caps.has('log') && on.history) row.appendChild(btn('History', 'btn-ghost', () => on.history(line)));
    if (caps.has('reveal') && on.reveal && revealed === undefined && line.action !== 'pass') {
      row.appendChild(btn('Reveal ★', 'btn-ghost', () => on.reveal(line), 'Shows what was typed (recorded in the Audit tab)'));
    }
  }
  acts.appendChild(row);
  tr.appendChild(acts);
  return tr;
}

/**
 * One Chat log row (§5.5) as a <tr>: time, where, player, what others saw, the filter verdict, tags, actions. ctx
 * as renderLiveLine, plus `legacy` (the v0.4 API: no Context, no Open ★; Reveal reads the line again with `log`).
 */
export function renderLogRow(h, row, ctx) {
  const caps = new Set(ctx.caps ?? []);
  const on = ctx.on ?? {};
  const wellbeing = isWellbeingRow(row);
  if (wellbeing && ctx.presenting) return presentingWellbeingRow(h, 7);
  const revealed = ctx.presenting ? undefined : ctx.revealed?.get(row.id);
  const tr = h('tr', { class: `${chatRowClass(row.action)}${wellbeing ? ' row-wellbeing' : ''}`.trim(), data: { id: row.id } });
  tr.append(timeCell(h, row.ts, ctx.now), whereCell(h, row, !!ctx.presenting));
  // A wellbeing line is nameless in every default view (§5.4, §5.11): who and what open with ★.
  tr.appendChild(wellbeing ? h('td', { class: 'muted', text: '—' }) : playerCell(h, row, ctx));
  tr.appendChild(shownCell(h, row, ctx, wellbeing ? undefined : revealed));
  const verdict = h('td', { class: 'chips' });
  const a = chatActionInfo(row.action);
  verdict.appendChild(pill(h, a.label, `pill-${a.id}`));
  const d = row.display && row.display !== 'as-typed' ? displayLabel(row.display) : '';
  if (d) verdict.appendChild(h('div', null, pill(h, d.toLowerCase(), 'pill-display')));
  tr.appendChild(verdict);
  tr.appendChild(chipsCell(h, row, false));
  const acts = h('td', { class: 'actions' });
  const r = h('div', { class: 'btn-row' });
  const btn = (text, cls, fn, title) => h('button', { class: `btn btn-small ${cls}`, type: 'button', text, title, on: { click: fn } });
  if (wellbeing) {
    if (!ctx.presenting && !ctx.legacy && caps.has('wellbeing') && on.openWellbeing) {
      r.appendChild(btn('Open ★', 'btn-accent', () => on.openWellbeing(row), 'Shows the student, the line and its context (asks for your password if needed; recorded)'));
    }
  } else if (!ctx.presenting) {
    const canReveal = ctx.legacy ? caps.has('log') : caps.has('reveal');
    if (canReveal && on.reveal && revealed === undefined && row.channel !== 'announce') {
      r.appendChild(btn('Reveal ★', 'btn-ghost', () => on.reveal(row), 'Shows what was typed (recorded in the Audit tab)'));
    }
    if (!ctx.legacy && caps.has('log') && on.context) r.appendChild(btn('Context', 'btn-ghost', () => on.context(row)));
    if (row.channel !== 'announce' && caps.has('moderate') && on.mute) r.appendChild(btn('Mute', 'btn-warn', () => on.mute(row)));
    if (row.channel !== 'announce' && caps.has('ban') && on.ban) r.appendChild(btn('Ban', 'btn-danger', () => on.ban(row)));
  }
  acts.appendChild(r);
  tr.appendChild(acts);
  return tr;
}

// ============================================================================================================
// DOM app
// ============================================================================================================

/**
 * Start the panel. env: { doc, win } (the page: document and window; tests: a fake document). Returns a handle for
 * tests: { stop(), state() }.
 */
export function boot(env) {
  const doc = env.doc;
  const win = env.win;
  const h = makeH(doc);
  const $ = (id) => {
    const n = doc.getElementById(id);
    if (!n) throw new Error(`admin.html is missing #${id}`);
    return n;
  };
  const now = () => Date.now();

  const tokens = createTokenStore(() => win.sessionStorage);
  const modeStore = createSessionValue(() => win.sessionStorage, MODE_KEY);
  const prefs = createPrefs(() => win.localStorage);

  // The launcher's setup code (`#setup=K7QP-4MXD`): read once, into memory, and removed from the address bar and the
  // history at once, before any request and whatever the page shows next (§4.10: the code must not linger).
  let launchSetupCode = '';
  try {
    const hash = String(win.location?.hash ?? '');
    launchSetupCode = setupCodeFromHash(hash);
    if (/setup=/.test(hash)) win.history?.replaceState?.(null, '', `${win.location.pathname ?? '/'}${win.location.search ?? ''}`);
  } catch { /* keep going: the code can be typed */ }

  let signedIn = false;
  let legacy = modeStore.get() === 'legacy';
  let me = null; // { username, kind, accountId? }
  let session = null; // §5.15 Session
  let caps = [];
  let tabs = [];
  let presenting = false;
  let periods = [];
  let stopped = false;
  const timers = new Set();
  const every = (fn, ms) => { const t = setInterval(fn, ms); timers.add(t); return t; };
  const stopTimer = (t) => { if (t) { clearInterval(t); timers.delete(t); } };
  const can = (cap) => caps.includes(cap);

  // The sign-in generation: bumped at every sign-out (leaveApp). An answer, or a step of a multi-call flow, that
  // resumes after it changed belongs to a session that ended: it is dropped, so nothing private (a revealed original,
  // a wellbeing dialog, a context drawer) reaches the sign-in screen or the next person who signs in on this tab.
  let epoch = 0;
  let sessionCtrl = null;
  /** The AbortSignal of this sign-in's calls (aborted at sign-out). */
  function sessionSignal() {
    if (!sessionCtrl && typeof win.AbortController === 'function') {
      try { sessionCtrl = new win.AbortController(); } catch { sessionCtrl = null; }
    }
    return sessionCtrl?.signal;
  }
  function endEpoch() {
    epoch++;
    const c = sessionCtrl;
    sessionCtrl = null;
    try { c?.abort(); } catch { /* gone */ }
  }
  /** True while the flow that started in epoch `at` may still show what it fetched. */
  const still = (at) => at === epoch && signedIn && !stopped;

  const api = createApi({
    fetchImpl: (url, init) => win.fetch(url, init),
    getToken: () => tokens.get(),
    onAuthLost: (status, message) => authLost(status, message),
    onReauth: () => reauthPrompt(),
    isLegacy: () => legacy,
    epoch: () => epoch,
    signal: sessionSignal,
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

  /** A call failed: show it, unless the session just ended (authLost already showed the sign-in). */
  function failStatus(node, err, prefix = '') {
    if (!signedIn || (err instanceof ApiError && err.body?.code === 'aborted')) return;
    setStatus(node, `${prefix}${errorText(err)}`, 'error');
  }
  function failToast(prefix, err) {
    if (!signedIn || (err instanceof ApiError && err.body?.code === 'aborted')) return;
    toast(`${prefix}: ${errorText(err)}`, 'error');
  }

  function fillRows(tbody, rows, colCount, emptyText, rowFn) {
    const out = [];
    for (const r of rows) {
      try { out.push(rowFn(r)); } catch (e) { win.console?.warn?.('admin: skipped a malformed row', e); }
    }
    if (!out.length) out.push(h('tr', { class: 'empty' }, h('td', { colspan: colCount, text: emptyText })));
    tbody.replaceChildren(...out);
  }

  const shownName = (name) => (presenting ? PRESENT_NAME : name || '?');
  const shownText = (text) => (presenting ? PRESENT_TEXT : text ?? '');

  /** A player name that opens the lookup (plain text while Presenting). */
  function nameButton(name, lookup) {
    if (presenting) return h('span', { class: 'redacted', text: PRESENT_NAME });
    const label = name || '?';
    if (!can('whois')) return h('span', { class: 'who', text: label });
    return h('button', {
      class: 'link-btn', type: 'button', text: label, title: `Look up ${label}`,
      on: { click: () => { if (lookup) void runWhois(lookup); } },
    });
  }

  function accountPill(accountId, username) {
    return accountId || username ? pill(h, username && !presenting ? `acct ${username}` : 'account', 'pill-account') : pill(h, 'guest', 'pill-guest');
  }

  async function withBusy(button, fn) {
    if (button) button.disabled = true;
    try { return await fn(); } finally { if (button) button.disabled = false; }
  }

  // ---------------------------------------------------------------- generic dialog
  const dlg = $('dlg');
  let dlgResolve = null;
  let dlgValidate = null;
  /** The open dialog shows ★ content (a wellbeing alert opened): it closes when the step-up window lapses. */
  let dlgPrivate = false;

  /**
   * Modal form. opts: { title, text, target, okLabel, okKind ('danger'|'warn'|'accent'|'primary'),
   *   duration?: presetId, durations?: ids, scopes?: [{value,label,hint}], reason?: { label, required, max, value,
   *   placeholder }, date?: { label, value }, check?: { label } }.
   * Resolves { duration, scope, reason, date, checked } or null (cancelled).
   */
  function openDialog(opts) {
    // Signed out (a flow that resumed after Sign out): nothing opens over the sign-in screen.
    if (dlgResolve || !signedIn || stopped) return Promise.resolve(null);
    dlgPrivate = opts.private === true;
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
      const ids = opts.durations && opts.durations.length ? opts.durations : DURATION_PRESETS.map((p) => p.id);
      const sync = () => { for (const b of group.children) b.setAttribute('aria-pressed', String(b.dataset.id === duration)); };
      for (const p of DURATION_PRESETS.filter((x) => ids.includes(x.id))) {
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
    let dateInput = null;
    if (opts.date) {
      dateInput = h('input', { class: 'field', id: 'dlg-date', type: 'date' });
      dateInput.value = opts.date.value || '';
      fields.push(h('label', { class: 'lbl', for: 'dlg-date' }, opts.date.label || 'Date', dateInput));
    }
    let checkInput = null;
    if (opts.check) {
      checkInput = h('input', { type: 'checkbox', id: 'dlg-check' });
      fields.push(h('label', { class: 'check scope', for: 'dlg-check' }, checkInput, ' ', opts.check.label));
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
      const date = dateInput ? dateInput.value : '';
      if (opts.date && opts.date.required && !parseLocalDate(date)) return { error: 'Pick a date.' };
      return { value: { duration, scope, reason, date, checked: !!checkInput?.checked } };
    };

    return new Promise((resolve) => {
      dlgResolve = resolve;
      dlg.showModal();
      (reasonInput || dateInput || $('dlg-cancel')).focus();
    });
  }

  function finishDialog(value) {
    const r = dlgResolve;
    dlgResolve = null;
    dlgValidate = null;
    dlgPrivate = false;
    if (dlg.open) dlg.close();
    $('dlg-fields').replaceChildren();
    // What a dialog showed (a wellbeing alert: the student and what was typed) does not stay in the page.
    $('dlg-text').textContent = '';
    $('dlg-target').textContent = '';
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

  // ---------------------------------------------------------------- reauth (step-up, §4.10)
  const reauthDlg = $('reauth-dlg');
  let reauthResolve = null;

  /** Ask for the password (a ★ call got 401 `reauth`). Resolves true once reauth succeeded. */
  function reauthPrompt() {
    if (!signedIn || legacy) return Promise.resolve(false);
    if (reauthResolve) return new Promise((r) => { const prev = reauthResolve; reauthResolve = (v) => { prev(v); r(v); }; });
    setStatus($('reauth-error'), '');
    $('reauth-pass').value = '';
    return new Promise((resolve) => {
      reauthResolve = resolve;
      if (!reauthDlg.open) reauthDlg.showModal();
      $('reauth-pass').focus();
    });
  }
  function finishReauth(ok) {
    const r = reauthResolve;
    reauthResolve = null;
    $('reauth-pass').value = '';
    if (reauthDlg.open) reauthDlg.close();
    r?.(ok);
  }
  $('reauth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('reauth-pass').value;
    if (!password) { setStatus($('reauth-error'), 'Enter your password.', 'error'); return; }
    await withBusy($('reauth-ok'), async () => {
      try {
        const r = await api.admin('reauth', { password }, { noReauth: true });
        if (r.session && typeof r.session === 'object') applySession(r.session);
        finishReauth(true);
      } catch (err) {
        $('reauth-pass').value = '';
        if (!signedIn) { finishReauth(false); return; }
        setStatus($('reauth-error'), err instanceof ApiError && err.body?.wrongPassword ? 'That password is not right.' : errorText(err), 'error');
        $('reauth-pass').focus();
      }
    });
  });
  $('reauth-cancel').addEventListener('click', () => finishReauth(false));
  reauthDlg.addEventListener('cancel', (e) => { e.preventDefault(); finishReauth(false); });

  /** Run a ★ step now (Presenting off): fresh already, or after the password. */
  async function ensureFresh() {
    if (legacy) return true;
    if (sessionClock(session, now()).fresh) return true;
    return reauthPrompt();
  }

  // ---------------------------------------------------------------- session info, banners, presenting
  function applySession(s) {
    session = s;
    if (Array.isArray(s.capabilities)) setCaps(s.capabilities);
    renderClock();
  }

  function renderClock() {
    const c = sessionClock(session, now());
    const chip = $('fresh-chip');
    if (legacy || !session) {
      chip.hidden = true;
      $('idle-left').textContent = '';
      return;
    }
    chip.hidden = false;
    chip.textContent = c.fresh ? `Private views unlocked · ${formatSpan(c.freshLeftMs)}` : 'Private views locked 🔒';
    chip.classList.toggle('fresh', c.fresh);
    $('idle-left').textContent = idleText(c.idleLeftMs);
    // Stale means nothing revealed stays on screen: every ★ answer came while fresh, and the page reads `me` right
    // after one (revealIds, openWellbeing), so its clock is fresh while the server's is.
    if (!c.fresh && signedIn && (revealed.size > 0 || (dlgResolve && dlgPrivate))) lockPrivateViews();
  }

  /**
   * The ★ step-up window lapsed (§4.10: away for 10 minutes, the private views ask for the password again): what a
   * reveal showed leaves the page. Revealed originals are forgotten and the views re-drawn with the shown text; an open
   * wellbeing dialog closes; the context drawer keeps its lines but loses their originals.
   */
  function lockPrivateViews() {
    const had = revealed.size > 0;
    revealed.clear();
    if (dlgResolve && dlgPrivate) finishDialog(null);
    if (had) rerenderAll();
  }

  function renderBanners(list) {
    const items = (Array.isArray(list) ? list : []).filter((b) => b && typeof b.text === 'string').slice(0, 12);
    const order = { urgent: 0, warn: 1, info: 2 };
    items.sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3));
    $('banners').replaceChildren(...items.map((b) => h('div', {
      class: `banner banner-${b.level === 'urgent' ? 'urgent' : b.level === 'warn' ? 'warn' : 'info'}`, role: b.level === 'urgent' ? 'alert' : 'status',
      text: b.text,
    })));
  }

  function setCaps(list) {
    caps = list.filter((c) => typeof c === 'string');
    tabs = visibleTabs(caps);
    for (const t of TABS) {
      const btn = $(`tab-btn-${t.id}`);
      btn.hidden = !tabs.includes(t.id);
    }
    syncPresentingUi();
    syncFeatureButtons();
  }

  function syncFeatureButtons() {
    $('live-originals').hidden = !can('reveal');
    $('chat-originals').hidden = !(legacy ? can('log') : can('reveal'));
    $('chat-export').hidden = !can('log.export');
    $('chat-purge').hidden = !can('log.purge');
    $('retention-panel').hidden = !can('log.stats');
    $('retention-edit').hidden = !can('settings');
    $('announce-panel').hidden = !can('announce');
    $('export-original-row').hidden = !can('reveal');
    $('export-wellbeing-row').hidden = !can('wellbeing');
  }

  function syncPresentingUi() {
    const btn = $('presenting-btn');
    btn.textContent = presenting ? 'Presenting: on' : 'Presenting: off';
    btn.setAttribute('aria-pressed', String(presenting));
    $('presenting-note').hidden = !presenting;
    doc.body?.classList?.toggle('presenting', presenting);
    for (const t of TABS) {
      const b = $(`tab-btn-${t.id}`);
      const lock = presenting && t.locked;
      b.disabled = lock;
      b.classList.toggle('tab-locked', lock);
      b.title = lock ? 'Switch Presenting off to open this tab' : '';
    }
    if (presenting && TABS.find((t) => t.id === currentTab)?.locked) showTab(defaultTab(tabs) ?? 'live');
  }

  async function setPresenting(on, remember = true) {
    if (!on && presenting && !legacy && !(await ensureFresh())) return; // §5.2: off needs a reauth when stale
    presenting = !!on;
    if (remember) prefs.setPresenting(presenting);
    syncPresentingUi();
    rerenderAll();
  }
  $('presenting-btn').addEventListener('click', () => void setPresenting(!presenting));

  function rerenderAll() {
    renderLive();
    renderLog();
    renderOnline(lastOnline, true);
    if (selectedReport) showReport(selectedReport);
    renderReportList();
    if (lastHome) renderHome(lastHome);
    if (alertsOpen) renderAlerts();
    if (ctxDlg.open) renderContextRows();
    syncLiveRooms();
    syncLogRooms();
  }

  // ---------------------------------------------------------------- tabs
  let currentTab = null;
  const loaded = new Set();

  function showTab(name, focus = false) {
    if (!tabs.includes(name)) return;
    const def = TABS.find((t) => t.id === name);
    if (presenting && def?.locked) { toast('Switch Presenting off to open this tab.'); return; }
    const prev = currentTab;
    currentTab = name;
    for (const t of TABS) {
      const on = t.id === name;
      const b = $(`tab-btn-${t.id}`);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      $(`tab-${t.id}`).hidden = !on;
    }
    if (focus) $(`tab-btn-${name}`).focus();
    if (prev === 'live' && name !== 'live') stopLive();
    if (name === 'live') startLive();
    if (name === 'home') void loadHome();
    if (name === 'rooms') void loadOnline(true);
    if (!loaded.has(name)) {
      loaded.add(name);
      if (name === 'chat') void openChatLog();
      if (name === 'reports') void loadReports();
      if (name === 'bans') void loadBans();
      if (name === 'terms') void loadTerms();
      if (name === 'audit') void loadActions();
    }
  }
  for (const t of TABS) {
    const b = $(`tab-btn-${t.id}`);
    b.addEventListener('click', () => showTab(t.id));
    b.addEventListener('keydown', (e) => {
      const list = tabs.filter((x) => !(presenting && TABS.find((d) => d.id === x)?.locked));
      const i = list.indexOf(t.id);
      const j = nextTabIndex(i, e.key, list.length);
      if (j !== i && j >= 0) { e.preventDefault(); showTab(list[j], true); }
    });
  }

  // ---------------------------------------------------------------- moderation actions (shared by every tab)
  function afterChange() {
    if (currentTab === 'rooms') void loadOnline(true);
    if (currentTab === 'bans') void loadBans();
    if (currentTab === 'chat') void loadLog();
    if (currentTab === 'audit') void loadActions();
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
    if (!scopes.length) { toast(`Can't ${kind} ${shownName(subject.name)}: their network address is unknown and they have no account.`, 'error'); return false; }
    const isBan = kind === 'ban';
    const durations = extra.durations ?? durationChoices(kind, caps);
    const v = await openDialog({
      title: isBan ? 'Ban player' : 'Mute player',
      text: isBan
        ? 'A ban disconnects them now and keeps them out until it ends.'
        : 'A mute keeps them in the game but nobody sees their chat until it ends.',
      target: presenting ? PRESENT_NAME : `${subject.name}${subject.username && subject.username !== subject.name ? ` (account ${subject.username})` : ''}${subject.address ? ` · ${subject.address}` : ''}`,
      okLabel: isBan ? 'Ban' : 'Mute',
      okKind: isBan ? 'danger' : 'warn',
      duration: durations.includes(DEFAULT_DURATION[kind]) ? DEFAULT_DURATION[kind] : durations[0],
      durations,
      scopes,
      reason: { label: 'Reason (shown to the player)', required: true, value: extra.reason || '' },
    });
    if (!v) return false;
    if (isBan && v.duration === 'perm') {
      const sure = await confirmBox('Permanent ban?', `${shownName(subject.name)} will be banned until the host lifts it. A 1-day or 7-day ban is usually enough.`, 'Ban permanently');
      if (!sure) return false;
    }
    const built = banCreateBody({ kind, subject, scope: v.scope, duration: v.duration, reason: v.reason });
    if (built.error) { toast(built.error, 'error'); return false; }
    const res = await createBan(built.body, `${isBan ? 'Ban' : 'Mute'} ${shownName(subject.name)}`);
    if (!res) return false;
    const kicked = Number(res.kicked) || 0;
    toast(`${isBan ? 'Banned' : 'Muted'} ${shownName(subject.name)} (${durationLabel(v.duration)})${isBan && kicked ? ` — ${kicked} connection${kicked === 1 ? '' : 's'} closed` : ''}.`, 'ok');
    extra.onDone?.(v, res);
    afterChange();
    return true;
  }

  function subjectRef(subject) {
    return subject.playerId !== null && subject.online ? { playerId: subject.playerId } : { target: subject.username || subject.name };
  }

  async function kickSubject(subject) {
    const v = await openDialog({
      title: 'Kick player', text: 'They are disconnected now but can reconnect right away.', target: shownName(subject.name),
      okLabel: 'Kick', okKind: 'warn', reason: { label: 'Reason (shown to the player, optional)', required: false },
    });
    if (!v) return;
    try {
      const r = await api.admin('kick', { ...subjectRef(subject), reason: v.reason });
      toast(Number(r.kicked) ? `Kicked ${shownName(subject.name)}.` : `${shownName(subject.name)} is not online.`, Number(r.kicked) ? 'ok' : '');
      afterChange();
    } catch (err) { failToast(`Kick ${shownName(subject.name)}`, err); }
  }

  /** Returns true when the warning was delivered. */
  async function warnSubject(subject, extra = {}) {
    const v = await openDialog({
      title: 'Warn player', text: 'They see "Warning from a moderator: <your message>" in their chat.', target: shownName(subject.name),
      okLabel: 'Send warning', okKind: 'accent', reason: { label: 'Message', required: true, what: 'A message', value: extra.reason || '' },
    });
    if (!v) return false;
    try {
      const r = await api.admin('warn', { ...subjectRef(subject), reason: v.reason });
      if (!Number(r.warned)) { toast(`${shownName(subject.name)} is not online, so the warning was not delivered.`, 'error'); return false; }
      toast(`Warned ${shownName(subject.name)}.`, 'ok');
      extra.onDone?.(v);
      afterChange();
      return true;
    } catch (err) {
      failToast(`Warn ${shownName(subject.name)}`, err);
      return false;
    }
  }

  async function revokeBan(b) {
    const what = `${b.kind === 'ban' ? 'ban' : 'mute'} on ${presenting ? PRESENT_NAME : banTargetText(b)}`;
    if (!(await confirmBox(b.kind === 'ban' ? 'Lift ban?' : 'Lift mute?', `Lift the ${what}?`, 'Lift', 'primary'))) return;
    try {
      await api.admin('bans/revoke', { id: b.id });
      toast(`Lifted the ${what}.`, 'ok');
      afterChange();
    } catch (err) { failToast(`Lift ${what}`, err); }
  }

  async function unmuteSubject(subject) {
    if (!(await confirmBox('Lift mute?', `Lift every active mute that applies to ${shownName(subject.name)}? This includes a network-wide mute on their address, which unmutes everyone it covered.`, 'Unmute', 'primary'))) return;
    try {
      const r = await api.admin('bans/revoke', { target: subject.username || subject.name, kind: 'mute' });
      const n = Number(r.revoked) || 0;
      toast(n ? `Unmuted ${shownName(subject.name)} (${n} mute${n === 1 ? '' : 's'} lifted).` : `No active mute found for ${shownName(subject.name)}.`, n ? 'ok' : 'error');
      afterChange();
    } catch (err) { failToast(`Unmute ${shownName(subject.name)}`, err); }
  }

  // ---------------------------------------------------------------- reveal (★, audited per call)
  /** chat id → original text, for this page view only (never stored). */
  const revealed = new Map();

  /**
   * Reveal the original text of these lines: one log/reveal call (audited server-side). Returns how many came back.
   * An answer that lands after Sign out is dropped (the api throws `aborted`; `still` is the second guard).
   */
  async function revealIds(ids) {
    const list = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0 && !revealed.has(x)))].slice(0, REVEAL_MAX);
    if (!list.length) return 0;
    const at = epoch;
    const r = await api.admin('log/reveal', { ids: list });
    if (!still(at)) throw new ApiError(0, 'Cancelled.', { code: 'aborted' });
    let n = 0;
    for (const o of Array.isArray(r.originals) ? r.originals : []) {
      if (o && Number.isInteger(o.id) && typeof o.original === 'string') { revealed.set(o.id, o.original); n++; }
    }
    for (const id of list) if (!revealed.has(id)) revealed.set(id, '');
    // That ★ call refreshed the server's step-up window: read it, so the page's clock does not lock the views early.
    if (!legacy) void refreshMe();
    return n;
  }

  // ---------------------------------------------------------------- HOME
  let homeTimer = 0;
  let lastHome = null;
  let lastHomeAt = 0;
  let alertsOpen = false;
  let lastAlerts = [];
  const homeSeq = latestOnly();

  /** home (passive): the Join card, rooms and counts. An answer under 1.5 s old is reused (sign-in reads it first). */
  async function loadHome(force = false) {
    if (!signedIn || !can('status')) return;
    if (!force && lastHome && now() - lastHomeAt < 1500) { renderHome(lastHome); return; }
    const isCurrent = homeSeq();
    try {
      const r = await api.admin('home', {});
      if (!isCurrent()) return;
      lastHome = r;
      lastHomeAt = now();
      if (Array.isArray(r.classPeriods)) setPeriods(r.classPeriods);
      noteOpenReports(r);
      renderHome(r);
      setStatus($('home-status'), '');
    } catch (err) {
      if (isCurrent()) failStatus($('home-status'), err);
    }
  }

  function renderHome(r) {
    const join = r.join && typeof r.join === 'object' ? r.join : {};
    $('server-name').textContent = typeof r.serverName === 'string' && r.serverName ? r.serverName : 'Host Control Panel';
    $('join-name').textContent = typeof r.serverName === 'string' ? r.serverName : '';
    // No join address: the server's reason is the line below; the headline stays neutral (it may not be setup).
    $('join-url').textContent = typeof join.url === 'string' && join.url ? join.url : 'Players can’t join yet.';
    const sec = typeof join.secureUrl === 'string' && join.secureUrl && join.secureUrl !== join.url ? join.secureUrl : '';
    $('join-secure').textContent = sec ? `Secure: ${sec}` : '';
    $('join-secure').hidden = !sec;
    $('join-not-serving').textContent = typeof join.notServing === 'string' ? join.notServing : '';
    $('join-not-serving').hidden = !join.notServing;
    $('join-fp').textContent = join.fingerprint ? `Certificate fingerprint: ${join.fingerprint}` : '';
    $('join-fp').hidden = !join.fingerprint;
    const others = Array.isArray(join.others) ? join.others.filter((o) => typeof o === 'string') : [];
    $('join-others').replaceChildren(...others.map((o) => h('li', { text: o })));
    $('join-others-box').hidden = !others.length;
    const counts = r.counts && typeof r.counts === 'object' ? r.counts : {};
    const online = r.online && typeof r.online === 'object' ? r.online : { total: counts.online };
    $('home-online').textContent = formatCount(Number(online.total) || 0);
    $('home-online-split').textContent = typeof online.accounts === 'number' ? `${online.accounts} with accounts · ${online.guests ?? 0} guests` : '';
    const rooms = Array.isArray(r.rooms) ? r.rooms : [];
    $('home-rooms-n').textContent = formatCount(rooms.length);
    const playing = rooms.filter((x) => x.phase === 'playing').length;
    $('home-playing').textContent = `${playing} playing`;
    const a = r.alerts && typeof r.alerts === 'object' ? r.alerts : {};
    const total = (Number(a.urgent) > 0 ? Math.floor(a.urgent) : 0) + (Number(a.banner) > 0 ? Math.floor(a.banner) : 0);
    const line = $('home-alerts');
    const bits = homeAlertParts(a).map((p) => h('span', { class: p.urgent ? 'alert-count urgent' : 'alert-count', text: p.text }));
    if (!bits.length) bits.push(h('span', { class: 'muted', text: 'No open alerts.' }));
    if (total) bits.push(h('button', { class: 'btn btn-small btn-accent', type: 'button', id: 'alerts-open', text: 'Open', on: { click: () => void openAlerts() } }));
    line.replaceChildren(...bits);
    const cnt = $('home-count');
    cnt.textContent = String(total);
    cnt.hidden = !total;
    const facts = [];
    if (r.checks && typeof r.checks === 'object') facts.push(h('li', { text: `Device checks today: ${Number(r.checks.passed) || 0} passed, ${Number(r.checks.failed) || 0} failed${r.checks.summary ? ` — ${r.checks.summary}` : ''}` }));
    if (r.firstDevice && typeof r.firstDevice.at === 'number') facts.push(h('li', { text: `First device connected ✓ ${formatShortTime(r.firstDevice.at)}` }));
    if (r.announcement && typeof r.announcement.text === 'string') facts.push(h('li', { text: `Last announcement (${formatShortTime(r.announcement.at)}): [Host] ${r.announcement.text}` }));
    $('home-facts').replaceChildren(...facts);
    const list = Array.isArray(r.setupChecklist) ? r.setupChecklist : [];
    $('home-checklist').replaceChildren(...list.map((x) => h('li', { class: x.done ? 'done' : 'todo', text: `${x.done ? '✓' : '○'} ${x.label}` })));
    $('home-checklist-panel').hidden = !list.length;
    fillRows($('home-rooms'), rooms, 6, 'No rooms yet.', (x) => h('tr', null,
      h('td', null, h('span', { class: 'strong-cell', text: x.name || 'Room' }), x.house ? [' ', pill(h, 'house', 'pill-channel')] : null, x.pinned ? [' ', pill(h, 'pinned', 'pill-channel')] : null),
      h('td', { text: [x.typeLabel, x.subModeLabel].filter(Boolean).join(' · ') || '—' }),
      h('td', null, pill(h, x.phaseLabel || x.phase || '—', `pill-phase-${/^[a-z]+$/.test(x.phase || '') ? x.phase : 'none'}`)),
      h('td', { text: `${Number(x.humans) || 0}${x.maxPlayers ? ` / ${x.maxPlayers}` : ''}` }),
      h('td', { text: String(Number(x.bots) || 0) }),
      h('td', { text: String(Number(x.spectators) || 0) }),
    ));
    // Announcement targets: every room (by id).
    const sel = $('announce-target');
    const keep = sel.value;
    const opts = [h('option', { value: '', text: 'Everyone (all rooms and the lobby)' }), ...rooms.filter((x) => typeof x.roomId === 'string' && x.roomId).map((x) => h('option', { value: x.roomId, text: `Only ${x.name || 'Room'}` }))];
    sel.replaceChildren(...opts);
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    $('home-updated').textContent = `Updated ${formatShortTime(now())}`;
  }

  $('display-open').addEventListener('click', () => {
    const w = win.open?.('/display', 'voidswarm-display', 'noopener');
    if (!w && !win.open) toast('Open /display on this PC in a new window.', 'error');
  });

  async function openAlerts() {
    alertsOpen = true;
    $('alerts-panel').hidden = false;
    await loadAlerts();
  }
  $('alerts-close').addEventListener('click', () => { alertsOpen = false; $('alerts-panel').hidden = true; });
  $('alerts-refresh').addEventListener('click', () => void loadAlerts());
  $('alerts-acked').addEventListener('change', () => void loadAlerts());

  async function loadAlerts() {
    if (!signedIn) return;
    setStatus($('alerts-status'), 'Loading…');
    try {
      const r = await api.admin('alerts/list', { includeAcked: $('alerts-acked').checked });
      lastAlerts = Array.isArray(r.alerts) ? r.alerts : [];
      renderAlerts();
      setStatus($('alerts-status'), '');
    } catch (err) { failStatus($('alerts-status'), err); }
  }

  function renderAlerts() {
    fillRows($('alerts-body'), lastAlerts, 6, 'No alerts.', (a) => {
      const wb = a.kind === 'wellbeing' || a.wellbeing === true;
      if (wb && presenting) return presentingWellbeingRow(h, 6, 1, 'A wellbeing alert needs your attention');
      const tags = Array.isArray(a.tags) ? a.tags.map(tagText).filter(Boolean) : [];
      const who = wb ? h('td', { class: 'muted', text: 'Opens with ★' }) : h('td', null, presenting ? h('span', { class: 'redacted', text: PRESENT_NAME }) : h('span', { text: a.name || '—' }));
      const act = h('div', { class: 'btn-row' });
      if (wb && can('wellbeing') && !presenting) act.appendChild(h('button', { class: 'btn btn-small btn-accent', type: 'button', text: 'Open ★', on: { click: () => void openWellbeing({ alertId: a.id, chatId: a.chatId }) } }));
      if (!a.acked && can('alerts.ack')) act.appendChild(h('button', { class: 'btn btn-small btn-ghost', type: 'button', text: 'Acknowledge ★', on: { click: () => void ackAlert(a) } }));
      return h('tr', { class: a.level === 'urgent' && !a.acked ? 'row-block' : '' },
        timeCell(h, a.at ?? a.lastAt, now()),
        h('td', null, wb ? h('span', { class: 'wellbeing-line', text: 'A wellbeing alert needs your attention' }) : pill(h, a.kind === 'threat' ? 'threat' : 'alert', a.level === 'urgent' ? 'pill-block' : 'pill-mask'), ' ', ...tagChips(h, tags), Number(a.count) > 1 ? h('span', { class: 'muted small', text: ` ×${a.count}` }) : null),
        h('td', { text: presenting ? (a.roomId || a.roomUid || a.roomName ? presentingRoomLabel(a) : 'Zone lobby') : a.roomName || 'Zone lobby' }),
        who,
        h('td', null, a.acked ? pill(h, 'acknowledged', 'pill-reviewed') : pill(h, 'open', 'pill-open')),
        h('td', { class: 'actions' }, act));
    });
  }

  async function ackAlert(a) {
    const v = await openDialog({ title: 'Acknowledge alert', text: 'It leaves the open alerts. Wellbeing lines are cleared 30 days after acknowledgement.', okLabel: 'Acknowledge', okKind: 'primary', reason: { label: 'Note (optional)', required: false, max: NOTE_MAX, what: 'A note' } });
    if (!v) return;
    try {
      await api.admin('alerts/ack', { id: a.id, ...(v.reason ? { note: v.reason } : {}) });
      toast('Alert acknowledged.', 'ok');
      void loadAlerts();
      void loadHome(true);
      void refreshMe();
    } catch (err) { failToast('Acknowledge', err); }
  }

  /**
   * wellbeing/open ★: the student, the line and its context (audited server-side). Until that endpoint exists (501),
   * the same answer comes from log/reveal ★ and log/context (both audited): the line's author and time from the
   * context anchor, what was typed from the reveal.
   */
  async function openWellbeing(ref) {
    if (presenting) { toast('Switch Presenting off first.', 'error'); return; }
    // Every step below waits on the server: each resumes only in the sign-in it started in (never over the sign-in
    // screen, never into the next person's session).
    const at = epoch;
    const id = Number.isInteger(ref.alertId) ? ref.alertId : null;
    let chatId = Number.isInteger(ref.chatId) ? ref.chatId : null;
    if (chatId === null && id !== null) chatId = lastAlerts.find((a) => a.id === id)?.chatId ?? null;
    if (chatId === null && id !== null && can('status')) {
      // The alert list knows its line's id once the line is written.
      try {
        const r = await api.admin('alerts/list', { includeAcked: true });
        if (!still(at)) return;
        lastAlerts = Array.isArray(r.alerts) ? r.alerts : lastAlerts;
        chatId = lastAlerts.find((a) => a.id === id)?.chatId ?? null;
      } catch { /* below: wellbeing/open by the alert id */ }
      if (!still(at)) return;
    }
    if (id === null && chatId === null) { toast('That line is still being saved — try again in a moment.', 'error'); return; }
    let student = null;
    let line = null;
    let typed = '';
    let context = [];
    try {
      const r = await api.admin('wellbeing/open', id !== null ? { id } : { chatId });
      if (!still(at)) return;
      if (!legacy) void refreshMe(); // a ★ call: the server's window moved on (see revealIds)
      student = r.student && typeof r.student === 'object' ? r.student : {};
      line = r.line && typeof r.line === 'object' ? r.line : {};
      typed = typeof line.original === 'string' ? line.original : '';
      context = Array.isArray(r.context) ? r.context : [];
    } catch (err) {
      if (!still(at)) return;
      if (!(err instanceof ApiError && (err.status === 501 || err.status === 404)) || chatId === null) { failToast('Open the wellbeing alert', err); return; }
      try {
        await revealIds([chatId]);
        if (!still(at)) return;
        typed = revealed.get(chatId) ?? '';
        const c = await api.admin('log/context', { id: chatId, before: 5, after: 5 });
        if (!still(at)) return;
        line = c.anchor && typeof c.anchor === 'object' ? c.anchor : {};
        student = { name: line.name, accountId: line.accountId };
        context = [...(Array.isArray(c.before) ? c.before : []), ...(Array.isArray(c.after) ? c.after : [])];
      } catch (err2) { if (still(at)) failToast('Open the wellbeing alert', err2); return; }
    }
    if (!still(at) || presenting) return;
    const around = context.filter((x) => x && typeof x === 'object' && !isWellbeingRow(x)).slice(-6)
      .map((x) => `${formatShortTime(x.ts)} ${x.name || '?'}: ${shownView(x).text || shownView(x).note}`).join('\n');
    await openDialog({
      title: 'Wellbeing alert', okLabel: 'Close', okKind: 'primary', private: true,
      text: `${student?.username || student?.name || 'Unknown student'} · ${formatDateTime(line?.ts)} · ${whereLabel(line ?? {})}${around ? `\n\nAround it (what others saw):\n${around}` : ''}`,
      target: typed ? `Typed: ${typed}` : '',
    });
  }

  // announcements
  $('announce-quick').replaceChildren(...ANNOUNCE_QUICK.map((t) => h('button', {
    class: 'btn btn-small btn-ghost', type: 'button', text: t, on: { click: () => { $('announce-text').value = t; $('announce-text').focus(); } },
  })));
  $('announce-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const built = announceBody($('announce-text').value, $('announce-target').value);
    if (built.error) { setStatus($('announce-status'), built.error, 'error'); return; }
    await withBusy($('announce-send'), async () => {
      try {
        const r = await api.admin('announce', built.body);
        setStatus($('announce-status'), `Sent to ${plural(Number(r.delivered) || 0, 'player')}.`, 'ok');
        $('announce-text').value = '';
        void loadHome(true);
      } catch (err) { failStatus($('announce-status'), err); }
    });
  });

  // ---------------------------------------------------------------- LIVE
  let liveLines = [];
  let livePending = [];
  let liveAfter = null;
  let liveRun = 0; // generation: a newer start stops the older loop
  let liveCtrl = null;
  let livePaused = false;
  const liveRooms = new Map(); // roomUid -> label
  const liveTags = new Set(BUILTIN_TAGS);

  function liveFilters() {
    return {
      roomUid: $('live-room').value, channel: $('live-channel').value, tag: $('live-tag').value,
      player: $('live-player').value, flaggedOnly: $('live-flagged').checked,
    };
  }

  function noteLiveMeta(lines) {
    let roomsChanged = false;
    let tagsChanged = false;
    for (const l of lines) {
      if (typeof l.roomUid === 'string' && l.roomUid && !liveRooms.has(l.roomUid) && l.channel !== 'announce') {
        liveRooms.set(l.roomUid, l.roomUid.endsWith(':zone') ? 'Zone lobby' : l.roomName || 'Room');
        roomsChanged = true;
      }
      for (const t of rowTags(l)) if (!liveTags.has(t)) { liveTags.add(t); tagsChanged = true; }
    }
    if (roomsChanged) syncLiveRooms();
    if (tagsChanged) syncSelect($('live-tag'), [['', 'Any'], ...[...liveTags].map((t) => [t, t])]);
  }

  /** The Live room filter (Presenting: rooms by number, never by name). */
  function syncLiveRooms() {
    syncSelect($('live-room'), [['', 'All rooms and the lobby'], ...[...liveRooms.entries()].map(([uid, label]) => [uid, presenting && !uid.endsWith(':zone') ? presentingRoomLabel({ roomUid: uid }) : label])]);
  }

  function syncSelect(sel, pairs) {
    const keep = sel.value;
    sel.replaceChildren(...pairs.map(([v, t]) => h('option', { value: v, text: t })));
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }

  function liveCtx() {
    return {
      presenting, caps, now: now(), revealed,
      on: {
        reveal: (l) => void revealLive([l]),
        context: (l) => void openContext(l.chatId, l),
        history: (l) => openLogFor({ player: l.accountId ? l.name : l.name }),
        mute: (l) => void sanctionSubject('mute', toSubject(l, l.online), { durations: QUICK_MUTES }),
        kick: (l) => void kickSubject(toSubject(l, true)),
        warn: (l) => void warnSubject(toSubject(l, true)),
        openWellbeing: (l) => void openWellbeing({ alertId: l.alertId, chatId: l.chatId }),
      },
    };
  }

  function renderLive() {
    const ctx = liveCtx();
    fillRows($('live-body'), liveLines, 6, livePaused ? 'Paused.' : 'Waiting for chat…', (l) => renderLiveLine(h, l, ctx));
    const pending = livePending.length;
    $('live-count').textContent = `(${liveLines.length}${pending ? ` · ${pending} new while paused` : ''})`;
  }

  function startLive() {
    if (!signedIn || !can('live') || stopped) return;
    stopLive(); // one loop at a time (the server allows 4 waits per session)
    const gen = ++liveRun;
    void liveLoop(gen);
  }

  function stopLive() {
    liveRun++;
    try { liveCtrl?.abort(); } catch { /* gone */ }
    liveCtrl = null;
  }

  function restartLive() {
    stopLive();
    liveAfter = null;
    liveLines = [];
    livePending = [];
    renderLive();
    if (currentTab === 'live') startLive();
  }

  const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

  async function liveLoop(gen) {
    const alive = () => gen === liveRun && signedIn && !stopped;
    while (alive()) {
      if (doc.hidden) { await sleep(1000); continue; }
      const started = now();
      const ctrl = new win.AbortController();
      liveCtrl = ctrl;
      try {
        const r = await api.admin('chat/live', liveRequestBody(liveFilters(), liveAfter, LIVE_WAIT_SEC), { signal: ctrl.signal });
        if (!alive()) return;
        const lines = Array.isArray(r.lines) ? r.lines.filter((l) => l && typeof l === 'object') : [];
        if (typeof r.next === 'number') liveAfter = r.next;
        noteLiveMeta(lines);
        if (livePaused) livePending = mergeLive(livePending, lines);
        else liveLines = mergeLive(liveLines, lines);
        if (lines.length || r.gap) renderLive();
        setStatus($('live-status'), r.gap && liveLines.length ? 'Some lines were skipped (the feed moved on) — the Chat log has every line.' : '');
        if (!lines.length && now() - started < LIVE_MIN_GAP_MS) await sleep(LIVE_MIN_GAP_MS);
      } catch (err) {
        if (!alive()) return;
        if (err instanceof ApiError && err.body?.code === 'aborted') return;
        failStatus($('live-status'), err);
        await sleep(err instanceof ApiError && err.status === 429 ? LIVE_BUSY_RETRY_MS : LIVE_RETRY_MS);
      }
    }
  }

  /** Fill in chat ids the ring learned after it sent a line (a snapshot, no wait). */
  async function backfillChatIds() {
    try {
      const r = await api.admin('chat/live', liveRequestBody(liveFilters(), null));
      const fresh = Array.isArray(r.lines) ? r.lines : [];
      const ids = new Map(fresh.filter((l) => Number.isInteger(l.chatId)).map((l) => [l.seq, l.chatId]));
      const fix = (list) => list.map((l) => (l.chatId == null && ids.has(l.seq) ? { ...l, chatId: ids.get(l.seq) } : l));
      liveLines = fix(liveLines);
      livePending = fix(livePending);
    } catch { /* best effort */ }
  }

  /**
   * The chat_log id of a Live line: its own, else what the ring learned since (a snapshot), else an exact match in the
   * log (same time, pilot, channel and shown text; the ring can't always tell which row it became).
   */
  async function resolveChatIds(lines) {
    if (lines.some((l) => !Number.isInteger(l.chatId))) await backfillChatIds();
    const out = new Map();
    for (const l of lines) {
      const known = liveLines.find((x) => x.seq === l.seq)?.chatId ?? l.chatId;
      if (Number.isInteger(known)) { out.set(l.seq, known); continue; }
      if (!can('log') || !l.name || !(typeof l.ts === 'number' && l.ts > 0)) continue;
      try {
        const r = await api.admin('log', { player: l.name, since: l.ts, until: l.ts, limit: 20 });
        const hit = (Array.isArray(r.lines) ? r.lines : []).find((x) => x && x.ts === l.ts && x.playerId === l.playerId && x.channel === l.channel && (x.shown ?? '') === (l.shown ?? ''));
        if (hit && Number.isInteger(hit.id)) {
          out.set(l.seq, hit.id);
          liveLines = liveLines.map((x) => (x.seq === l.seq ? { ...x, chatId: hit.id } : x));
        }
      } catch { /* not found: the caller says so */ }
    }
    return out;
  }

  async function revealLive(lines) {
    if (presenting) return;
    const at = epoch;
    const found = await resolveChatIds(lines);
    if (!still(at)) return;
    const ids = lines.map((l) => found.get(l.seq)).filter((x) => Number.isInteger(x));
    if (!ids.length) { toast('That line is still being saved — try again in a moment.', 'error'); return; }
    try {
      const n = await revealIds(ids);
      renderLive();
      if (currentTab === 'chat') renderLog();
      if (!n && ids.length) toast('Nothing to reveal (the line may have been purged).');
    } catch (err) { failToast('Reveal', err); }
  }

  for (const id of ['live-room', 'live-channel', 'live-tag', 'live-flagged']) $(id).addEventListener('change', () => restartLive());
  let playerTimer = 0;
  $('live-player').addEventListener('input', () => { clearTimeout(playerTimer); playerTimer = setTimeout(() => restartLive(), 500); });
  $('live-filters').addEventListener('submit', (e) => { e.preventDefault(); restartLive(); });
  $('live-pause').addEventListener('click', () => {
    livePaused = !livePaused;
    $('live-pause').textContent = livePaused ? 'Resume' : 'Pause';
    $('live-pause').setAttribute('aria-pressed', String(livePaused));
    if (!livePaused) { liveLines = mergeLive(liveLines, livePending); livePending = []; }
    renderLive();
  });
  $('live-clear').addEventListener('click', () => { liveLines = []; livePending = []; renderLive(); });
  $('live-originals').addEventListener('click', () => {
    const view = liveLines.filter((l) => !isWellbeingRow(l) && l.channel !== 'announce' && l.action !== 'pass').slice(0, REVEAL_MAX);
    if (!view.length) { toast('No filtered lines in view.'); return; }
    void revealLive(view);
  });

  // ---------------------------------------------------------------- CHAT LOG
  let logPager = pagerInit();
  let logRows = [];
  let logQuery = null;
  let logStats = null;
  const logSeq = latestOnly();
  const logRoomsKnown = new Map(); // 'uid:…' / 'id:…' -> { label, safe (Presenting) }

  function setPeriods(list) {
    periods = (Array.isArray(list) ? list : []).map(normalizePeriod).filter(Boolean);
    syncSelect($('chat-period'), [['', 'Any'], ...periods.map((p) => [p.name, `${p.name} (${p.start}–${p.end})`])]);
    for (const o of $('chat-range').options) if (o.value === 'period') o.disabled = !periods.length;
  }

  function readChatForm() {
    return {
      range: $('chat-range').value, from: $('chat-from').value, to: $('chat-to').value, player: $('chat-player').value,
      room: $('chat-room').value, period: $('chat-period').value, channel: $('chat-channel').value, action: $('chat-action').value,
      tag: $('chat-tag').value, q: $('chat-q').value, jump: $('chat-jump').value,
    };
  }

  function resetChatForm() {
    for (const id of ['chat-range', 'chat-room', 'chat-period', 'chat-channel', 'chat-action', 'chat-tag']) $(id).value = '';
    for (const id of ['chat-from', 'chat-to', 'chat-player', 'chat-q', 'chat-jump']) $(id).value = '';
    syncRange();
  }

  function syncRange() {
    const custom = $('chat-range').value === 'custom';
    for (const n of doc.querySelectorAll('[data-custom-range]')) n.hidden = !custom;
  }
  $('chat-range').addEventListener('change', syncRange);

  function logCtx() {
    return {
      presenting, caps, now: now(), revealed, legacy,
      on: {
        reveal: (row) => void revealLog([row]),
        context: (row) => void openContext(row.id, row),
        mute: (row) => void sanctionSubject('mute', toSubject(row, isOnline(row))),
        ban: (row) => void sanctionSubject('ban', toSubject(row, isOnline(row))),
        openWellbeing: (row) => void openWellbeing({ chatId: row.id }),
      },
    };
  }

  function renderLog() {
    const ctx = logCtx();
    fillRows($('chat-body'), logRows, 7, logQuery ? 'No chat lines match.' : 'Search to see chat lines.', (row) => renderLogRow(h, row, ctx));
  }

  function isOnline(row) {
    return lastOnline.some((p) => p.playerId === row.playerId && p.name === row.name);
  }

  function noteLogRooms(rooms) {
    for (const r of rooms) {
      if (!r || typeof r !== 'object') continue;
      const key = typeof r.roomUid === 'string' && r.roomUid && !legacy ? `uid:${r.roomUid}` : typeof r.roomId === 'string' && r.roomId ? `id:${r.roomId}` : null;
      if (!key || logRoomsKnown.has(key)) continue;
      const span = typeof r.firstTs === 'number' ? ` (${roomSpanText(r.firstTs, r.lastTs)})` : '';
      logRoomsKnown.set(key, r.lobby
        ? { label: `Zone lobby${span}`, safe: `Zone lobby${span}` }
        : { label: `${r.name || r.roomName || 'Room'}${span}`, safe: `${presentingRoomLabel(r)}${span}` });
    }
    syncLogRooms();
  }

  /** The Chat log room filter (Presenting: rooms by number, never by name). */
  function syncLogRooms() {
    syncSelect($('chat-room'), [['', 'Any room'], ...[...logRoomsKnown.entries()].map(([k, v]) => [k, presenting ? v.safe : v.label])]);
  }

  function syncLogButtons() {
    $('chat-prev').disabled = logPager.stack.length <= 1;
    $('chat-first').disabled = logPager.stack.length <= 1;
    $('chat-next').disabled = logPager.next === null;
  }

  async function openChatLog() {
    syncSelect($('chat-tag'), [['', 'Any'], ...BUILTIN_TAGS.map((t) => [t, t])]);
    if (!legacy) {
      void loadLogStats();
      try {
        const r = await api.admin('log/rooms', { since: now() - 7 * 86_400_000 });
        noteLogRooms(Array.isArray(r.rooms) ? r.rooms : []);
      } catch { /* the room list is a convenience */ }
    }
    await loadLog();
  }

  async function loadLogStats() {
    if (!can('log.stats')) return;
    try {
      logStats = await api.admin('log/stats', { tzOffsetMin: new Date().getTimezoneOffset() });
      $('retention-text').textContent = retentionText(logStats.retention ? { ...logStats.retention, nextPurgeAt: logStats.nextPurgeAt } : null) || '—';
      renderLogHeader();
    } catch { /* the header is best effort */ }
  }

  function renderLogHeader() {
    const span = logQuery ? pageSpanText(logPager, logRows.length) : '';
    const stats = logStats ? statsText(logStats) : '';
    $('log-stats').textContent = [span, stats].filter(Boolean).join(' · ');
  }

  async function loadLog() {
    if (!signedIn || !can('log')) return;
    const built = buildLogQuery(readChatForm(), { now: now(), periods, cursor: pagerCursor(logPager), legacy });
    if (built.error) { setStatus($('chat-status'), built.error, 'error'); return; }
    const isCurrent = logSeq();
    logPager = pagerLoaded(logPager, null);
    syncLogButtons();
    setStatus($('chat-status'), 'Searching…');
    try {
      const r = await api.admin('log', built.query);
      if (!isCurrent()) return;
      const { before: _b, beforeTs: _t, limit: _l, ...filter } = built.query;
      logQuery = filter;
      const rows = Array.isArray(r.lines) ? r.lines.filter((x) => x && typeof x === 'object') : [];
      // The v0.4 API answers with the original text: dropped here (Reveal reads it again, audited, in revealLegacy).
      logRows = rows.map((row) => {
        const { original: _o, originalText: _t, ...rest } = row;
        return rest;
      });
      logPager = pagerLoaded(logPager, r.nextBefore, r.nextBeforeTs);
      renderLog();
      $('chat-page-info').textContent = pagerLabel(logPager, logRows.length);
      renderLogHeader();
      setStatus($('chat-status'), r.partial ? 'The search is still running through older lines — press Older to continue.' : '');
    } catch (err) {
      if (isCurrent()) failStatus($('chat-status'), err);
    } finally {
      if (isCurrent()) syncLogButtons();
    }
  }

  async function revealLog(rows) {
    if (presenting) return;
    if (legacy) { await revealLegacy(rows); return; }
    try {
      const n = await revealIds(rows.map((r) => r.id));
      renderLog();
      renderLive();
      if (!n) toast('Nothing to reveal (the lines may have been purged).');
    } catch (err) { failToast('Reveal', err); }
  }

  /**
   * Reveal on the v0.4 moderator API (no log/reveal): one `log` call narrowed to these lines (the current filter, their
   * time span, the pilot for a single line). That API audits every log read ("api log …" in the Audit tab), so a
   * reveal is one audited call there too, and no original sits in the page before it.
   */
  async function revealLegacy(rows) {
    const want = rows.filter((r) => r && Number.isInteger(r.id) && typeof r.ts === 'number' && Number.isFinite(r.ts));
    if (!want.length) return;
    const ids = new Set(want.map((r) => r.id));
    const times = want.map((r) => r.ts);
    const q = { ...(logQuery ?? {}), since: Math.min(...times), until: Math.max(...times), limit: 500 };
    if (want.length === 1 && typeof want[0].name === 'string' && want[0].name) q.player = want[0].name;
    const at = epoch;
    try {
      const r = await api.admin('log', q);
      if (!still(at)) return;
      let n = 0;
      for (const row of Array.isArray(r.lines) ? r.lines : []) {
        if (row && ids.has(row.id) && typeof row.original === 'string') { revealed.set(row.id, row.original); n++; }
      }
      renderLog();
      if (!n) toast('Nothing to reveal (the lines may have been purged).');
    } catch (err) { failToast('Reveal', err); }
  }

  /** Jump to the chat log with only these filters set. */
  function openLogFor(filters) {
    if (!can('log')) return;
    resetChatForm();
    if (filters.player) $('chat-player').value = String(filters.player);
    if (filters.room) {
      if (!logRoomsKnown.has(filters.room)) { logRoomsKnown.set(filters.room, { label: filters.roomLabel || 'Room', safe: 'Room' }); syncLogRooms(); }
      $('chat-room').value = filters.room;
    }
    logPager = pagerInit();
    const first = !loaded.has('chat');
    loaded.add('chat');
    showTab('chat');
    if (first) void openChatLog(); else void loadLog();
  }

  $('chat-filters').addEventListener('submit', (e) => { e.preventDefault(); logPager = pagerInit(); void loadLog(); });
  $('chat-clear').addEventListener('click', () => { resetChatForm(); logPager = pagerInit(); void loadLog(); });
  $('chat-next').addEventListener('click', () => { logPager = pagerOlder(logPager); void loadLog(); });
  $('chat-prev').addEventListener('click', () => { logPager = pagerNewer(logPager); void loadLog(); });
  $('chat-first').addEventListener('click', () => { logPager = pagerInit(); void loadLog(); });
  $('chat-originals').addEventListener('click', () => {
    // Wellbeing lines open with Open ★ (who and what together), never in a page reveal.
    const rows = logRows.filter((r) => !isWellbeingRow(r) && r.channel !== 'announce' && !revealed.has(r.id)).slice(0, REVEAL_MAX);
    if (!rows.length) { toast('No lines in view.'); return; }
    void revealLog(rows);
  });

  // context drawer (§5.5: 10 lines before and after in the same room)
  const ctxDlg = $('ctx-dlg');
  let ctxState = null;
  let ctxRows = [];
  async function openContext(id, row) {
    const at = epoch;
    if (!Number.isInteger(id)) {
      if (row && row.seq !== undefined) id = (await resolveChatIds([row])).get(row.seq);
      if (!still(at)) return;
      if (!Number.isInteger(id)) { toast('That line is still being saved — try again in a moment.', 'error'); return; }
    }
    ctxState = { id, before: 10, after: 10 };
    await loadContext();
  }
  /** The drawer's lines as they are now (Presenting, what has been revealed); no call. */
  function renderContextRows() {
    const ctx = logCtx();
    fillRows($('ctx-body'), ctxRows, 5, 'No lines around it.', (x) => {
      const wb = isWellbeingRow(x);
      const tr = h('tr', { class: `${x.anchor ? 'row-anchor ' : ''}${chatRowClass(x.action)}${x.channel === 'team' ? ' row-team' : ''}`.trim() },
        timeCell(h, x.ts, now()),
        wb ? h('td', { class: 'muted', text: '—' }) : playerCell(h, x, ctx),
        shownCell(h, x, ctx, ctx.presenting || wb ? undefined : revealed.get(x.id)),
        chipsCell(h, x, true),
        h('td', null, x.channel === 'team' ? pill(h, 'team', 'pill-channel') : null,
          !presenting && !wb && can('reveal') && !revealed.has(x.id) && x.action !== 'pass'
            ? h('button', { class: 'btn btn-small btn-ghost', type: 'button', text: 'Reveal ★', on: { click: async () => { try { await revealIds([x.id]); await loadContext(); } catch (err) { failToast('Reveal', err); } } } })
            : null));
      return tr;
    });
  }
  function closeContext() {
    ctxState = null;
    ctxRows = [];
    if (ctxDlg.open) ctxDlg.close();
    $('ctx-body').replaceChildren();
  }
  async function loadContext() {
    if (!ctxState || !signedIn) return;
    const at = epoch;
    setStatus($('ctx-error'), '');
    try {
      const r = await api.admin('log/context', { id: ctxState.id, before: ctxState.before, after: ctxState.after });
      // Signed out, or the drawer closed, while it loaded: nothing opens over the sign-in screen.
      if (!still(at) || !ctxState) return;
      ctxRows = [...(Array.isArray(r.before) ? r.before : []), ...(r.anchor ? [{ ...r.anchor, anchor: true }] : []), ...(Array.isArray(r.after) ? r.after : [])];
      renderContextRows();
      const scope = r.scope === 'room' ? 'Same room, this server run' : r.scope === 'lobby' ? 'Zone lobby, this server run' : r.scope === 'zone' ? 'Zone lobby, ±10 minutes' : 'Same room, ±10 minutes (a line from before 0.6)';
      $('ctx-scope').textContent = `${scope}. Team lines are marked.`;
      $('ctx-more-before').disabled = !r.moreBefore || ctxState.before >= 50;
      $('ctx-more-after').disabled = !r.moreAfter || ctxState.after >= 50;
      if (!ctxDlg.open) ctxDlg.showModal();
    } catch (err) {
      if (!still(at)) return;
      if (!ctxDlg.open) failToast('Context', err); else failStatus($('ctx-error'), err);
    }
  }
  $('ctx-more-before').addEventListener('click', () => { if (ctxState) { ctxState.before = Math.min(50, ctxState.before + 10); void loadContext(); } });
  $('ctx-more-after').addEventListener('click', () => { if (ctxState) { ctxState.after = Math.min(50, ctxState.after + 10); void loadContext(); } });
  $('ctx-close').addEventListener('click', () => closeContext());
  ctxDlg.addEventListener('close', () => { if (ctxState && !ctxDlg.open) { ctxState = null; ctxRows = []; } });

  // export (★)
  const exportDlg = $('export-dlg');
  const exportScope = () => ($('export-scope-all').checked ? 'all' : $('export-scope-range').checked ? 'range' : 'filter');
  for (const id of ['export-scope-filter', 'export-scope-range', 'export-scope-all']) $(id).addEventListener('change', () => { $('export-range').hidden = exportScope() !== 'range'; });
  $('chat-export').addEventListener('click', () => {
    setStatus($('export-error'), '');
    $('export-range').hidden = exportScope() !== 'range';
    if (!$('export-from').value) $('export-from').value = isoDay(now() - 7 * 86_400_000);
    if (!$('export-to').value) $('export-to').value = isoDay(now());
    exportDlg.showModal();
  });
  $('export-cancel').addEventListener('click', () => { if (exportDlg.open) exportDlg.close(); });
  $('export-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const built = exportBody(logQuery ?? buildLogQuery(readChatForm(), { now: now(), periods }).query ?? {}, {
      scope: exportScope(), from: $('export-from').value, to: $('export-to').value, format: $('export-format').value,
      includeOriginal: can('reveal') && $('export-original').checked, includeWellbeing: can('wellbeing') && $('export-wellbeing').checked,
      saveOnHost: $('export-save').checked,
    });
    if (built.error) { setStatus($('export-error'), built.error, 'error'); return; }
    await withBusy($('export-ok'), async () => {
      setStatus($('export-error'), 'Exporting…');
      try {
        const r = await api.file('log/export', built.body);
        if (exportDlg.open) exportDlg.close();
        if (r.kind === 'json') {
          toast(`Saved ${plural(Number(r.data.rows) || 0, 'line')} on this PC: ${r.data.savedTo || r.data.fileName || 'data\\exports'}`, 'ok');
        } else {
          downloadBlob(r.blob, r.filename);
          toast(`Exported ${r.rows === null ? '' : plural(r.rows, 'line')} (${r.filename}).`, 'ok');
        }
      } catch (err) { failStatus($('export-error'), err); }
    });
  });

  function downloadBlob(blob, filename) {
    const url = win.URL.createObjectURL(blob);
    const a = h('a', { class: 'sr-only' });
    a.href = url;
    a.download = filename;
    doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => win.URL.revokeObjectURL(url), 30_000);
  }

  // purge (★): the count first (409), then the confirmed count
  $('chat-purge').addEventListener('click', async () => {
    const player = cleanText($('chat-player').value, NAME_MAX);
    const accountRow = player ? logRows.find((r) => r.accountId && (r.name || '').toLowerCase() === player.toLowerCase()) : null;
    const v = await openDialog({
      title: 'Purge chat lines', okLabel: 'Count lines', okKind: 'danger',
      text: 'Deletes every chat line before the date (with its tags, counters, reviews and report copies). The first step only counts them.',
      date: { label: 'Purge lines before', value: isoDay(now() - 90 * 86_400_000), required: true },
      check: accountRow ? { label: `Only ${accountRow.name}'s lines` } : undefined,
    });
    if (!v) return;
    const body = { before: v.date, ...(v.checked && accountRow ? { accountId: accountRow.accountId } : {}) };
    let rows = null;
    try {
      const r = await api.admin('log/purge', body);
      toast(`Purged ${plural(Number(r.deleted) || 0, 'line')}.`, 'ok');
      void loadLog();
      void loadLogStats();
      return;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body?.needsConfirm) rows = Number(err.body.rows) || 0;
      else { failToast('Purge', err); return; }
    }
    if (!rows) { toast('No lines before that date.'); return; }
    const sure = await confirmBox(`Delete ${plural(rows, 'line')}?`,
      `This cannot be undone. Backups keep these lines until they age out (at most 35 days). The search index finishes tidying at the next restart or overnight.`,
      `Delete ${formatCount(rows)}`);
    if (!sure) return;
    try {
      const r = await api.admin('log/purge', { ...body, confirmRows: rows });
      toast(`Purged ${plural(Number(r.deleted) || 0, 'line')}.`, 'ok');
      void loadLog();
      void loadLogStats();
    } catch (err) { failToast('Purge', err); }
  });

  // retention (Settings → Chat; ★ settings)
  $('retention-edit').addEventListener('click', async () => {
    let cur;
    try { cur = await api.admin('settings/get', {}); } catch (err) { failToast('Settings', err); return; }
    const s = cur.settings && typeof cur.settings === 'object' ? cur.settings : {};
    const r = s.chat?.retention ?? {};
    const school = s.preset === 'school';
    const modes = [
      { value: 'days', label: 'Keep a number of days', hint: '' },
      { value: 'term', label: 'Until the end of the term', hint: 'Set the date below. A banner reminds you 7 days before.' },
      { value: 'forever', label: 'Until I delete it', hint: school ? 'In School mode this needs your district\'s approval (tick below).' : '' },
    ];
    // The current rule first (the dialog selects the first choice).
    modes.sort((a, b) => (a.value === r.mode ? -1 : b.value === r.mode ? 1 : 0));
    const v = await openDialog({
      title: 'Chat-log retention', okLabel: 'Save', okKind: 'primary',
      text: `Now: ${retentionText(r)}. Choose "days" (1–3650), a term end date (nothing is purged before it; lines go 14 days after it, after a backup), or keep until you delete it.`,
      scopes: modes,
      reason: { label: 'Days (for "days") ', required: false, max: 4, value: String(r.days ?? 90), what: 'The number of days' },
      date: { label: 'Term end date (for "term")', value: typeof r.termEnd === 'string' ? r.termEnd : '' },
      check: school ? { label: 'My district approved keeping chat until I delete it' } : undefined,
    });
    if (!v) return;
    const built = retentionPatch({ mode: v.scope, days: v.reason, termEnd: v.date, districtApproved: v.checked }, school);
    if (built.error) { toast(built.error, 'error'); return; }
    try {
      await api.admin('settings/update', { rev: cur.rev, patch: built.patch });
      toast('Retention saved.', 'ok');
      void loadLogStats();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body && 'rev' in err.body) toast('The settings changed elsewhere — open this again.', 'error');
      else failToast('Save retention', err);
    }
  });

  // ---------------------------------------------------------------- ROOMS (players online)
  let onlineTimer = 0;
  let onlineBusy = false;
  let lastOnline = [];
  let lastOnlineSig = '';

  function renderOnline(players, force = false) {
    const sig = JSON.stringify(players) + presenting;
    if (!force && sig === lastOnlineSig) return;
    lastOnlineSig = sig;
    lastOnline = players;
    $('online-count').textContent = `(${players.length})`;
    fillRows($('online-body'), players, 7, 'Nobody is online.', (p) => {
      const subject = toSubject(p, true);
      const strikes = Number(p.strikes) || 0;
      const muted = p.muted && typeof p.muted === 'object' ? p.muted : null;
      const status = h('td');
      if (muted) {
        status.appendChild(pill(h, muted.until === null ? 'muted · perm' : `muted · ${formatExpiry(muted.until)}`, 'pill-muted'));
        if (muted.reason && !presenting) status.appendChild(h('div', { class: 'hits', text: muted.reason }));
      } else status.appendChild(h('span', { class: 'muted', text: '—' }));
      const self = !!(me && p.accountId && p.accountId === me.accountId);
      const buttons = self || presenting ? [self ? pill(h, 'you', 'pill-admin') : null] : [
        can('moderate') ? h('button', { class: 'btn btn-small btn-accent', type: 'button', text: 'Warn', on: { click: () => void warnSubject(subject) } }) : null,
        can('moderate') ? h('button', { class: 'btn btn-small btn-warn', type: 'button', text: 'Kick', on: { click: () => void kickSubject(subject) } }) : null,
        can('moderate') ? (muted
          ? h('button', { class: 'btn btn-small btn-ghost', type: 'button', text: 'Unmute', on: { click: () => void unmuteSubject(subject) } })
          : h('button', { class: 'btn btn-small btn-warn', type: 'button', text: 'Mute', on: { click: () => void sanctionSubject('mute', subject) } })) : null,
        can('ban') ? h('button', { class: 'btn btn-small btn-danger', type: 'button', text: 'Ban', on: { click: () => void sanctionSubject('ban', subject) } }) : null,
      ];
      const addr = presenting ? '•••' : p.address || (p.addressTag ? `tag ${p.addressTag}` : '—');
      return h('tr', { class: strikes >= HOT_STRIKES ? 'row-hot' : '' },
        h('td', null, nameButton(p.name, p.username || p.name), p.admin && !presenting ? [' ', pill(h, 'mod', 'pill-admin')] : null),
        h('td', null, accountPill(p.accountId, p.username)),
        h('td', { text: presenting ? (p.roomId || p.roomName ? presentingRoomLabel(p) : 'Zone lobby') : p.roomName || 'Zone lobby' }),
        h('td', { class: 'mono', text: addr }),
        h('td', null, h('span', { class: `strikes${strikes >= HOT_STRIKES ? ' hot' : ''}`, text: String(strikes) })),
        status,
        h('td', { class: 'actions' }, h('div', { class: 'btn-row' }, buttons)),
      );
    });
  }

  const onlineSeq = latestOnly();
  async function loadOnline(force = false) {
    if (!signedIn || !can('rooms.read') || (!force && onlineBusy)) return;
    const isCurrent = onlineSeq();
    onlineBusy = true;
    try {
      const r = await api.admin('online', {});
      if (!isCurrent()) return;
      renderOnline(Array.isArray(r.players) ? r.players : [], force);
      setStatus($('online-status'), `Updated ${formatShortTime(now())}`);
    } catch (err) {
      if (isCurrent()) failStatus($('online-status'), err);
    } finally {
      if (isCurrent()) onlineBusy = false;
    }
  }
  $('online-refresh').addEventListener('click', () => void loadOnline(true));

  // WHOIS
  let whoisQuery = '';
  const whoisSeq = latestOnly();

  async function runWhois(query, quiet = false) {
    const q = cleanText(query, NAME_MAX);
    if (!q) { setStatus($('whois-status'), 'Enter a callsign or username.', 'error'); return; }
    if (!can('whois')) return;
    whoisQuery = q;
    $('whois-input').value = q;
    if (!quiet) {
      if (currentTab !== 'rooms') showTab('rooms');
      $('whois-panel').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      setStatus($('whois-status'), `Looking up ${shownName(q)}…`);
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
      setStatus($('whois-status'), err instanceof ApiError && err.status === 404 ? `Nobody called "${shownName(q)}" found (online, as an account, or in the chat log).` : errorText(err), 'error');
    }
  }

  function renderWhois(w) {
    const online = Array.isArray(w.online) ? w.online : [];
    const account = w.account && typeof w.account === 'object' ? w.account : null;
    const addresses = Array.isArray(w.addresses) ? w.addresses.filter((a) => typeof a === 'string') : [];
    const tagsList = Array.isArray(w.addressTags) ? w.addressTags.filter((a) => typeof a === 'string') : [];
    const first = online[0] || null;
    const subject = first
      ? toSubject(first, true)
      : toSubject({ name: account?.username || w.query, accountId: account?.accountId, username: account?.username, address: addresses[0] || null });

    const meta = [];
    const row = (k, ...v) => meta.push(h('dt', { text: k }), h('dd', null, ...v));
    row('Lookup', shownName(String(w.query ?? '')));
    row('Online', online.length
      ? online.map((p, i) => [i ? ', ' : '', `${shownName(p.name)} in ${presenting ? (p.roomId || p.roomName ? presentingRoomLabel(p) : 'Zone lobby') : p.roomName || 'Zone lobby'}`])
      : h('span', { class: 'muted', text: 'not online' }));
    if ('account' in w) {
      row('Account', account
        ? [shownName(account.username), account.admin ? [' ', pill(h, 'mod', 'pill-admin')] : null, h('span', { class: 'muted', text: ` · created ${formatDateTime(account.createdAt)} · last login ${formatDateTime(account.lastLogin)}` })]
        : h('span', { class: 'muted', text: 'guest (no account)' }));
    }
    const addrText = presenting ? '•••' : addresses.length ? addresses.join(', ') : tagsList.length ? `tags ${tagsList.join(', ')}` : '—';
    if ('addresses' in w || 'addressTags' in w) row('Addresses', h('span', { class: 'mono', text: addrText }));
    if (w.strikes !== undefined) {
      const strikes = Number(w.strikes) || 0;
      row('Strikes', h('span', { class: `strikes${strikes >= HOT_STRIKES ? ' hot' : ''}`, text: `${strikes} in the last 10 min` }), ` · ${Number(w.flagged24h) || 0} flagged lines in 24 h`);
    }
    if (w.mute && typeof w.mute === 'object') row('Mute', `until ${w.mute.expiresAt ? formatDateTime(w.mute.expiresAt) : 'lifted'}`);
    $('whois-meta').replaceChildren(...meta);

    const btn = (text, cls, fn) => h('button', { class: `btn btn-small ${cls}`, type: 'button', text, on: { click: fn } });
    $('whois-buttons').replaceChildren(
      can('log') ? btn('Chat log', 'btn-primary', () => openLogFor({ player: subject.username || subject.name })) : null,
      subject.online && can('moderate') ? btn('Warn', 'btn-accent', () => void warnSubject(subject)) : null,
      subject.online && can('moderate') ? btn('Kick', 'btn-warn', () => void kickSubject(subject)) : null,
      can('moderate') ? btn('Mute', 'btn-warn', () => void sanctionSubject('mute', subject)) : null,
      can('ban') ? btn('Ban', 'btn-danger', () => void sanctionSubject('ban', subject)) : null,
    );

    fillRows($('whois-bans'), Array.isArray(w.activeBans) ? w.activeBans : [], 7, 'No active bans or mutes.', (b) => banRow(b, false));
    fillRows($('whois-actions'), Array.isArray(w.recentActions) ? w.recentActions : [], 5, 'No moderation history.', (a) => h('tr', null,
      timeCell(h, a.ts, now()),
      h('td', { text: a.actor ?? '' }),
      h('td', null, pill(h, String(a.action ?? '?'), `pill-${a.action}`)),
      h('td', { class: 'nowrap', text: actionDurationText(a) }),
      h('td', { class: 'msg', text: shownText(a.reason ?? '') }),
    ));
    $('whois-view').hidden = false;
  }

  $('whois-form').addEventListener('submit', (e) => { e.preventDefault(); void runWhois($('whois-input').value); });

  // ---------------------------------------------------------------- REPORTS
  let reportsPager = pagerInit();
  let reportRows = [];
  let selectedReport = null;
  let reportsTimer = 0;

  const partyText = (p) => (p && typeof p === 'object' ? shownName(String(p.name || '?')) : presenting ? PRESENT_NAME : '?');

  function reportStatusPill(status) {
    return pill(h, String(status || '?'), `pill-${status === 'open' ? 'open' : status === 'dismissed' ? 'dismissed' : 'reviewed'}`);
  }

  const reportsSeq = latestOnly();
  async function loadReports() {
    if (!signedIn || !can('reports')) return;
    const isCurrent = reportsSeq();
    reportsPager = pagerLoaded(reportsPager, null);
    $('reports-next').disabled = true;
    setStatus($('reports-list-status'), 'Loading…');
    const status = $('reports-status').value;
    const body = { status, limit: 50 };
    const cur = pagerCursor(reportsPager);
    if (typeof cur === 'number') body.before = cur;
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
      timeCell(h, rep.ts, now()),
      h('td', { class: 'strong-cell', text: partyText(rep.target) }),
      h('td', { text: rep.reporter ? partyText(rep.reporter) : '—' }),
      h('td', { class: 'msg', text: shownText(rep.reason ?? '') }),
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

  /** The badge from a passive reply that carries `openReports` (`home`, `me`); others leave it as it is. */
  function noteOpenReports(reply) {
    if (!can('reports')) return;
    const o = openReportsOf(reply);
    if (o) setOpenCount(o.open, o.more);
  }

  /**
   * The Reports tab badge. A `reports` call is deliberate activity on the server: it resets the idle clock and, while
   * the password is fresh, keeps the ★ step-up fresh (§4.10). So a timer or a return to the page reads the count from
   * the passive `home` (its `openReports`; moderators get counts only) and never from `reports`; only `deliberate`
   * (a sign-in, a review) reads the list. The Home tab's own refresh carries the count too. The v0.4 API has no idle
   * clock and no step-up: there the badge is the list, as before.
   */
  async function refreshReportsBadge(deliberate = false) {
    if (!signedIn || !can('reports') || (!deliberate && doc.hidden)) return;
    try {
      if (legacy || deliberate) {
        const r = await api.admin('reports', { status: 'open', limit: 200 });
        const rows = Array.isArray(r.reports) ? r.reports : [];
        setOpenCount(rows.length, r.nextBefore !== null && r.nextBefore !== undefined);
        return;
      }
      if (!can('status.counts') || (currentTab === 'home' && can('status'))) return;
      noteOpenReports(await api.admin('home', {}));
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
    row('Reported', nameButton(t.name, t.name), ' ', t.accountId ? pill(h, 'account', 'pill-account') : pill(h, 'guest', 'pill-guest'),
      t.address && !presenting ? h('span', { class: 'mono muted', text: ` · ${t.address}` }) : null);
    row('Reported by', rep.reporter ? String(partyText(rep.reporter)) : h('span', { class: 'muted', text: 'hidden for your role' }));
    row('Reason', h('span', { class: 'quote', text: shownText(rep.reason ?? '') }));
    row('Room', presenting && rep.room ? PRESENT_TEXT : String(rep.room || '—'));
    row('Filed', formatDateTime(rep.ts));
    row('Status', reportStatusPill(rep.status),
      rep.reviewedBy ? h('span', { class: 'muted', text: ` by ${rep.reviewedBy} · ${formatDateTime(rep.reviewedAt)}` }) : null);
    if (rep.note) row('Note', h('span', { class: 'quote', text: shownText(rep.note) }));
    $('report-meta').replaceChildren(...meta);
    const chat = Array.isArray(rep.recentChat) ? rep.recentChat : [];
    const ctx = { presenting, caps: [], now: now(), revealed: new Map() };
    fillRows($('report-chat-body'), chat, 5, 'No chat was attached.', (c) => (presenting && isWellbeingRow(c) ? presentingWellbeingRow(h, 5, 2) : h('tr', { class: chatRowClass(c.action) },
      timeCell(h, c.ts, now()), whereCell(h, c, presenting), shownCell(h, c, ctx, undefined),
      h('td', null, pill(h, chatActionInfo(c.action).label, `pill-${chatActionInfo(c.action).id}`)), chipsCell(h, c, false))));
    const open = rep.status === 'open';
    for (const id of ['report-ban', 'report-mute', 'report-warn', 'report-dismiss']) $(id).hidden = !open || presenting;
    $('report-ban').hidden = $('report-ban').hidden || !can('ban');
    $('report-reopen').hidden = open;
    $('report-log').hidden = !can('log');
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
      void refreshReportsBadge(true);
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
    $('ban-target-label').textContent = scope === 'target' ? 'Callsign or username' : 'Network address (as shown on the Rooms tab)';
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
      && !(await confirmBox('Permanent ban?', 'This lasts until the host lifts it. A 1-day or 7-day ban is usually enough.', 'Ban permanently'))) return;
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
    const kindPill = pill(h, b.kind === 'ban' ? 'ban' : 'mute', b.kind === 'ban' ? 'pill-ban' : 'pill-muted');
    const active = b.active !== false;
    const cells = [
      h('td', null, kindPill, active ? null : [' ', pill(h, b.revokedAt ? 'lifted' : 'ended', 'pill-ended')]),
      h('td', null, pill(h, SCOPE_LABELS[b.scope] || String(b.scope || '?'), `pill-scope-${b.scope}`)),
      h('td', { class: 'msg', text: presenting ? PRESENT_NAME : banTargetText(b) }),
      h('td', { class: 'msg', text: shownText(b.reason ?? '') }),
      h('td', { text: b.by ?? '' }),
    ];
    if (withCreated) cells.push(timeCell(h, b.createdAt, now()));
    cells.push(h('td', { class: 'nowrap', title: b.expiresAt ? formatDateTime(b.expiresAt) : 'Permanent', text: active ? formatExpiry(b.expiresAt) : '—' }));
    cells.push(h('td', { class: 'actions' }, active && !presenting && (can('ban') || b.kind === 'mute')
      ? h('button', { class: 'btn btn-small btn-ghost', type: 'button', text: 'Lift', on: { click: () => void revokeBan(b) } })
      : null));
    return h('tr', { class: active ? '' : 'row-ended' }, ...cells);
  }

  let lastBans = [];
  const bansSeq = latestOnly();
  async function loadBans() {
    if (!signedIn || !can('ban')) return;
    const isCurrent = bansSeq();
    setStatus($('bans-status'), 'Loading…');
    try {
      const r = await api.admin('bans', { kind: $('bans-kind').value, includeInactive: $('bans-inactive').checked, limit: 500 });
      if (!isCurrent()) return;
      lastBans = Array.isArray(r.bans) ? r.bans : [];
      fillRows($('bans-body'), lastBans, 8, $('bans-inactive').checked ? 'No bans or mutes yet.' : 'No active bans or mutes.', (b) => banRow(b));
      setStatus($('bans-status'), `${lastBans.length} shown`);
    } catch (err) {
      if (isCurrent()) failStatus($('bans-status'), err);
    }
  }
  $('bans-refresh').addEventListener('click', () => void loadBans());
  $('bans-kind').addEventListener('change', () => void loadBans());
  $('bans-inactive').addEventListener('change', () => void loadBans());

  // ---------------------------------------------------------------- CUSTOM TERMS (host only)
  const TERM_ACTIONS = { flag: 'Flag for review', mask: 'Friendly line', block: 'Block' };
  const TERM_SCOPES = { chat: 'Chat', names: 'Names', both: 'Chat and names' };
  const termsSeq = latestOnly();
  async function loadTerms() {
    if (!signedIn || !can('terms')) return;
    const isCurrent = termsSeq();
    setStatus($('terms-status'), 'Loading…');
    try {
      const r = await api.admin('customTerms/list', {});
      if (!isCurrent()) return;
      const list = Array.isArray(r.terms) ? r.terms : [];
      fillRows($('terms-body'), list, 6, 'No custom terms yet.', (t) => h('tr', null,
        h('td', { class: 'msg', text: presenting ? PRESENT_TEXT : String(t.term ?? '') }),
        h('td', { text: String(t.category ?? '') }),
        h('td', { text: TERM_ACTIONS[t.action] || String(t.action ?? '') }),
        h('td', { text: TERM_SCOPES[t.scope] || String(t.scope ?? '') }),
        timeCell(h, t.createdAt, now()),
        h('td', { class: 'actions' }, presenting ? null
          : h('button', { class: 'btn btn-small btn-ghost', type: 'button', text: 'Remove', on: { click: () => void removeTerm(t) } })),
      ));
      setStatus($('terms-status'), `${list.length} term${list.length === 1 ? '' : 's'}`);
    } catch (err) {
      if (isCurrent()) failStatus($('terms-status'), err);
    }
  }
  async function removeTerm(t) {
    if (!win.confirm(`Remove this ${t.category ? `${t.category} ` : ''}term from the filter?`)) return;
    try {
      await api.admin('customTerms/remove', { id: t.id });
      toast('Term removed.', 'ok');
      void loadTerms();
    } catch (err) { failToast('Remove the term', err); }
  }
  $('terms-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const term = cleanText($('terms-term').value, 64);
    if (term.length < 2) { setStatus($('terms-status'), 'Type a word or phrase (2 characters or more).', 'error'); $('terms-term').focus(); return; }
    const category = cleanText($('terms-category').value, 24) || 'custom';
    try {
      await api.admin('customTerms/add', { term, category, action: $('terms-action').value });
      $('terms-term').value = '';
      toast('Term added: it applies now.', 'ok');
      void loadTerms();
    } catch (err) { failStatus($('terms-status'), err); }
  });
  $('terms-test-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = cleanText($('terms-test').value, 200);
    if (!text) return;
    try {
      const r = await api.admin('customTerms/test', { text });
      const tags = Array.isArray(r.tags) && r.tags.length ? ` — ${r.tags.join(', ')}` : '';
      const verdict = r.action === 'pass' ? 'Shown as typed' : r.action === 'flag' ? 'Shown, flagged for review'
        : r.action === 'mask' ? 'Replaced with a friendly line' : r.action === 'block' ? 'Replaced with a friendly line (blocked)' : String(r.action);
      setStatus($('terms-test-result'), `${verdict}${tags}`);
    } catch (err) { failStatus($('terms-test-result'), err); }
  });
  $('terms-refresh').addEventListener('click', () => void loadTerms());

  // ---------------------------------------------------------------- AUDIT (the actions list)
  let actionsPager = pagerInit();
  const actionKinds = new Set();

  const actionsSeq = latestOnly();
  async function loadActions() {
    if (!signedIn || !can('audit')) return;
    const isCurrent = actionsSeq();
    actionsPager = pagerLoaded(actionsPager, null);
    $('actions-next').disabled = true;
    setStatus($('actions-status'), 'Loading…');
    const body = { limit: 100 };
    const target = cleanText($('actions-target').value, NAME_MAX);
    if (target) body.target = target;
    const cur = pagerCursor(actionsPager);
    if (typeof cur === 'number') body.before = cur;
    try {
      const r = await api.admin('actions', body);
      if (!isCurrent()) return;
      const all = Array.isArray(r.actions) ? r.actions : [];
      let kindsChanged = false;
      for (const a of all) if (typeof a.action === 'string' && !actionKinds.has(a.action)) { actionKinds.add(a.action); kindsChanged = true; }
      if (kindsChanged) syncSelect($('actions-kind'), [['', 'Any action'], ...[...actionKinds].sort().map((k) => [k, k])]);
      const showReads = $('actions-reads').checked;
      const filter = { actor: $('actions-actor').value, kind: $('actions-kind').value };
      const rows = all.filter((a) => (showReads || !isDashboardRead(a)) && auditMatches(a, filter));
      actionsPager = pagerLoaded(actionsPager, r.nextBefore);
      fillRows($('actions-body'), rows, 6, all.length ? 'Nothing on this page matches (try Older, or tick "Show panel reads").' : 'No actions yet.', (a) => h('tr', null,
        timeCell(h, a.ts, now()),
        h('td', { text: a.actor ?? '' }),
        h('td', null, pill(h, String(a.action ?? '?'), `pill-${a.action}`)),
        h('td', { class: 'msg', text: presenting ? (a.targetName || a.targetAccountId ? PRESENT_NAME : '') : actionTargetText(a) }),
        h('td', { class: 'nowrap', text: actionDurationText(a) }),
        h('td', { class: 'msg', text: shownText(a.reason ?? '') }),
      ));
      const hidden = all.length - rows.length;
      $('actions-page-info').textContent = pagerLabel(actionsPager, rows.length) + (hidden ? ` · ${hidden} hidden by the filter` : '');
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
  $('actions-kind').addEventListener('change', () => { actionsPager = pagerInit(); void loadActions(); });
  $('actions-next').addEventListener('click', () => { actionsPager = pagerOlder(actionsPager); void loadActions(); });
  $('actions-prev').addEventListener('click', () => { actionsPager = pagerNewer(actionsPager); void loadActions(); });

  // ---------------------------------------------------------------- wake lock (§3.8: while the panel is visible)
  let wakeLock = null;
  async function keepAwake() {
    try {
      if (!signedIn || doc.hidden || wakeLock || !win.navigator?.wakeLock || win.isSecureContext === false) return;
      wakeLock = await win.navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => { wakeLock = null; });
    } catch { wakeLock = null; }
  }
  function releaseWake() {
    try { wakeLock?.release?.(); } catch { /* gone */ }
    wakeLock = null;
  }

  // ---------------------------------------------------------------- sign in / out, setup
  function clearData() {
    for (const id of ['online-body', 'whois-meta', 'whois-buttons', 'whois-bans', 'whois-actions', 'chat-body', 'reports-body',
      'report-meta', 'report-chat-body', 'bans-body', 'actions-body', 'live-body', 'home-rooms', 'alerts-body', 'banners', 'ctx-body',
      'home-facts', 'home-checklist', 'join-others']) $(id).replaceChildren();
    for (const id of ['online-count', 'chat-page-info', 'reports-page-info', 'actions-page-info', 'who-name', 'who-role', 'live-count',
      'log-stats', 'join-url', 'join-name', 'idle-left', 'retention-text']) $(id).textContent = '';
    for (const id of ['online-status', 'whois-status', 'chat-status', 'reports-list-status', 'report-status', 'bans-status', 'ban-status',
      'actions-status', 'live-status', 'home-status', 'alerts-status', 'announce-status']) setStatus($(id), '');
    $('whois-view').hidden = true;
    $('report-view').hidden = true;
    $('report-empty').hidden = false;
    $('reports-count').hidden = true;
    $('home-count').hidden = true;
    $('alerts-panel').hidden = true;
    $('whois-input').value = '';
    resetChatForm();
    logRoomsKnown.clear();
    liveRooms.clear();
    syncLogRooms();
    syncLiveRooms();
    lastOnline = [];
    lastOnlineSig = '';
    reportRows = [];
    selectedReport = null;
    whoisQuery = '';
    logPager = pagerInit();
    logRows = [];
    logQuery = null;
    logStats = null;
    reportsPager = pagerInit();
    actionsPager = pagerInit();
    liveLines = [];
    livePending = [];
    liveAfter = null;
    lastHome = null;
    lastAlerts = [];
    alertsOpen = false;
    revealed.clear();
    loaded.clear();
    currentTab = null;
  }

  function stopTimers() {
    for (const t of [...timers]) stopTimer(t);
    homeTimer = 0;
    onlineTimer = 0;
    reportsTimer = 0;
    stopLive();
  }

  function hideAll() {
    $('boot-msg').hidden = true;
    $('app-view').hidden = true;
    $('login-view').hidden = true;
    $('setup-view').hidden = true;
  }

  function showLogin(message = '', kind = '') {
    hideAll();
    $('login-view').hidden = false;
    $('login-roles').hidden = false;
    setStatus($('login-status'), message, kind);
    $('login-pass').value = '';
    ($('login-user').value ? $('login-pass') : $('login-user')).focus();
  }

  let setupKind = 'first';
  function showSetup(kind, message = '') {
    hideAll();
    setupKind = kind === 'reset' ? 'reset' : 'first';
    $('setup-view').hidden = false;
    $('setup-first-fields').hidden = setupKind !== 'first';
    $('setup-title').textContent = setupKind === 'first' ? 'Create the host admin login' : 'Set a new host admin password';
    $('setup-intro').textContent = setupKind === 'first'
      ? 'This login opens the Host Control Panel. It is not a player account. The setup code is shown in the Voidswarm window.'
      : 'The host admin password was reset. Choose the login again; the setup code is in the Voidswarm window.';
    // The launcher's code, read (and removed from the address bar) when the page started.
    if (launchSetupCode) $('setup-code').value = launchSetupCode;
    setStatus($('setup-status'), message, message ? 'error' : '');
    ($('setup-code').value ? $('setup-user') : $('setup-code')).focus();
  }
  const syncSchool = () => {
    $('setup-school-fields').hidden = !$('setup-school').checked;
    $('setup-domain-fields').hidden = !$('setup-school').checked;
  };
  $('setup-home').addEventListener('change', syncSchool);
  $('setup-school').addEventListener('change', syncSchool);

  $('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = {
      setupCode: $('setup-code').value, username: $('setup-user').value, password: $('setup-pass').value, password2: $('setup-pass2').value,
      preset: $('setup-home').checked ? 'home' : $('setup-school').checked ? 'school' : '', serverName: $('setup-name').value,
      accountsMode: $('setup-accounts-email').checked ? 'email' : 'roster',
      domains: $('setup-domains').value, domainsSubdomains: $('setup-domains-sub').checked,
    };
    const built = setupBody(form, setupKind === 'first');
    if (built.error) {
      setStatus($('setup-status'), built.error, 'error');
      const field = { setupCode: 'setup-code', username: 'setup-user', password: 'setup-pass', password2: 'setup-pass2', serverName: 'setup-name', preset: 'setup-home', domains: 'setup-domains' }[built.field];
      if (field) $(field).focus();
      return;
    }
    await withBusy($('setup-submit'), async () => {
      setStatus($('setup-status'), 'Creating the login…');
      try {
        const r = await api.admin('setup', built.body);
        if (typeof r.token !== 'string' || !r.token) throw new ApiError(0, 'Unexpected answer from the server.');
        launchSetupCode = '';
        $('setup-code').value = '';
        $('setup-pass').value = '';
        $('setup-pass2').value = '';
        tokens.set(r.token);
        modeStore.clear();
        legacy = false;
        setStatus($('setup-status'), '');
        await enter(true);
      } catch (err) {
        $('setup-pass2').value = '';
        if (err instanceof ApiError && err.status === 404) { showLogin('Setup is already done: sign in.', 'ok'); return; }
        // The answer was lost on the way (no body: the connection dropped, or a stale answer on a reused connection),
        // but the server may have created the login all the same: ask before offering the form again.
        // (setup is never sent twice: setup/status is read again instead, and it is retried like every read.)
        if (isLostAnswer(err) || (err instanceof ApiError && err.status === 0 && !err.body)) {
          try {
            const st = await api.admin('setup/status', {});
            if (st && st.needsSetup === false) {
              launchSetupCode = '';
              $('setup-code').value = '';
              $('setup-pass').value = '';
              $('login-user').value = built.body.username;
              $('login-role-host').checked = true;
              showLogin('Setup is done (its answer was lost on the way): sign in with the login you just chose.', 'ok');
              return;
            }
          } catch { /* below: the error as it is */ }
        }
        let msg = errorText(err);
        if (err instanceof ApiError && typeof err.body?.attemptsLeft === 'number' && err.status === 400 && err.body.field === 'setupCode') msg += ` (${err.body.attemptsLeft} ${err.body.attemptsLeft === 1 ? 'try' : 'tries'} left)`;
        setStatus($('setup-status'), msg, 'error');
        const field = { setupCode: 'setup-code', username: 'setup-user', password: 'setup-pass', serverName: 'setup-name', preset: 'setup-home', domains: 'setup-domains' }[err?.body?.field];
        if (field) $(field).focus();
      }
    });
  });

  async function refreshMe() {
    if (!signedIn) return;
    try {
      const r = await api.admin('me', {});
      if (legacy) return;
      if (r.session && typeof r.session === 'object') applySession({ ...r.session, capabilities: r.capabilities ?? r.session.capabilities });
      renderBanners(r.banners);
      noteOpenReports(r);
    } catch { /* authLost handles a lost session */ }
  }

  function showApp(freshLogin) {
    hideAll();
    $('app-view').hidden = false;
    $('who-name').textContent = me?.username || '?';
    $('who-role').textContent = principalText(session?.principal, legacy);
    signedIn = true;
    const first = defaultTab(tabs);
    if (first) showTab(first);
    else toast('Your role has no panel views here.', 'error');
    homeTimer = every(() => { if (!doc.hidden && currentTab === 'home') void loadHome(true); }, HOME_REFRESH_MS);
    onlineTimer = every(() => {
      if (!signedIn || doc.hidden || currentTab !== 'rooms' || !$('online-auto').checked || dlg.open) return;
      void loadOnline();
    }, ONLINE_REFRESH_MS);
    // Timers and the visibility handler call passive routes only (BACKGROUND_ENDPOINTS): see refreshReportsBadge.
    reportsTimer = every(() => void refreshReportsBadge(), REPORTS_POLL_MS);
    if (!legacy) every(() => void refreshMe(), ME_REFRESH_MS);
    every(() => {
      renderClock();
      // The idle clock ran out: ask the server (a 401 then shows the sign-in with its reason).
      if (!legacy && session && sessionClock(session, now()).idleLeftMs === 0) void refreshMe();
    }, CLOCK_TICK_MS);
    // A page reload is not a deliberate action: only a sign-in reads the report list itself.
    void refreshReportsBadge(!!freshLogin);
    void keepAwake();
  }

  function leaveApp() {
    signedIn = false;
    // Every call still in flight belongs to the session that is ending: aborted, and its answer dropped if it lands.
    endEpoch();
    me = null;
    session = null;
    stopTimers();
    releaseWake();
    if (dlgResolve) finishDialog(null);
    if (reauthResolve) finishReauth(false);
    closeContext();
    if (exportDlg.open) exportDlg.close();
    clearData();
    setCaps([]);
    presenting = false;
    syncPresentingUi();
  }

  /** The session is gone (401), or — the v0.4 API — the account is not (or no longer) a moderator (403). */
  function authLost(status, message) {
    const token = tokens.get();
    const wasIn = signedIn;
    const wasLegacy = legacy;
    tokens.clear();
    modeStore.clear();
    leaveApp();
    // v0.4: a valid game session that is not a moderator's: end it (it's the account's normal 30-day session).
    if (status === 403 && token && wasLegacy) api.logout(token, true).catch(() => { /* best effort */ });
    if (status === 403 && wasLegacy) showLogin('This account is not a moderator.', 'error');
    else showLogin(wasIn ? (message && message !== 'Not signed in' && message !== 'Not logged in' ? message : 'Your session ended — sign in again.') : '', wasIn ? 'error' : '');
  }

  /** Read `me` and open the app. `freshLogin`: a sign-in or setup just now (Presenting follows presentingAtLogin). */
  async function enter(freshLogin = false) {
    const at = epoch;
    // A new sign-in starts with nothing revealed (a reveal answered for the last person was dropped, never kept).
    revealed.clear();
    try {
      const r = await api.admin('me', {});
      if (at !== epoch || stopped) return false;
      if (!r.admin || typeof r.admin !== 'object') throw new ApiError(0, 'Unexpected answer from the server.');
      me = r.admin;
      if (Array.isArray(r.capabilities) || (r.session && Array.isArray(r.session.capabilities))) {
        legacy = false;
        modeStore.clear();
        applySession({ ...(r.session ?? {}), capabilities: r.capabilities ?? r.session.capabilities });
        renderBanners(r.banners);
        noteOpenReports(r);
      } else {
        // The v0.4 moderator API: no capabilities, no session clock.
        legacy = true;
        modeStore.set('legacy');
        session = null;
        setCaps([...LEGACY_CAPS]);
        renderBanners([]);
      }
      signedIn = true;
      // Presenting before any view renders: the School default at a new sign-in, else this browser's choice. The
      // default is in `home` (every panel role reads it: status.counts), unless `me` carries it. If it can't be read
      // at a sign-in, Presenting starts ON (fail closed: School's projector default must not fail open); it is not
      // remembered, and switching it off right after a sign-in needs no password (the session is fresh).
      let atLogin = r.presentingAtLogin ?? r.prefs?.presentingAtLogin;
      let failClosed = false;
      if (atLogin === undefined && freshLogin && !legacy && can('status.counts')) {
        try {
          const home = await api.admin('home', {});
          if (!still(at)) return false;
          atLogin = home.presentingAtLogin;
          // A reply without the flag says nothing about School: the same fail-closed start as a failed read.
          if (typeof atLogin !== 'boolean') failClosed = true;
          if (can('status')) {
            lastHome = home;
            lastHomeAt = now();
            if (Array.isArray(home.classPeriods)) setPeriods(home.classPeriods);
          }
          noteOpenReports(home);
        } catch {
          if (!still(at)) return false; // signed out meanwhile (a 401 there: authLost showed the sign-in)
          failClosed = true;
        }
      }
      presenting = failClosed || presentingAtStart({ remembered: prefs.presenting(), atLogin, freshLogin });
      if (freshLogin && atLogin === true) prefs.setPresenting(true);
      syncPresentingUi();
      showApp(freshLogin);
      return true;
    } catch (err) {
      if (at !== epoch || (err instanceof ApiError && err.body?.code === 'aborted')) return false;
      if (err instanceof ApiError && (err.status === 401 || (err.status === 403 && legacy))) return false; // authLost showed the sign-in
      // 403 here: the session can't be used from this place (remote access off, plain http): forget it.
      if (err instanceof ApiError && err.status === 403) { tokens.clear(); modeStore.clear(); }
      signedIn = false;
      showLogin(errorText(err), 'error');
      return false;
    }
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = cleanText($('login-user').value, 254);
    const password = $('login-pass').value;
    const role = $('login-role-mod').checked ? 'moderator' : 'host';
    if (!username || !password) { setStatus($('login-status'), 'Enter your username and password.', 'error'); return; }
    await withBusy($('login-submit'), async () => {
      setStatus($('login-status'), 'Signing in…');
      try {
        const r = await api.login(role, username, password);
        tokens.set(r.token);
        legacy = r.legacy;
        if (legacy) modeStore.set('legacy'); else modeStore.clear();
        $('login-pass').value = '';
        const ok = await enter(true);
        if (ok) setStatus($('login-status'), '');
      } catch (err) {
        $('login-pass').value = '';
        if (err instanceof ApiError && err.status === 401 && err.body?.needsSetup) { void startSetupOrLogin(errorText(err)); return; }
        setStatus($('login-status'), err instanceof ApiError && err.status === 401 ? 'Wrong username or password.' : errorText(err), 'error');
      }
    });
  });

  $('logout-btn').addEventListener('click', () => {
    const token = tokens.get();
    const wasLegacy = legacy;
    // End the server session first (it needs the token), then forget it here.
    const bye = token ? api.logout(token, wasLegacy).catch(() => { /* best effort: the local copy goes anyway */ }) : Promise.resolve();
    void bye.finally(() => {
      tokens.clear();
      modeStore.clear();
    });
    leaveApp();
    showLogin('Signed out.', 'ok');
  });

  // Returning to the tab: refresh at once instead of waiting for a timer.
  doc.addEventListener('visibilitychange', () => {
    if (doc.hidden || !signedIn) return;
    if (currentTab === 'rooms') void loadOnline();
    if (currentTab === 'home') void loadHome();
    void refreshReportsBadge();
    void refreshMe();
    void keepAwake();
  });

  /**
   * No session: first-run setup (host PC, pending), else the sign-in. `resume`: a stored session to try when no setup
   * is pending (the page started with both a token and the launcher's setup code).
   */
  async function startSetupOrLogin(message = '', { resume = false } = {}) {
    try {
      const st = await api.admin('setup/status', {});
      if (st.needsSetup) {
        let msg = message;
        if (Number(st.retryAfter) > 0) msg = `Too many wrong setup codes: wait ${formatSpan(Number(st.retryAfter) * 1000)} (or restart Voidswarm for a new code).`;
        showSetup(st.kind === 'reset' ? 'reset' : 'first', msg);
        return;
      }
      if (resume && tokens.get()) { void enter(false); return; }
      showLogin(message, message ? 'error' : '');
    } catch (err) {
      if (resume && tokens.get()) { void enter(false); return; }
      // 403: not the host PC (setup only works there); 404: the v0.4 API (no setup).
      showLogin(err instanceof ApiError && (err.status === 403 || err.status === 404) ? message : message || errorText(err), message ? 'error' : err instanceof ApiError && (err.status === 403 || err.status === 404) ? '' : 'error');
    }
  }

  // ---------------------------------------------------------------- start
  syncRange();
  setCaps([]);
  if (launchSetupCode) {
    // The launcher only adds the code while setup is pending: that screen comes first, even with a stored session.
    $('boot-msg').textContent = 'Checking the setup…';
    void startSetupOrLogin('', { resume: true });
  } else if (tokens.get()) {
    $('boot-msg').textContent = 'Checking your session…';
    void enter(false);
  } else {
    void startSetupOrLogin();
  }

  return {
    stop() {
      stopped = true;
      endEpoch();
      stopTimers();
      releaseWake();
    },
    state: () => ({ signedIn, legacy, presenting, caps: [...caps], tabs: [...tabs], currentTab, liveAfter, revealed: new Map(revealed) }),
  };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.getElementById('login-view')) {
  try {
    boot({ doc: document, win: window });
  } catch (e) {
    const m = document.getElementById('boot-msg');
    if (m) { m.hidden = false; m.textContent = 'The control panel failed to start — see the browser console.'; }
    console.error(e);
  }
}
