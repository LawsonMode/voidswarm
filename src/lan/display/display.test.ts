// OWNER: ADMIN UI (B9). T-UI-8: /display shows no chat text, names or alerts (docs/LAN-EDITION-proposal.md §5.3, §11.7).
//  - the server side (state.ts): display/state answers only the projector-safe keys, `home` only counts for alerts and
//    only counts for moderators, `announce` is validated, audited and shown on the projector; the long-poll wakes;
//  - the page (display.js): renders a whitelist, so an extra field in a reply can never reach the screen;
//  - end to end on the real admin listener: /display (host PC only) with the strict CSP, display/state without a
//    session, and an announcement made through the API reaching the projector's next answer.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthStore } from '../../server/auth/store';
import { startAdminListener } from '../../server/listeners';
import { fakeFetch, fakeWindow, pageText, parseHtml, settle, type FetchCall } from '../../server/moderation/admin/dom.testutil';
import { DEFAULT_ADMIN_POLICY, HostAdmin, formatSetupCode, newSetupCode, type AdminPolicy } from '../../server/moderation/hostAdmin';
import { ADMIN_PAGE_CSP, ADMIN_PAGE_DIR, createAdminHttp, createAdminSite, type AdminReply, type AdminRouteContext } from '../../server/moderation/http';
import { bootDisplay, displayModel, renderDisplay, roomCounts, roomMode } from './display.js';
import {
  ANNOUNCE_TEXT_MAX, DISPLAY_STATE_KEYS, OPEN_REPORTS_CACHE_MS, OPEN_REPORTS_MAX, createPanelState, displayRoom, phaseLabel, safeRoomName, subModeLabel,
  typeLabel, type PanelStateDeps,
} from './state';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, 'display.html'), 'utf8');
const PASS = 'generated-Test-pass-44kd'; // generated test password (never a real credential)

// Names and words that must never reach the projector.
const NAMES = ['NovaPilot', 'VegaWing', 'HostKid'];
const CHAT = 'did you see that';
const ALERT = 'A wellbeing alert needs your attention';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

// ------------------------------------------------------------------------------------------ deps

function deps(over: Partial<PanelStateDeps> = {}) {
  const announced: { text: string; roomId: string | null }[] = [];
  const audits: { actor: string; reason: string }[] = [];
  let rooms = [
    { id: 'r2', name: 'Flag Run', gameType: 'arena', subMode: 'ctf', phase: 'playing', humans: 7, bots: 1, spectators: 2, maxPlayers: 16, house: true, hostName: 'HostKid' },
    // A player's room, named as the client names it by default (main.ts: `${name}'s ${houseName}`).
    { id: 'r5', name: "NovaPilot's Rift", gameType: 'dungeon', subMode: 'coop', phase: 'lobby', humans: 2, bots: 2, spectators: 0, maxPlayers: 4, house: false, hostName: 'NovaPilot' },
  ];
  const d: PanelStateDeps = {
    serverName: () => 'Room 136',
    join: () => ({ url: 'http://192.168.1.50:7777/', secureUrl: 'https://192.168.1.50:7777/', fingerprint: '3F:9A:C2:11', others: ['http://10.0.0.4:7777/'], notServing: null }),
    rooms: () => rooms,
    pilots: () => [{ roomId: 'r2', roomName: 'Flag Run', accountId: 'acc-1', name: 'NovaPilot' } as never, { roomId: null, roomName: null, accountId: null, name: 'VegaWing' } as never],
    notice: () => 'Chat is filtered and logged. Your teacher can read it. Lines are kept for 90 days.',
    alerts: () => ({ urgent: 1, banner: 2, wellbeing: 1 }),
    classPeriods: () => [{ name: 'P1', start: '08:00', end: '08:50', days: [1, 2, 3, 4, 5] }],
    presentingAtLogin: () => true,
    announce: (text, roomId) => { announced.push({ text, roomId }); return roomId === 'gone' ? { ok: false, error: 'That room no longer exists.' } : { ok: true, delivered: 9, roomId }; },
    audit: (actor, reason) => { audits.push({ actor: actor.name, reason }); },
    ...over,
  };
  return { d, announced, audits, setRooms: (r: typeof rooms) => { rooms = r; } };
}

