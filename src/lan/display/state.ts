// OWNER: ADMIN UI (B9). The projector-safe view of the host (docs/LAN-EDITION-proposal.md §5.3, §5.6, §5.15):
//  - `home` (the panel's Home tab; capability status.counts; a PASSIVE route): the Join card, the rooms, players
//    online, alert COUNTS (with the wellbeing ones split by level), the open-report count (the Reports badge: the page's
//    timers read it here, because a `reports` call is deliberate activity, §4.10), device checks, the first device, the
//    setup checklist, the class periods and the Presenting default;
//  - `display/state` (the /display projector page; loopback only, no session): a long-poll of the server name, the join
//    URL, the certificate fingerprint, the rooms and their phase, the latest [Host] announcement and the chat notice;
//  - `announce` (capability announce): Zone.announce(), audited, and remembered as the projector's latest line.
// Only whitelisted, projector-safe fields leave here. Never chat text, a player's name (a room's host player is left
// out too, and a player's room shows as "Room N": the client names it after its creator), an address or an alert's
// details: `home` carries alert counts only, and the page opens the list with alerts/list. Moderators get counts only
// from `home` (§5.2 "Home, Server status: counts only"): the room and player counts, the open-report count when they
// have `reports`, and the Presenting default (a setting, not data).
// No DOM, no Node APIs beyond timers: the server passes what it knows in PanelStateDeps (app.ts wires the Zone, the
// moderation service, the settings and the launcher's addresses).
import type { AdminReply, AdminRouteContext, AdminRouteHandler } from '../../server/moderation/http';

// ------------------------------------------------------------------------------------------
// Inputs
// ------------------------------------------------------------------------------------------

/** What the Join card shows (B12/B13 fill the https side; M1 has the http landing URL only). */
export interface PanelJoin {
  /** The one join URL of the Join card and /display (§3.4; text only, no QR code): the http landing page, or https with devicesTrustCert. */
  url: string | null;
  /** The secure address, when there is a certificate. */
  secureUrl?: string | null;
  /** The root certificate's SHA-256 (colon hex), when there is one. */
  fingerprint?: string | null;
  /** "Other addresses (may not work)" — the panel only, never the projector. */
  others?: readonly string[];
  /** Why players can't join yet ("Players can join after setup"); null when they can. */
  notServing?: string | null;
}

/** A room as the Zone summarizes it (protocol RoomSummary); only the fields below are read. */
export interface PanelRoomSource {
  id: string;
  name: string;
  gameType?: string;
  subMode?: string;
  mode?: string;
  teamCount?: number;
  phase?: string;
  humans?: number;
  bots?: number;
  spectators?: number;
  maxPlayers?: number;
  house?: boolean;
  pinned?: boolean;
  floors?: number;
  startsInSec?: number;
}

/** A connected pilot (Zone.onlinePilots): only the room and whether it has an account are read, never the name. */
export interface PanelPilotSource { roomId: string | null; roomName?: string | null; accountId?: string | null }

export interface AnnounceOutcome { ok: boolean; delivered?: number; roomId?: string | null; error?: string }

