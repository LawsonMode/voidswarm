// OWNER: ADMIN UI (B9). The projector page, /display on the admin listener (docs/LAN-EDITION-proposal.md §5.3): the big
// join URL (text only: no QR code, owner decision 7), the server name and certificate fingerprint, the rooms and their
// phase, the latest [Host] announcement and the chat notice. It NEVER shows chat, names or alerts: it asks only
// display/state (loopback only, no login; the server sends only those fields: src/lan/display/state.ts) and renders a
// whitelist of them, so an extra field could never reach the screen. Updates by long-poll. CSP-safe: no inline script, textContent only.
// Pure helpers are exported for display.test.ts; the page boots only in a browser (or a test's fake document).

export const STATE_URL = '/api/admin/display/state';
/** Wait per long-poll (s): the server holds the answer until something shown changes. */
export const DISPLAY_WAIT_SEC = 25;
/** After a failed poll, try again after this long (ms). */
export const RETRY_MS = 3000;
/** A poll that came back at once with nothing new waits at least this long before the next (ms). */
export const MIN_GAP_MS = 1000;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * The only fields the projector renders (T-UI-8): whatever else a reply carried is dropped here. Rooms keep their
 * name, type, sub-mode, phase and counts; the announcement its text, target and time.
 */
export function displayModel(state) {
  const s = state && typeof state === 'object' ? state : {};
  const rooms = Array.isArray(s.rooms) ? s.rooms.slice(0, 32).filter((r) => r && typeof r === 'object').map((r) => ({
    name: str(r.name, 48) || 'Room',
    typeLabel: str(r.typeLabel, 40),
    subModeLabel: str(r.subModeLabel, 40),
    phase: str(r.phase, 16),
    phaseLabel: str(r.phaseLabel, 20),
    humans: num(r.humans),
    spectators: num(r.spectators),
    maxPlayers: num(r.maxPlayers),
    house: r.house === true,
  })) : [];
  const a = s.announcement && typeof s.announcement === 'object' ? s.announcement : null;
  return {
    rev: num(s.rev),
    serverName: str(s.serverName, 60) || 'Voidswarm',
    joinUrl: str(s.joinUrl, 300),
    secureUrl: str(s.secureUrl, 300),
    fingerprint: str(s.fingerprint, 200),
    notServing: str(s.notServing, 200),
    rooms,
    announcement: a && str(a.text, 200) ? { text: str(a.text, 200), target: str(a.target, 60), at: num(a.at) } : null,
    notice: str(s.notice, 600),
  };
}

/** "Arena · Capture the Flag" */
export function roomMode(r) {
  return [r.typeLabel, r.subModeLabel].filter(Boolean).join(' · ');
}

/** "7 / 16 playing · 2 watching" */
export function roomCounts(r) {
  const max = r.maxPlayers ? ` / ${r.maxPlayers}` : '';
  return `${r.humans}${max}${r.spectators ? ` · ${r.spectators} watching` : ''}`;
}

export function clockText(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '';
}

/** Render `model` into the page (only textContent, only the whitelisted model). */
export function renderDisplay(doc, model) {
  const $ = (id) => doc.getElementById(id);
  const set = (id, text) => { const n = $(id); if (n) n.textContent = text; };
  const show = (id, on) => { const n = $(id); if (n) n.hidden = !on; };
  set('d-name', model.serverName);
  if (doc.title !== undefined) doc.title = `${model.serverName} — join the game`;
  set('d-url', model.joinUrl || (model.notServing ? 'Not open to other devices yet' : 'Connecting…'));
  set('d-secure', model.secureUrl && model.secureUrl !== model.joinUrl ? `Secure: ${model.secureUrl}` : '');
  show('d-secure', !!model.secureUrl && model.secureUrl !== model.joinUrl);
  set('d-not-serving', model.notServing);
  show('d-not-serving', !!model.notServing);
  set('d-fp', model.fingerprint ? `Certificate fingerprint (compare on your device): ${model.fingerprint}` : '');
  show('d-fp', !!model.fingerprint);
  if (model.announcement) {
    set('d-announce-text', model.announcement.text);
    set('d-announce-target', model.announcement.target && model.announcement.target !== 'All rooms' ? `to ${model.announcement.target}` : '');
    set('d-announce-time', clockText(model.announcement.at));
  }
  show('d-announce', !!model.announcement);
  const list = $('d-rooms');
  if (list) {
    const items = model.rooms.map((r) => {
      const li = doc.createElement('li');
      li.className = 'd-room';
      const name = doc.createElement('div');
      name.className = 'd-room-name';
      name.textContent = r.name;
      const mode = doc.createElement('div');
      mode.className = 'd-room-mode';
      mode.textContent = roomMode(r);
      const meta = doc.createElement('div');
      meta.className = 'd-room-meta';
      const phase = doc.createElement('span');
      phase.className = `d-phase d-phase-${/^[a-z]+$/.test(r.phase) ? r.phase : 'unknown'}`;
      phase.textContent = r.phaseLabel;
      const counts = doc.createElement('span');
      counts.textContent = roomCounts(r);
      meta.append(phase, counts);
      li.append(name, mode, meta);
      return li;
    });
    if (!items.length) {
      const li = doc.createElement('li');
      li.className = 'd-empty';
      li.textContent = 'No rooms yet — the first player to join makes one.';
      items.push(li);
    }
    list.replaceChildren(...items);
  }
  set('d-notice', model.notice);
}

/**
 * Start the page: long-poll display/state and render each answer. env: { doc, win }.
 * Returns { stop() } (tests).
 */
export function bootDisplay(env) {
  const { doc, win } = env;
  let stopped = false;
  let rev = null;
  let ctrl = null;
  let wake = null;
  const status = (t) => { const n = doc.getElementById('d-status'); if (n) n.textContent = t; };

  const keepAwake = async () => {
    try {
      if (stopped || doc.hidden || wake || !win.navigator?.wakeLock) return;
      wake = await win.navigator.wakeLock.request('screen');
      wake.addEventListener?.('release', () => { wake = null; });
    } catch { wake = null; }
  };

  const poll = async () => {
    while (!stopped) {
      const started = Date.now();
      ctrl = new win.AbortController();
      try {
        const res = await win.fetch(STATE_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(rev === null ? {} : { after: rev, wait: DISPLAY_WAIT_SEC }),
          cache: 'no-store', credentials: 'same-origin', referrerPolicy: 'no-referrer', signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const model = displayModel(await res.json());
        const changed = model.rev !== rev;
        rev = model.rev;
        renderDisplay(doc, model);
        status('');
        if (!changed && Date.now() - started < MIN_GAP_MS) await sleep(MIN_GAP_MS);
      } catch {
        if (stopped) return;
        status('Reconnecting to the host…');
        await sleep(RETRY_MS);
      }
    }
  };

  const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
  doc.addEventListener?.('visibilitychange', () => { if (!doc.hidden) void keepAwake(); });
  void keepAwake();
  const done = poll();
  return {
    done,
    stop() {
      stopped = true;
      try { ctrl?.abort(); } catch { /* gone */ }
      try { wake?.release?.(); } catch { /* gone */ }
    },
  };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.getElementById('d-main')) {
  bootDisplay({ doc: document, win: window });
}