const ctx = (principal: AdminRouteContext['principal'], signal = new AbortController().signal): AdminRouteContext => ({
  session: null, principal, actor: { accountId: 'host', name: 'hostadmin' }, caller: {} as never, req: {} as never, canContext: {},
  can: () => true, require: () => undefined, service: null, settings: null, hostAdmin: {} as never, signal, now: Date.now,
});
const HOST = { kind: 'host', via: 'local' } as const;
const MOD = { kind: 'moderator', tier: 'limited' } as const;
const statusOf = async (r: AdminReply | Promise<AdminReply>): Promise<number> => { const x = await r; return Array.isArray(x) ? x[0] : 200; };
const json = (reply: unknown): Record<string, unknown> => {
  if (!Array.isArray(reply)) throw new Error('not a JSON reply');
  expect(reply[0]).toBe(200);
  return reply[1] as Record<string, unknown>;
};

// ------------------------------------------------------------------------------------------ state.ts

describe('T-UI-8 (server): display/state carries only the projector-safe fields', () => {
  it('the keys, the rooms without their host player, no names, no chat, no alerts', async () => {
    const { d } = deps();
    const panel = createPanelState(d);
    cleanups.push(() => panel.close());
    const out = json(await panel.handlers['display/state']({}, ctx(null)));
    expect(Object.keys(out).sort()).toEqual(['ok', ...DISPLAY_STATE_KEYS].sort());
    expect(out).toMatchObject({ ok: true, serverName: 'Room 136', joinUrl: 'http://192.168.1.50:7777/', fingerprint: '3F:9A:C2:11', announcement: null });
    const rooms = out.rooms as Record<string, unknown>[];
    // A house room keeps its name; a player's room is "Room N" (its name is a player's words: here, a student's name).
    expect(rooms.map((r) => r.name)).toEqual(['Flag Run', 'Room 5']);
    expect(rooms[1]).toMatchObject({ roomId: 'r5', typeLabel: 'Dungeon Runner', subModeLabel: 'Co-op Descent', phaseLabel: 'Waiting' });
    expect(rooms[0]).toMatchObject({ typeLabel: 'Arena', subModeLabel: 'Capture the Flag', phaseLabel: 'Playing', humans: 7, maxPlayers: 16 });
    expect(Object.keys(rooms[0]!)).not.toContain('hostName');
    const text = JSON.stringify(out);
    for (const n of NAMES) expect(text).not.toContain(n);
    expect(text).not.toContain('10.0.0.4'); // "other addresses" are for the panel only
    expect(text).not.toMatch(/alert|urgent|wellbeing/i);
  });

  it('the long-poll waits for a change and wakes on an announcement', async () => {
    const { d } = deps();
    const panel = createPanelState(d);
    cleanups.push(() => panel.close());
    const first = json(await panel.handlers['display/state']({}, ctx(null)));
    const t0 = Date.now();
    const waiting = panel.handlers['display/state']({ after: first.rev, wait: 10 }, ctx(null));
    await new Promise((r) => setTimeout(r, 30));
    json(await panel.handlers.announce({ text: '  Finish your match  ' }, ctx(HOST)));
    const next = json(await waiting);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(next.rev).toBe((first.rev as number) + 1);
    expect(next.announcement).toMatchObject({ text: 'Finish your match', target: 'All rooms', roomId: null });
    // An old rev answers at once; a client that went away frees its wait.
    expect(json(await panel.handlers['display/state']({ after: 0 }, ctx(null))).rev).toBe(next.rev);
    const ac = new AbortController();
    const gone = panel.handlers['display/state']({ after: next.rev, wait: 25 }, ctx(null, ac.signal));
    ac.abort();
    expect(json(await gone).rev).toBe(next.rev);
    expect(await statusOf(panel.handlers['display/state']({ after: -1 }, ctx(null)))).toBe(400);
    expect(await statusOf(panel.handlers['display/state']({ after: 1, wait: 99 }, ctx(null)))).toBe(400);
  });

  it('a change in the rooms is noticed by a waiting projector', async () => {
    const { d, setRooms } = deps();
    const panel = createPanelState(d);
    cleanups.push(() => panel.close());
    const first = json(await panel.handlers['display/state']({}, ctx(null)));
    const waiting = panel.handlers['display/state']({ after: first.rev, wait: 10 }, ctx(null));
    setRooms([]);
    const next = json(await waiting);
    expect(next.rooms).toEqual([]);
    expect(next.rev).toBe((first.rev as number) + 1);
  });
});