export interface PanelStateDeps {
  serverName(): string;
  join(): PanelJoin | null;
  /** The rooms (a public Zone room list); without it they are derived from `pilots` (names and head counts only). */
  rooms?(): readonly PanelRoomSource[];
  pilots?(): readonly PanelPilotSource[];
  /** The generated chat notice (§4.15, §8.2). */
  notice?(): string;
  /**
   * Open alert counts (ModerationService.alertCounts). A wellbeing alert is urgent or banner (SELF-HARM notify, or
   * urgent from a folded urgent tag): `wellbeingUrgent` / `wellbeingBanner` say which. Without them, `home` counts the
   * route's moderation service's open alert list (AdminRouteContext.service), else leaves the split out.
   */
  alerts?(): { urgent: number; banner: number; wellbeing?: number; wellbeingUrgent?: number; wellbeingBanner?: number };
  /** Open reports for the Reports badge; default: the route's moderation service (listReports 'open', capped). */
  openReports?(): { open: number; more?: boolean } | number | null;
  /** Device checks today (B13's /check). */
  checks?(): { passed: number; failed: number; summary?: string } | null;
  /** The first other device that reached this PC (B14). */
  firstDevice?(): { at: number } | null;
  /** The setup checklist: recovery file, network check, certificate (B5, B12, B14). */
  setupChecklist?(): readonly { id: string; label: string; done: boolean }[];
  /** Settings → Chat → Class periods (the Chat log's "This class period" filter). */
  classPeriods?(): readonly { name: string; start: string; end: string; days: readonly number[] }[];
  /** Settings admin.presentingAtLogin (School: on). */
  presentingAtLogin?(): boolean;
  /** Zone.announce(text, roomId). */
  announce?(text: string, roomId: string | null): AnnounceOutcome;
  /** Write the mod_actions row of an announcement (ModerationService.audit(actor, 'announce', null, reason)). */
  audit?(actor: { accountId: string; name: string }, reason: string): void;
  now?(): number;
  log?(line: string): void;
}

// ------------------------------------------------------------------------------------------
// Outputs
// ------------------------------------------------------------------------------------------

export interface DisplayRoom {
  roomId: string;
  name: string;
  gameType: string | null;
  typeLabel: string;
  subMode: string | null;
  subModeLabel: string;
  phase: string | null;
  phaseLabel: string;
  humans: number;
  bots: number;
  spectators: number;
  maxPlayers: number;
  house: boolean;
  pinned: boolean;
}

export interface DisplayAnnouncement { text: string; target: string; roomId: string | null; at: number }

/** display/state's reply (every key; display.js renders these and nothing else). */
export interface DisplayState {
  rev: number;
  serverName: string;
  joinUrl: string | null;
  secureUrl: string | null;
  fingerprint: string | null;
  notServing: string | null;
  rooms: DisplayRoom[];
  announcement: DisplayAnnouncement | null;
  notice: string;
}

/** The keys of a display/state reply besides `ok` (T-UI-8 checks nothing else is sent). */
export const DISPLAY_STATE_KEYS: readonly (keyof DisplayState)[] = [
  'rev', 'serverName', 'joinUrl', 'secureUrl', 'fingerprint', 'notServing', 'rooms', 'announcement', 'notice',
];

/** The longest a display/state long-poll waits (s). */
export const DISPLAY_MAX_WAIT_SEC = 25;
/** While a projector waits, the state is re-read this often (ms) to see whether it changed. */
export const DISPLAY_POLL_MS = 1500;
/** Long-polls waiting at once (loopback only; beyond this they answer at once). */
export const DISPLAY_MAX_WAITERS = 8;
/** An announcement stays on the projector this long (then the next class starts clean). */
export const ANNOUNCEMENT_SHOW_MS = 12 * 3600_000;
export const ANNOUNCE_TEXT_MAX = 200;
/** Rooms listed (MAX_ROOMS is 24). */
export const DISPLAY_MAX_ROOMS = 32;
/** The Reports badge counts up to this many open reports ("200+" beyond). */
export const OPEN_REPORTS_MAX = 200;
/**
 * Without a PanelStateDeps.openReports count, the badge is read from the service's report list, which parses every
 * report's chat copy on the game thread (§5.16): it is re-read at most this often (ms), however many tabs poll `home`.
 */
export const OPEN_REPORTS_CACHE_MS = 10_000;

// ------------------------------------------------------------------------------------------
// Labels (the page has no access to src/shared/data/gameTypes.ts; same words)
// ------------------------------------------------------------------------------------------

const TYPE_LABELS: Readonly<Record<string, string>> = { dungeon: 'Dungeon Runner', arena: 'Arena', warzone: 'Warzone' };
const SUB_MODE_LABELS: Readonly<Record<string, string>> = {
  coop: 'Co-op Descent', rival: 'Rival Rift', deathmatch: 'Deathmatch', ctf: 'Capture the Flag', zones: 'Control Zones',
  hotpoint: 'Hot Point', escort: 'Escort',
};
const PHASE_LABELS: Readonly<Record<string, string>> = { lobby: 'Waiting', countdown: 'Starting', playing: 'Playing', results: 'Results' };