describe('home and announce (state.ts)', () => {
  it('home: the host gets the Join card, rooms, counts and alert COUNTS — no names; a moderator counts only', () => {
    const { d } = deps();
    const panel = createPanelState(d);
    const host = json(panel.handlers.home({}, ctx(HOST)));
    expect(host).toMatchObject({
      ok: true, serverName: 'Room 136', online: { total: 2, accounts: 1, guests: 1 }, alerts: { urgent: 1, banner: 2, wellbeing: 1 },
      counts: { online: 2, rooms: 2, playing: 1 }, presentingAtLogin: true, classPeriods: [{ name: 'P1', start: '08:00', end: '08:50', days: [1, 2, 3, 4, 5] }],
    });
    expect((host.join as Record<string, unknown>).others).toEqual(['http://10.0.0.4:7777/']);
    const text = JSON.stringify(host);
    for (const n of NAMES) expect(text).not.toContain(n);
    expect((host.rooms as Record<string, unknown>[]).map((r) => r.name)).toEqual(['Flag Run', 'Room 5']);
    const mod = json(panel.handlers.home({}, ctx(MOD)));
    // Counts only, plus the Presenting default (School: on at every sign-in, a moderator's too).
    expect(mod).toEqual({ ok: true, counts: { online: 2, rooms: 2, playing: 1 }, presentingAtLogin: true });
    expect(json(createPanelState(deps({ presentingAtLogin: () => false }).d).handlers.home({}, ctx(MOD))).presentingAtLogin).toBe(false);
    expect(json(createPanelState(deps({ presentingAtLogin: () => { throw new Error('boom'); } }).d).handlers.home({}, ctx(MOD))).presentingAtLogin).toBe(false);
  });

  it('home: the open-report count for the Reports badge (host and moderator; a count, never who)', () => {
    const { d } = deps({ openReports: () => ({ open: 4, more: false }) });
    const panel = createPanelState(d);
    expect(json(panel.handlers.home({}, ctx(HOST))).openReports).toEqual({ open: 4, more: false });
    expect(json(panel.handlers.home({}, ctx(MOD)))).toEqual({ ok: true, counts: { online: 2, rooms: 2, playing: 1 }, openReports: { open: 4, more: false }, presentingAtLogin: true });
    // Without `reports` (no badge), no count.
    const noReports = { ...ctx(MOD), can: (cap: string) => cap !== 'reports' } as AdminRouteContext;
    expect(json(panel.handlers.home({}, noReports))).not.toHaveProperty('openReports');
    // Default: the route's moderation service (capped at OPEN_REPORTS_MAX, "more" beyond).
    const asked: unknown[][] = [];
    const svc = {
      listReports: (...a: unknown[]) => { asked.push(a); return { reports: [{ id: 9, target: { name: 'NovaPilot' } }, { id: 8, target: { name: 'VegaWing' } }], nextBefore: 8 }; },
      alertsList: () => [],
    };
    const p2 = createPanelState(deps().d);
    const out = json(p2.handlers.home({}, { ...ctx(MOD), service: svc as never }));
    expect(out.openReports).toEqual({ open: 2, more: true });
    expect(asked).toEqual([['open', OPEN_REPORTS_MAX]]);
    expect(JSON.stringify(out)).not.toMatch(/NovaPilot|VegaWing/);
    // A number from the dependency; a broken one leaves the badge alone.
    expect(json(createPanelState(deps({ openReports: () => 3 }).d).handlers.home({}, ctx(HOST))).openReports).toEqual({ open: 3, more: false });
    expect(json(createPanelState(deps({ openReports: () => { throw new Error('boom'); } }).d).handlers.home({}, ctx(HOST)))).not.toHaveProperty('openReports');
  });

  it('home: the wellbeing alerts split by level (a banner-level one must not hide an urgent threat)', () => {
    // From the counts, when they carry the split.
    const a = createPanelState(deps({ alerts: () => ({ urgent: 1, banner: 1, wellbeing: 1, wellbeingUrgent: 0, wellbeingBanner: 1 }) }).d);
    expect(json(a.handlers.home({}, ctx(HOST))).alerts).toEqual({ urgent: 1, banner: 1, wellbeing: 1, wellbeingUrgent: 0, wellbeingBanner: 1 });
    // Else from the service's open alert list (acknowledged ones left out).
    const svc = {
      alertsList: () => [
        { kind: 'wellbeing', level: 'banner', acked: false }, { kind: 'threat', level: 'urgent', acked: false }, { kind: 'wellbeing', level: 'urgent', acked: true },
      ],
      listReports: () => ({ reports: [], nextBefore: null }),
    };
    const b = createPanelState(deps({ alerts: () => ({ urgent: 1, banner: 1, wellbeing: 1 }) }).d);
    expect(json(b.handlers.home({}, { ...ctx(HOST), service: svc as never })).alerts).toEqual({ urgent: 1, banner: 1, wellbeing: 1, wellbeingUrgent: 0, wellbeingBanner: 1 });
    // No wellbeing alert: the split is known (0 / 0). Unknown (no split, no service): left out, and the page shows totals.
    expect(json(createPanelState(deps({ alerts: () => ({ urgent: 2, banner: 0, wellbeing: 0 }) }).d).handlers.home({}, ctx(HOST))).alerts)
      .toEqual({ urgent: 2, banner: 0, wellbeing: 0, wellbeingUrgent: 0, wellbeingBanner: 0 });
    expect(json(createPanelState(deps().d).handlers.home({}, ctx(HOST))).alerts).toEqual({ urgent: 1, banner: 2, wellbeing: 1 });
  });

  it('announce: validated, sent through the Zone, audited, and shown on the projector', async () => {
    const { d, announced, audits } = deps();
    const panel = createPanelState(d);
    expect(json(panel.handlers.announce({ text: 'Server restarting soon', roomId: 'r2' }, ctx(HOST)))).toEqual({ ok: true, delivered: 9, roomId: 'r2' });
    expect(announced).toEqual([{ text: 'Server restarting soon', roomId: 'r2' }]);
    expect(audits).toEqual([{ actor: 'hostadmin', reason: 'announcement to Flag Run: Server restarting soon' }]);
    expect(panel.displayState().announcement).toMatchObject({ text: 'Server restarting soon', target: 'Flag Run', roomId: 'r2' });
    for (const bad of [{}, { text: '   ' }, { text: 'x'.repeat(ANNOUNCE_TEXT_MAX + 1) }, { text: 'hi', roomId: '../r1' }, { text: 'hi', roomId: 7 }]) {
      expect(await statusOf(panel.handlers.announce(bad, ctx(HOST)))).toBe(400);
    }
    expect(panel.handlers.announce({ text: 'hi', roomId: 'gone' }, ctx(HOST))).toEqual([400, { error: 'That room no longer exists.' }]);
    expect(audits).toHaveLength(1); // a refused announcement writes no audit row
    const none = createPanelState({ serverName: () => 'x', join: () => null });
    expect(await statusOf(none.handlers.announce({ text: 'hi' }, ctx(HOST)))).toBe(503);
  });

  it("a room's projector-safe name: a house room's own, else Room N from its id (never a player-chosen name)", () => {
    expect(safeRoomName({ id: 'r2', name: 'Flag Run', house: true })).toBe('Flag Run');
    expect(safeRoomName({ id: 'r12', name: "NovaPilot's Arena", house: false })).toBe('Room 12');
    expect(safeRoomName({ id: 'r7', name: "NovaPilot's Arena" })).toBe('Room 7');
    expect(safeRoomName({ id: 'odd-id', name: 'VegaWing rules' })).toBe('Room');
    expect(safeRoomName({ id: 'r3', name: '', house: true })).toBe('Room');
    // The announcement target on the projector is the safe name too.
    const { d } = deps();
    const panel = createPanelState(d);
    json(panel.handlers.announce({ text: 'Finish your match', roomId: 'r5' }, ctx(HOST)));
    expect(panel.displayState().announcement).toMatchObject({ target: 'Room 5', roomId: 'r5' });
    expect(JSON.stringify(panel.displayState())).not.toContain('NovaPilot');
  });

  it("the open-report fallback reads the service's report list at most once per OPEN_REPORTS_CACHE_MS (§5.16)", () => {
    let t = 1_000_000;
    let asked = 0;
    let open = 2;
    const svc = {
      listReports: () => { asked++; return { reports: Array.from({ length: open }, (_, i) => ({ id: i + 1 })), nextBefore: null }; },
      alertsList: () => [],
    };
    const panel = createPanelState({ ...deps().d, now: () => t });
    const home = () => json(panel.handlers.home({}, { ...ctx(HOST), service: svc as never })).openReports;
    // Five Home tabs polling every 5 s, and a moderator badge: one list read per window.
    for (let i = 0; i < 6; i++) expect(home()).toEqual({ open: 2, more: false });
    expect(asked).toBe(1);
    open = 3;
    t += OPEN_REPORTS_CACHE_MS - 1;
    expect(home()).toEqual({ open: 2, more: false });
    expect(asked).toBe(1);
    t += 1;
    expect(home()).toEqual({ open: 3, more: false });
    expect(asked).toBe(2);
    // A different service (a test harness, a restart) is never served another's count.
    const other = { listReports: () => ({ reports: [], nextBefore: null }), alertsList: () => [] };
    expect(json(panel.handlers.home({}, { ...ctx(HOST), service: other as never })).openReports).toEqual({ open: 0, more: false });
  });

  it('labels, the room row, and a broken dependency degrades to empty values', async () => {
    expect(typeLabel('warzone')).toBe('Warzone');
    expect(subModeLabel('warzone', 'deathmatch')).toBe('Classic');
    expect(subModeLabel('arena', 'deathmatch')).toBe('Deathmatch');
    expect(phaseLabel('countdown')).toBe('Starting');
    expect(typeLabel('constructor')).toBe('');
    expect(displayRoom({ id: 'r1', name: 'x'.repeat(99), humans: -3, house: true })).toMatchObject({ name: 'x'.repeat(48), humans: 0 });
    expect(displayRoom({ id: 'r1', name: 'x'.repeat(99), humans: -3 })).toMatchObject({ name: 'Room 1', humans: 0 });
    const logs: string[] = [];
    const panel = createPanelState({ serverName: () => { throw new Error('boom'); }, join: () => { throw new Error('boom'); }, rooms: () => { throw new Error('boom'); }, log: (l) => logs.push(l) });
    const out = json(await panel.handlers['display/state']({}, ctx(null)));
    expect(out).toMatchObject({ serverName: 'Voidswarm', joinUrl: null, rooms: [] });
    expect(logs.length).toBeGreaterThan(0);
    // Without a room list, rooms come from the pilots: "Room N" (a pilot can't say which is a house room) and head
    // counts, never who.
    const p2 = createPanelState({ serverName: () => 'x', join: () => null, pilots: () => [{ roomId: 'r1', roomName: "NovaPilot's Duel" }, { roomId: 'r1', roomName: "NovaPilot's Duel" }, { roomId: null }] });
    expect(p2.displayState().rooms).toEqual([expect.objectContaining({ roomId: 'r1', name: 'Room 1', humans: 2 })]);
    expect(JSON.stringify(p2.displayState())).not.toContain('NovaPilot');
    // A URL that is not http(s) never reaches the Join card.
    const p3 = createPanelState({ serverName: () => 'x', join: () => ({ url: 'javascript:alert(1)', fingerprint: '<b>' }) });
    expect(p3.displayState()).toMatchObject({ joinUrl: null, fingerprint: null });
  });
});

// ------------------------------------------------------------------------------------------ display.js

describe('T-UI-8 (page): the projector renders a whitelist', () => {
  const hostile = {
    ok: true, rev: 4, serverName: 'Room 136', joinUrl: 'http://192.168.1.50:7777/', secureUrl: '', fingerprint: '3F:9A', notServing: '',
    rooms: [{ name: 'Flag Run', typeLabel: 'Arena', subModeLabel: 'Capture the Flag', phase: 'playing', phaseLabel: 'Playing', humans: 7, spectators: 2, maxPlayers: 16, hostName: 'HostKid', players: ['NovaPilot'] }],
    announcement: { text: 'Finish your match', target: 'All rooms', at: Date.now(), by: 'VegaWing' },
    notice: 'Chat is filtered and logged.',
    // None of these may ever reach the screen:
    lines: [{ name: 'NovaPilot', shown: CHAT }], alerts: [{ text: ALERT, name: 'NovaPilot' }], online: [{ name: 'VegaWing' }], chat: CHAT,
  };

  it('displayModel keeps only the projector fields', () => {
    const m = displayModel(hostile);
    expect(Object.keys(m).sort()).toEqual(['announcement', 'fingerprint', 'joinUrl', 'notServing', 'notice', 'rev', 'rooms', 'secureUrl', 'serverName']);
    expect(Object.keys(m.rooms[0]!).sort()).toEqual(['house', 'humans', 'maxPlayers', 'name', 'phase', 'phaseLabel', 'spectators', 'subModeLabel', 'typeLabel']);
    expect(m.announcement).toEqual({ text: 'Finish your match', target: 'All rooms', at: hostile.announcement.at });
    expect(roomMode(m.rooms[0]!)).toBe('Arena · Capture the Flag');
    expect(roomCounts(m.rooms[0]!)).toBe('7 / 16 · 2 watching');
  });

  it('the page shows the URL, rooms, announcement and notice — never chat, names or alerts', () => {
    const doc = parseHtml(html);
    renderDisplay(doc, displayModel(hostile));
    const text = pageText(doc);
    expect(text).toContain('http://192.168.1.50:7777/');
    expect(text).toContain('Flag Run');
    expect(text).toContain('Finish your match');
    expect(text).toContain('Chat is filtered and logged.');
    expect(text).toContain('3F:9A');
    for (const n of NAMES) expect(text).not.toContain(n);
    expect(text).not.toContain(CHAT);
    expect(text).not.toContain(ALERT);
    expect(doc.getElementById('d-announce')!.hidden).toBe(false);
  });

  it('boots, long-polls with the last rev, re-renders on a change, and stops', async () => {
    const doc = parseHtml(html);
    let release: ((v: { body: unknown }) => void) | null = null;
    const f = fakeFetch({
      'display/state': (c: FetchCall) => ('after' in c.body
        ? new Promise((r) => { release = r as never; })
        : { body: { ...hostile, rev: 1, announcement: null } }),
    });
    const win = fakeWindow({ fetch: f.fn as never });
    const d = bootDisplay({ doc, win });
    await settle();
    expect(doc.getElementById('d-name')!.textContent).toBe('Room 136');
    expect(doc.getElementById('d-announce')!.hidden).toBe(true);
    expect(f.calls.map((c) => c.body)).toEqual([{}, { after: 1, wait: 25 }]);
    expect(f.calls[0]!.url).toBe('/api/admin/display/state');
    expect(f.calls[0]!.headers['Content-Type']).toBe('application/json');
    release!({ body: { ...hostile, rev: 2 } });
    await settle();
    expect(doc.getElementById('d-announce')!.hidden).toBe(false);
    expect(doc.getElementById('d-announce-text')!.textContent).toBe('Finish your match');
    expect(f.calls.at(-1)!.body).toEqual({ after: 2, wait: 25 });
    d.stop();
    await settle();
    for (const n of NAMES) expect(pageText(doc)).not.toContain(n);
  });
});