const own = (o: Readonly<Record<string, string>>, k: unknown): string | undefined =>
  (typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

export function typeLabel(t: unknown): string { return own(TYPE_LABELS, t) ?? ''; }
export function subModeLabel(t: unknown, s: unknown): string {
  if (t === 'warzone' && s === 'deathmatch') return 'Classic';
  return own(SUB_MODE_LABELS, s) ?? '';
}
export function phaseLabel(p: unknown): string { return own(PHASE_LABELS, p) ?? ''; }

// ------------------------------------------------------------------------------------------
// Sanitizing (scalars only, capped)
// ------------------------------------------------------------------------------------------

/** Control characters, plus the line and paragraph separators (built from char codes, not written literally). */
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${String.fromCharCode(0x2028, 0x2029)}]+`, 'g');
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(CONTROL, ' ').trim().slice(0, max) : '');
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(1e6, Math.floor(v)) : 0);
const url = (v: unknown): string | null => {
  const s = text(v, 300);
  return /^https?:\/\/[^\s"'<>\\]+$/i.test(s) ? s : null;
};
/** A certificate fingerprint as shown ("3F:9A:…:C2" or the full colon hex): hex digits, colons, spaces, an ellipsis. */
const fp = (v: unknown): string | null => {
  const s = text(v, 200);
  return /^[0-9A-Fa-f][0-9A-Fa-f: …]{3,199}$/.test(s) ? s : null;
};

/**
 * A room's projector-safe name. A house room (the host's own, userCreated = false) keeps its name. A player's room is
 * "Room N" from its id: the client names a new room after its creator by default ("NovaPilot's Arena", main.ts), and
 * a player may type anything there, so its name is a player's words and never reaches Home or the projector (T-UI-8:
 * no names). The type and sub-mode columns still say what it is.
 */
export function safeRoomName(r: Pick<PanelRoomSource, 'id' | 'name' | 'house'>): string {
  if (r.house === true) return text(r.name, 48) || 'Room';
  const m = /^r(\d{1,6})$/.exec(typeof r.id === 'string' ? r.id : '');
  return m ? `Room ${m[1]}` : 'Room';
}

/** The projector-safe row of one room: never its host player's name, never a player-chosen room name. */
export function displayRoom(r: PanelRoomSource): DisplayRoom {
  const gameType = text(r.gameType, 16) || null;
  const subMode = text(r.subMode, 16) || null;
  const phase = text(r.phase, 16) || null;
  return {
    roomId: text(r.id, 32), name: safeRoomName(r), gameType, typeLabel: typeLabel(gameType), subMode,
    subModeLabel: subModeLabel(gameType, subMode), phase, phaseLabel: phaseLabel(phase), humans: count(r.humans), bots: count(r.bots),
    spectators: count(r.spectators), maxPlayers: count(r.maxPlayers), house: r.house === true, pinned: r.pinned === true,
  };
}

/** Rooms from a pilot list (no public room list): safe names ("Room N": a pilot can't say which is a house room) and head counts only. */
function roomsFromPilots(pilots: readonly PanelPilotSource[]): DisplayRoom[] {
  const by = new Map<string, number>();
  for (const p of pilots) {
    if (!p || typeof p.roomId !== 'string' || !p.roomId) continue;
    by.set(p.roomId, (by.get(p.roomId) ?? 0) + 1);
  }
  return [...by.entries()].map(([id, n]) => displayRoom({ id, name: '', humans: n }));
}

// ------------------------------------------------------------------------------------------
// The service
// ------------------------------------------------------------------------------------------

interface Waiter { after: number; finish(): void }

export interface PanelState {
  /** home, display/state, announce — for AdminHttpOptions.handlers. */
  readonly handlers: Readonly<Record<'home' | 'display/state' | 'announce', AdminRouteHandler>>;
  /** The projector's view now (tests, and the `status` of the launcher). */
  displayState(): DisplayState;
  /** Remember an announcement made elsewhere (a future console command) for the projector. */
  noteAnnouncement(a: { text: string; roomId: string | null; at?: number }): void;
  /** Answer every waiting projector and stop (shutdown). */
  close(): void;
}

export function createPanelState(deps: PanelStateDeps): PanelState {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  let rev = 1;
  let lastSig = '';
  let latest: DisplayAnnouncement | null = null;
  const waiters = new Set<Waiter>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const safe = <T>(what: string, fn: () => T, dflt: T): T => {
    try { return fn(); } catch (e) {
      log(`[panel] ${what} could not be read: ${(e as Error)?.message ?? e}`);
      return dflt;
    }
  };

  const rooms = (): DisplayRoom[] => {
    const list = deps.rooms ? safe('the rooms', () => deps.rooms!(), [] as readonly PanelRoomSource[]) : null;
    const out = list ? list.filter((r) => r && typeof r.id === 'string').map(displayRoom) : roomsFromPilots(safe('the pilots', () => deps.pilots?.() ?? [], [] as readonly PanelPilotSource[]));
    return out.slice(0, DISPLAY_MAX_ROOMS);
  };

  const joinInfo = (): Required<Omit<PanelJoin, 'others'>> & { others: string[] } => {
    const j = safe('the join address', () => deps.join(), null) ?? { url: null };
    return {
      url: url(j.url), secureUrl: url(j.secureUrl), fingerprint: fp(j.fingerprint),
      others: Array.isArray(j.others) ? j.others.map((o) => text(o, 120)).filter(Boolean).slice(0, 16) : [],
      notServing: text(j.notServing, 200) || null,
    };
  };

  const announcementNow = (): DisplayAnnouncement | null => (latest && now() - latest.at <= ANNOUNCEMENT_SHOW_MS ? latest : null);

  /** The display state with the current rev (bumped when anything shown changed). */
  const compute = (): DisplayState => {
    const j = joinInfo();
    const body = {
      serverName: text(safe('the server name', () => deps.serverName(), 'Voidswarm'), 60) || 'Voidswarm',
      joinUrl: j.url, secureUrl: j.secureUrl, fingerprint: j.fingerprint, notServing: j.notServing,
      rooms: rooms(), announcement: announcementNow(), notice: text(safe('the notice', () => deps.notice?.() ?? '', ''), 600),
    };
    const sig = JSON.stringify(body);
    if (sig !== lastSig) {
      if (lastSig) rev++;
      lastSig = sig;
    }
    return { rev, ...body };
  };

  const wake = (): void => {
    if (!waiters.size) return;
    const st = compute();
    for (const w of [...waiters]) if (w.after !== st.rev) w.finish();
  };

  const ensureTimer = (): void => {
    if (timer || !waiters.size) return;
    timer = setInterval(() => {
      if (!waiters.size) { if (timer) clearInterval(timer); timer = null; return; }
      wake();
    }, DISPLAY_POLL_MS);
    (timer as { unref?: () => void }).unref?.();
  };

  const waitFor = (after: number, waitMs: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(t);
      signal.removeEventListener('abort', finish);
      waiters.delete(w);
      if (!waiters.size && timer) { clearInterval(timer); timer = null; }
      resolve();
    };
    const w: Waiter = { after, finish };
    const t = setTimeout(finish, waitMs);
    (t as { unref?: () => void }).unref?.();
    signal.addEventListener('abort', finish, { once: true });
    waiters.add(w);
    ensureTimer();
  });

  const roomNameOf = (roomId: string | null): string => {
    if (!roomId) return 'All rooms';
    return rooms().find((r) => r.roomId === roomId)?.name ?? 'One room';
  };

  const note = (a: { text: string; roomId: string | null; at?: number }): void => {
    const body = text(a.text, ANNOUNCE_TEXT_MAX);
    if (!body) return;
    latest = { text: body, roomId: a.roomId, target: roomNameOf(a.roomId), at: Math.floor(a.at ?? now()) };
    wake();
  };

  const bad = (error: string): AdminReply => [400, { error }];
  let reportsCache: { svc: unknown; at: number; value: { open: number; more: boolean } | null } | null = null;

  /** The Reports badge: { open, more } (a count, never who), or null when nothing says. */
  const openReports = (c: AdminRouteContext): { open: number; more: boolean } | null => {
    if (!c.can('reports')) return null;
    if (deps.openReports) {
      const o = safe('the open reports', () => deps.openReports!(), null);
      if (typeof o === 'number') return { open: count(o), more: false };
      return o && typeof o === 'object' ? { open: count(o.open), more: o.more === true } : null;
    }
    const svc = c.service;
    if (!svc || typeof svc.listReports !== 'function') return null;
    const t = now();
    if (reportsCache && reportsCache.svc === svc && t - reportsCache.at >= 0 && t - reportsCache.at < OPEN_REPORTS_CACHE_MS) return reportsCache.value;
    const page = safe('the open reports', () => svc.listReports('open', OPEN_REPORTS_MAX), null);
    const value = page ? { open: Math.min(OPEN_REPORTS_MAX, page.reports.length), more: page.nextBefore !== null } : null;
    reportsCache = { svc, at: t, value };
    return value;
  };

  /** The wellbeing alerts by level, from the counts or else the service's open alert list; {} when unknown. */
  const wellbeingSplit = (a: ReturnType<NonNullable<PanelStateDeps['alerts']>> | null, c: AdminRouteContext): { wellbeingUrgent?: number; wellbeingBanner?: number } => {
    if (typeof a?.wellbeingUrgent === 'number' && typeof a?.wellbeingBanner === 'number') return { wellbeingUrgent: count(a.wellbeingUrgent), wellbeingBanner: count(a.wellbeingBanner) };
    if (!count(a?.wellbeing)) return { wellbeingUrgent: 0, wellbeingBanner: 0 };
    const svc = c.service;
    if (!svc || typeof svc.alertsList !== 'function') return {};
    const open = safe('the alert list', () => svc.alertsList({ includeAcked: false }), null);
    if (!open) return {};
    const wb = open.filter((x) => x.kind === 'wellbeing' && !x.acked);
    return { wellbeingUrgent: wb.filter((x) => x.level === 'urgent').length, wellbeingBanner: wb.filter((x) => x.level === 'banner').length };
  };

  const home: AdminRouteHandler = (_b: Record<string, unknown>, c: AdminRouteContext): AdminReply => {
    const pilots = safe('the pilots', () => deps.pilots?.() ?? [], [] as readonly PanelPilotSource[]);
    const list = rooms();
    const online = { total: pilots.length, accounts: pilots.filter((p) => !!p?.accountId).length, guests: 0 };
    online.guests = online.total - online.accounts;
    const playing = list.filter((r) => r.phase === 'playing').length;
    const reports = openReports(c);
    const presentingAtLogin = safe('the Presenting default', () => deps.presentingAtLogin?.() === true, false);
    if (c.principal?.kind !== 'host') {
      // Moderators: counts only (§5.2), plus the Presenting default (School: on at every sign-in, theirs too).
      return [200, { ok: true, counts: { online: online.total, rooms: list.length, playing }, ...(reports ? { openReports: reports } : {}), presentingAtLogin }];
    }
    const a = safe('the alert counts', () => deps.alerts?.() ?? null, null);
    const checks = safe('the device checks', () => deps.checks?.() ?? null, null);
    const first = safe('the first device', () => deps.firstDevice?.() ?? null, null);
    const periods = safe('the class periods', () => deps.classPeriods?.() ?? [], [] as NonNullable<ReturnType<NonNullable<PanelStateDeps['classPeriods']>>>);
    const j = joinInfo();
    const st = compute();
    return [200, {
      ok: true,
      serverName: st.serverName,
      join: { url: j.url, secureUrl: j.secureUrl, fingerprint: j.fingerprint, others: j.others, notServing: j.notServing },
      rooms: list,
      counts: { online: online.total, rooms: list.length, playing },
      online,
      alerts: { urgent: count(a?.urgent), banner: count(a?.banner), wellbeing: count(a?.wellbeing), ...wellbeingSplit(a, c) },
      ...(reports ? { openReports: reports } : {}),
      checks: checks ? { passed: count(checks.passed), failed: count(checks.failed), summary: text(checks.summary, 200) } : null,
      firstDevice: first && Number.isFinite(first.at) ? { at: Math.floor(first.at) } : null,
      setupChecklist: safe('the setup checklist', () => deps.setupChecklist?.() ?? [], [] as readonly { id: string; label: string; done: boolean }[])
        .slice(0, 12).map((x) => ({ id: text(x.id, 32), label: text(x.label, 120), done: x.done === true })),
      classPeriods: periods.slice(0, 24).map((p) => ({
        name: text(p.name, 40), start: text(p.start, 5), end: text(p.end, 5),
        days: Array.isArray(p.days) ? p.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [],
      })),
      presentingAtLogin,
      announcement: st.announcement,
      notice: st.notice,
    }];
  };

  const displayState: AdminRouteHandler = async (b: Record<string, unknown>, c: AdminRouteContext): Promise<AdminReply> => {
    let after: number | null = null;
    if (b.after !== undefined && b.after !== null) {
      if (typeof b.after !== 'number' || !Number.isInteger(b.after) || b.after < 0) return bad('after must be the rev of the last answer');
      after = b.after;
    }
    let waitSec = after === null ? 0 : DISPLAY_MAX_WAIT_SEC;
    if (b.wait !== undefined && b.wait !== null) {
      if (typeof b.wait !== 'number' || !Number.isFinite(b.wait) || b.wait < 0 || b.wait > DISPLAY_MAX_WAIT_SEC) return bad(`wait must be 0 to ${DISPLAY_MAX_WAIT_SEC} (seconds)`);
      waitSec = b.wait;
    }
    let st = compute();
    if (after !== null && after === st.rev && waitSec > 0 && !closed && waiters.size < DISPLAY_MAX_WAITERS && !c.signal.aborted) {
      await waitFor(after, Math.round(waitSec * 1000), c.signal);
      st = compute();
    }
    const out: Record<string, unknown> = { ok: true };
    for (const k of DISPLAY_STATE_KEYS) out[k] = st[k];
    return [200, out];
  };

  const announce: AdminRouteHandler = (b: Record<string, unknown>, c: AdminRouteContext): AdminReply => {
    if (typeof b.text !== 'string') return bad(`Type an announcement (1–${ANNOUNCE_TEXT_MAX} characters).`);
    const body = text(b.text, ANNOUNCE_TEXT_MAX + 1);
    if (!body || body.length > ANNOUNCE_TEXT_MAX) return bad(`Type an announcement (1–${ANNOUNCE_TEXT_MAX} characters).`);
    let roomId: string | null = null;
    if (b.roomId !== undefined && b.roomId !== null) {
      if (typeof b.roomId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(b.roomId)) return bad('roomId must be a room id, or left out for every room.');
      roomId = b.roomId;
    }
    if (!deps.announce) return [503, { error: 'Announcements are not available on this server.' }];
    let res: AnnounceOutcome;
    try { res = deps.announce(body, roomId); } catch (e) {
      log(`[panel] announce failed: ${(e as Error)?.message ?? e}`);
      return [500, { error: 'The announcement could not be sent.' }];
    }
    if (!res || !res.ok) return [400, { error: text(res?.error, 200) || 'The announcement could not be sent.' }];
    const target = roomNameOf(roomId);
    try { deps.audit?.(c.actor, `announcement to ${target}: ${body}`); } catch (e) { log(`[panel] the announcement audit failed: ${(e as Error)?.message ?? e}`); }
    note({ text: body, roomId });
    return [200, { ok: true, delivered: count(res.delivered), roomId }];
  };

  return {
    handlers: Object.freeze({ home, 'display/state': displayState, announce }),
    displayState: compute,
    noteAnnouncement: note,
    close() {
      closed = true;
      for (const w of [...waiters]) w.finish();
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}