// ------------------------------------------------------------------------------------------ end to end

interface Reply { status: number; headers: IncomingHttpHeaders; text: string; json: Record<string, unknown> }
function call(o: { port: number; path: string; method?: string; body?: unknown; token?: string; connect?: string; host?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
    const host = o.host ?? `localhost:${o.port}`;
    const headers: Record<string, string> = { Host: host };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
      headers.Origin = `http://${host}`;
    }
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    const req = httpRequest({ host: o.connect ?? '127.0.0.1', port: o.port, path: o.path, method: o.method ?? (payload ? 'POST' : 'GET'), headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let j: Record<string, unknown> = {};
        try { j = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: j });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
async function canBind(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.once('error', () => resolve(false));
    s.listen(0, address, () => s.close(() => resolve(true)));
  });
}

describe('end to end on the admin listener', () => {
  it('/display is the projector page (host PC only, strict CSP); display/state needs no session; announce reaches it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'voidswarm-display-e2e-'));
    const dbPath = path.join(dir, 'voidswarm.db');
    new AuthStore(dbPath).close();
    const policy: AdminPolicy = { ...DEFAULT_ADMIN_POLICY, remoteAccess: 'limited' };
    const ha = new HostAdmin({ dbPath, policy: () => policy, passwordParams: { N: 1 << 10, r: 8, p: 1, keylen: 32 }, pepper: randomBytes(32) });
    const { d, announced } = deps();
    const panel = createPanelState(d);
    const api = createAdminHttp({ service: null, trustProxy: false, log: () => undefined, hostAdmin: ha, policy: () => policy, handlers: panel.handlers });
    const lanOk = await canBind('127.0.0.2');
    const listener = await startAdminListener({
      port: 0, policy: () => ({ remoteAccess: policy.remoteAccess, devicesTrustCert: false }), loopback: ['127.0.0.1'],
      handle: createAdminSite({ api, pageDir: ADMIN_PAGE_DIR, displayDir: here }),
      lan: lanOk ? { address: '127.0.0.2', tls: null } : null,
    });
    cleanups.push(async () => {
      panel.close();
      await listener.close();
      ha.close();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the WAL briefly */ }
    });
    const port = listener.port;

    const page = await call({ port, path: '/display' });
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toBe(ADMIN_PAGE_CSP);
    expect(page.text).toBe(html);
    for (const f of ['/display/display.js', '/display/display.css', '/admin/admin.js']) {
      const r = await call({ port, path: f });
      expect(r.status, f).toBe(200);
    }
    for (const f of ['/admin/qrcode.js', '/admin/qr.js']) expect((await call({ port, path: f })).status, f).toBe(404); // no QR (owner decision 7)
    expect((await call({ port, path: '/display/state.ts' })).status).toBe(404); // server code is not served
    if (lanOk) expect((await call({ port, path: '/display', connect: '127.0.0.2', host: `127.0.0.2:${port}` })).status).toBe(403);

    const st = await call({ port, path: '/api/admin/display/state', body: {} });
    expect(st.status).toBe(200);
    expect(Object.keys(st.json).sort()).toEqual(['ok', ...DISPLAY_STATE_KEYS].sort());
    for (const n of NAMES) expect(st.text).not.toContain(n);
    if (lanOk) expect((await call({ port, path: '/api/admin/display/state', body: {}, connect: '127.0.0.2', host: `127.0.0.2:${port}` })).status).toBe(403);

    // A host session (setup with a launcher code), then an announcement from the panel.
    const code = newSetupCode();
    ha.installLaunchCode(code);
    const setup = await call({ port, path: '/api/admin/setup', body: { setupCode: formatSetupCode(code), username: 'hostadmin', password: PASS, preset: 'home', serverName: 'Den', accountsMode: 'email' } });
    expect(setup.status, setup.text).toBe(200);
    const token = setup.json.token as string;
    const home = await call({ port, path: '/api/admin/home', body: {}, token });
    expect(home.status).toBe(200);
    expect(home.json).toMatchObject({ ok: true, join: { url: 'http://192.168.1.50:7777/' }, alerts: { urgent: 1, banner: 2, wellbeing: 1 } });
    for (const n of NAMES) expect(home.text).not.toContain(n);
    const waiting = call({ port, path: '/api/admin/display/state', body: { after: st.json.rev, wait: 10 } });
    await new Promise((r) => setTimeout(r, 50));
    const ann = await call({ port, path: '/api/admin/announce', body: { text: '5 minutes left' }, token });
    expect(ann.status, ann.text).toBe(200);
    expect(ann.json).toEqual({ ok: true, delivered: 9, roomId: null });
    expect(announced).toEqual([{ text: '5 minutes left', roomId: null }]);
    const woke = await waiting;
    expect(woke.json.announcement).toMatchObject({ text: '5 minutes left', target: 'All rooms' });
    // Without a session the announcement is refused.
    expect((await call({ port, path: '/api/admin/announce', body: { text: 'x' } })).status).toBe(401);
  });
});
