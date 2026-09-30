// Moderation seam of the Zone / Room (room/moderation.ts): the word filter on every human chat line (zone + room,
// all + team; offline too), refused names, the repeat-flood check, and the optional host hook (chat log, mutes,
// strikes, moderator commands that never leak, /report). The filter is mocked with fixed rules so these tests pin
// the Zone's behaviour, not the word lists (the real filter is exercised by the server integration test).
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../sim/Sim', () => ({ Sim: class { constructor() { throw new Error('no sim in moderation.test'); } } }));
vi.mock('../ai/bots', () => ({ createBotBrain: () => ({ think: () => ({}), chooseUpgrade: () => 0 }) }));

const filterState = vi.hoisted(() => ({ throwOnChat: false, lastOpts: [] as unknown[] }));
vi.mock('../moderation/filter', () => ({
  filterChat: (text: string, opts?: unknown) => {
    filterState.lastOpts.push(opts);
    if (filterState.throwOnChat) throw new Error('boom');
    // host custom GANG terms: 'grimtag' confirmed (block), 'vexmark' unconfirmed (compiled as review-only 'flag')
    if (/grimtag/i.test(text)) return { text: '', action: 'block', hits: [{ term: 'grimtag', tier: 'block', category: 'gang', source: 'custom' }] };
    if (/vexmark/i.test(text)) return { text, action: 'flag', hits: [{ term: 'vexmark', tier: 'flag', category: 'gang', source: 'custom' }] };
    if (/mixedword/i.test(text)) {
      return { text: '', action: 'block', hits: [{ term: 'mixedword', tier: 'block', category: 'slur' }, { term: 'sadword', tier: 'block', category: 'selfharm' }] };
    }
    if (/sadword/i.test(text)) return { text: '', action: 'block', hits: [{ term: 'sadword', tier: 'block', category: 'selfharm' }] };
    // an unconfirmed (review-only) custom self-harm term, e.g. from an imported district wellbeing list
    if (/glumword/i.test(text) && /badword/i.test(text)) {
      return { text: '', action: 'block', hits: [{ term: 'badword', tier: 'block', category: 'slur' }, { term: 'glumword', tier: 'flag', category: 'selfharm', source: 'custom' }] };
    }
    if (/glumword/i.test(text)) return { text, action: 'flag', hits: [{ term: 'glumword', tier: 'flag', category: 'selfharm', source: 'custom' }] };
    if (/threatword/i.test(text)) return { text: '', action: 'block', hits: [{ term: 'threatword', tier: 'block', category: 'threat' }] };
    if (/badword/i.test(text)) return { text: '', action: 'block', hits: ['test:block'] };
    if (/darn/i.test(text)) return { text: text.replace(/darn/gi, '****'), action: 'mask', hits: ['test:mask'] };
    // a host's review-only custom term: shown as typed, reported with tier 'flag'
    if (/zorblax/i.test(text)) return { text, action: 'flag', hits: [{ term: 'zorblax', tier: 'flag', category: 'crew', source: 'custom' }] };
    return { text, action: 'pass', hits: [] };
  },
  // 'badword' in a name is a block-tier hit (a strike); 'darn' only profanity (refused, logged, but no strike);
  // 'zorblax' a review-only custom term (allowed, logged as 'flag')
  checkName: (name: string) => (/badword/i.test(name)
    ? { ok: false, reason: 'test:name', hits: [{ term: 'badword', tier: 'block', category: 'slur' }] }
    // a self-harm term in a name (block tier, like the built-in list); 'mixedword' adds a slur next to it
    : /mixedword/i.test(name) ? { ok: false, reason: 'test:name', hits: [{ term: 'mixedword', tier: 'block', category: 'slur' }, { term: 'sadword', tier: 'block', category: 'selfharm' }] }
    : /sadword/i.test(name) ? { ok: false, reason: 'test:name', hits: [{ term: 'sadword', tier: 'block', category: 'selfharm' }] }
    // an unconfirmed custom self-harm term: the name is allowed (review-only)
    : /glumword/i.test(name) ? { ok: true, action: 'flag', hits: [{ term: 'glumword', tier: 'flag', category: 'selfharm', source: 'custom' }] }
    // a custom mask term refuses the name; a review-only term in the same name is reported next to it
    : /quenth/i.test(name) ? { ok: false, reason: 'test:name', hits: [{ term: 'quenth', tier: 'mask', category: 'crew', source: 'custom' },
      ...(/zorblax/i.test(name) ? [{ term: 'zorblax', tier: 'flag', category: 'watch', source: 'custom' }] : [])] }
    : /darn/i.test(name) ? { ok: false, reason: 'test:name', hits: [{ term: 'darn', tier: 'mask', category: 'profanity' }] }
      : /zorblax/i.test(name) ? { ok: true, action: 'flag', hits: [{ term: 'zorblax', tier: 'flag', category: 'crew', source: 'custom' }] }
        : { ok: true }),
  // Third identical line within the recent window is spam.
  isSpam: (recent: { text: string; time: number }[], text: string) => recent.filter((r) => r.text === text).length >= 2,
  tameText: (text: string) => text.replace(/!{4,}/g, '!!!'),
}));

import { NO_TEAM } from '../constants';
import type { AccountInfo, ChatChannel, ClientMsg, ServerMsg } from '../protocol';
import type { Snapshot } from '../types';
import { PROTOCOL_VERSION } from '../version';
import {
  ANNOUNCE_MAX_LEN, DEFAULT_POSITIVE_LINES, MSG_BLOCKED, MSG_CARE, MSG_CARE_NAME, MSG_NAME_REFUSED, MSG_NAME_RESERVED, MSG_NOT_SENT,
  MSG_REPORT_OFFLINE, MSG_REPORT_USAGE, MSG_ROOM_NAME_REFUSED, MSG_SPAM, MSG_WARN_AGAIN, MSG_WARN_FIRST, MSG_WARN_LAST,
  MSG_WARN_MUTED, MSG_WARN_SECOND,
  isReservedCallsign,
  type ChatLogEntry, type ModerationHook, type ModUser, type StrikeDetail, type ZoneChatOptions,
} from './moderation';
import { Zone, type ClientSink, type ZoneConnection } from './Zone';

class FakeClient implements ClientSink {
  msgs: ServerMsg[] = [];
  conn!: ZoneConnection;
  closedReason: string | null = null;
  close(reason: string): void { this.closedReason = reason; }
  sendMsg(m: ServerMsg): void { this.msgs.push(m); }
  sendSnapshot(_s: Snapshot): void { /* no sim */ }
  send(m: ClientMsg): void { this.conn.handle(m); }
  of<T extends ServerMsg['type']>(t: T): Extract<ServerMsg, { type: T }>[] { return this.msgs.filter((m) => m.type === t) as Extract<ServerMsg, { type: T }>[]; }
  last<T extends ServerMsg['type']>(t: T): Extract<ServerMsg, { type: T }> { const a = this.of(t); return a[a.length - 1]!; }
  chatTexts(): string[] { return this.of('chat').map((c) => c.line.text); }
  systemTexts(): string[] { return this.of('chat').filter((c) => c.line.channel === 'system').map((c) => c.line.text); }
  said(text: string): boolean { return this.of('chat').some((c) => c.line.channel !== 'system' && c.line.text === text); }
  get pid(): number { return this.last('welcome').playerId; }
  get name(): string { return this.last('welcome').name; }
}

const acct = (username: string, id = `acc-${username}`): AccountInfo => ({ accountId: id, username, emailMasked: 'x***@y.z', createdAt: 1 });

interface FakeHook extends ModerationHook {
  entries: ChatLogEntry[];
  strikes: [ModUser, string][];
  /** v0.6: the StrikeDetail of each strike (tags, action) */
  strikeDetails: (StrikeDetail | undefined)[];
  admin: Set<string>;
  commands: [string, string[]][];
  reports: [string, string, string, string][];
  muted: Map<number, { until: number | null; reason: string }>;
  strikeNotice: string | null;
  asyncReply: boolean;
  alerts: [string, string][];
  /** v0.6: the log entry handed to each alert */
  alertEntries: (ChatLogEntry | undefined)[];
}

/**
 * `limit` > 0 adds ModerationHook.strikeStatus like the v0.6 server: every strike counts (per pilot); at the limit the
 * pilot is muted and onStrike answers with the auto-mute notice (and nothing below it).
 */
function fakeHook(opts: { limit?: number } = {}): FakeHook {
  const limit = opts.limit ?? 0;
  const count = (u: ModUser): number => h.strikes.filter(([s, r]) => s.playerId === u.playerId && r !== 'selfharm').length;
  const h: FakeHook = {
    entries: [], strikes: [], strikeDetails: [], admin: new Set(), commands: [], reports: [], muted: new Map(), strikeNotice: null,
    asyncReply: false, alerts: [], alertEntries: [],
    logChat: (e) => { h.entries.push(e); },
    isMuted: (u) => h.muted.get(u.playerId) ?? null,
    onStrike: (u, r, d) => {
      h.strikes.push([u, r]);
      h.strikeDetails.push(d);
      if (limit > 0 && count(u) >= limit) {
        h.muted.set(u.playerId, { until: null, reason: 'auto' });
        return 'You are muted for 10 minutes (repeated blocked language).';
      }
      return limit > 0 ? null : h.strikeNotice;
    },
    isAdmin: (u) => !!u.accountId && h.admin.has(u.accountId),
    adminCommand: (u, cmd, args) => {
      h.commands.push([cmd, args]);
      const lines = [`did ${cmd} ${args.join(' ')} for ${u.name}`];
      return h.asyncReply ? Promise.resolve(lines) : lines;
    },
    report: (u, target, reason, ctx) => { h.reports.push([u.name, target, reason, ctx.roomName]); return ['Report sent — thank you.']; },
    alert: (u, kind, entry) => { h.alerts.push([u.name, kind]); h.alertEntries.push(entry); },
  };
  if (limit > 0) h.strikeStatus = (u) => ({ count: count(u), limit });
  return h;
}

function mkZone(opts: {
  local?: boolean; hook?: ModerationHook; chatFilter?: 'strict' | 'standard'; chat?: Partial<ZoneChatOptions>; log?: (l: string) => void;
} = {}): Zone {
  return new Zone({
    snapshotEvery: 3, motd: 'hi', local: opts.local ?? false, moderation: opts.hook, chatFilter: opts.chatFilter, chat: opts.chat,
    defaultRooms: [{ name: 'Main Arena', mode: 'teams', teamCount: 2, botFill: 0 }], log: opts.log,
  });
}

/** v0.5 behaviour (substitution off) — the old assertions run under it. */
const MASKED: Partial<ZoneChatOptions> = { substitute: 'masked' };

function join(zone: Zone, name: string, account: AccountInfo | null = null, address: string | null = '10.0.0.1'): FakeClient {
  const c = new FakeClient();
  c.conn = zone.connect(c);
  c.conn.setAccount(account);
  c.conn.setAddress(address);
  c.send({ type: 'hello', name, protocol: PROTOCOL_VERSION, version: 'test', token: account ? 'tok' : undefined });
  return c;
}

const chat = (c: FakeClient, text: string, channel: 'all' | 'team' = 'all'): void => c.send({ type: 'chat', channel, text });

/** A generated guest callsign: Pilot + 4 digits (Rng draw), or 5+ when a taken draw was settled with a digit suffix. */
const GENERATED = /^Pilot\d{4,}$/;

function joinMainRoom(zone: Zone, c: FakeClient): void {
  const id = c.last('roomList').rooms.find((r) => r.name === 'Main Arena')!.id;
  c.send({ type: 'joinRoom', roomId: id });
}

// allowChat: 5 lines / 5 s per pilot — tests that send many lines advance the clock.
afterEach(() => { vi.useRealTimers(); filterState.throwOnChat = false; filterState.lastOpts = []; });
function spaced(): void { vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] }); }
const tick = (ms = 1100): void => { vi.setSystemTime(Date.now() + ms); };

describe('word filter on chat (no hook: offline / filter only)', () => {
  it("substitution off ('masked', v0.5): zone lobby pass is broadcast, block is withheld with a private notice, mask is starred for everyone", () => {
    for (const local of [true, false]) {
      const zone = mkZone({ local, chat: MASKED });
      const a = join(zone, 'Ace');
      const b = local ? a : join(zone, 'Bee');
      chat(a, 'hello there');
      expect(b.said('hello there')).toBe(true);
      chat(a, 'you badword');
      expect(a.systemTexts()).toContain(MSG_BLOCKED);
      expect(b.of('chat').some((c) => c.line.text.includes('badword'))).toBe(false);
      chat(a, 'oh darn it');
      expect(b.said('oh **** it')).toBe(true);
      expect(b.of('chat').some((c) => c.line.text.includes('darn'))).toBe(false);
      // history keeps only what was shown
      const c2 = join(zone, 'Cee');
      expect(c2.last('chatHistory').lines.map((l) => l.text)).not.toContain('you badword');
    }
  });

  it("substitution off ('masked'): room chat (all + team, and the // prefix): blocked lines never reach anyone, masked lines are starred", () => {
    const zone = mkZone({ local: false, chat: MASKED });
    const a = join(zone, 'Ace');
    const b = join(zone, 'Bee');
    joinMainRoom(zone, a);
    joinMainRoom(zone, b);
    a.send({ type: 'setTeam', team: 0 });
    b.send({ type: 'setTeam', team: 0 });
    chat(a, 'badword team', 'team');
    chat(a, '//badword again');
    chat(a, 'darn room');
    expect(b.of('chat').some((c) => /badword/.test(c.line.text))).toBe(false);
    expect(a.systemTexts().filter((t) => t === MSG_BLOCKED)).toHaveLength(2);
    expect(b.said('**** room')).toBe(true);
    chat(a, 'darn team', 'team');
    const line = b.of('chat').find((c) => c.line.text === '**** team');
    expect(line?.line.channel).toBe('team');
  });

  it('a throwing filter fails closed (the line is not shown, nothing stands in for it, no strike)', () => {
    for (const substitute of ['sender', 'masked'] as const) {
      const h = fakeHook();
      const zone = mkZone({ hook: h, chat: { substitute } });
      const a = join(zone, 'Ace');
      const b = join(zone, 'Bee');
      const n = b.of('chat').length;
      filterState.throwOnChat = true;
      chat(a, 'perfectly fine');
      filterState.throwOnChat = false;
      expect(b.of('chat').length).toBe(n);
      expect(a.systemTexts().at(-1)).toBe(MSG_NOT_SENT);
      expect(h.strikes).toEqual([]);
      expect(h.entries.at(-1)).toMatchObject({ action: 'block', shown: '', display: 'hidden', hits: ['filter-error'] });
    }
  });

  it('repeat flood: the third identical line is dropped with a notice', () => {
    spaced();
    const zone = mkZone();
    const a = join(zone, 'Ace');
    const b = join(zone, 'Bee');
    chat(a, 'gg'); tick();
    chat(a, 'gg'); tick();
    chat(a, 'gg');
    expect(b.of('chat').filter((c) => c.line.text === 'gg')).toHaveLength(2);
    expect(a.systemTexts()).toContain(MSG_SPAM);
    tick(61_000); // out of the recent window
    chat(a, 'gg');
    expect(b.of('chat').filter((c) => c.line.text === 'gg')).toHaveLength(3);
  });

  it('refused names: guest hello → generated callsign; setName / /name → refused; room names → refused', () => {
    const zone = mkZone();
    const g = join(zone, 'xxBadWordxx');
    expect(g.name).toMatch(GENERATED);
    expect(g.systemTexts().some((t) => t.includes("isn't allowed") && t.includes(g.name))).toBe(true);
    const before = g.name;
    g.send({ type: 'setName', name: 'badword2' });
    expect(g.last('error').message).toBe(MSG_NAME_REFUSED);
    expect(g.name).toBe(before);
    chat(g, '/name badword3');
    expect(g.systemTexts()).toContain(MSG_NAME_REFUSED);
    g.send({ type: 'setName', name: 'Nice' });
    expect(g.name).toBe('Nice');
    // createRoom with a refused name: error, no room
    const rooms = g.last('roomList').rooms.length;
    g.send({ type: 'createRoom', settings: { name: 'badword room' } });
    expect(g.last('error').message).toBe(MSG_ROOM_NAME_REFUSED);
    g.send({ type: 'listRooms' });
    expect(g.last('roomList').rooms.length).toBe(rooms);
    // a host renaming its room: the name is dropped, the rest of the patch applies
    g.send({ type: 'createRoom', settings: { name: 'Fine Room', botFill: 0 } });
    expect(g.last('roomState').settings.name).toBe('Fine Room');
    g.send({ type: 'updateSettings', settings: { name: 'badword town', botFill: 3 } });
    const rs = g.last('roomState');
    expect(rs.settings.name).toBe('Fine Room');
    expect(rs.settings.botFill).toBe(3);
    expect(g.systemTexts()).toContain(MSG_ROOM_NAME_REFUSED);
    // account usernames are never replaced
    const acc = join(zone, 'ignored', acct('Maverick'));
    expect(acc.name).toBe('Maverick');
  });

  it('offline: /report explains it needs a server; moderator commands are just unknown', () => {
    const zone = mkZone({ local: true });
    const a = join(zone, 'Ace');
    chat(a, '/report Bot1 cheating');
    expect(a.systemTexts()).toContain(MSG_REPORT_OFFLINE);
    chat(a, '/ban Bot1 1d x');
    expect(a.systemTexts()).toContain('Unknown command /ban — try /help');
  });
});

describe('moderation hook', () => {
  it('logs every human line (zone + room) with who / where / what the others saw (display, roomUid)', () => {
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    const a = join(zone, 'Ace', acct('Ace'), '203.0.113.7');
    const b = join(zone, 'Bee', null, '203.0.113.8');
    chat(a, 'hi all');
    chat(b, 'darn');
    joinMainRoom(zone, a);
    chat(a, 'badword');
    expect(h.entries.map((e) => [e.roomId === null ? 'zone' : 'room', e.channel, e.name, e.original, e.action, e.display])).toEqual([
      ['zone', 'name', 'Bee', 'Bee', 'pass', 'as-typed'], // v0.6: the guest's joining callsign (accounts never)
      ['zone', 'all', 'Ace', 'hi all', 'pass', 'as-typed'],
      ['zone', 'all', 'Bee', 'darn', 'mask', 'substituted'], // action stays the filter's verdict
      ['room', 'all', 'Ace', 'badword', 'block', 'substituted'],
    ]);
    const [, z, m, r] = h.entries;
    expect(z).toMatchObject({ roomName: 'Zone', accountId: 'acc-Ace', address: '203.0.113.7', playerId: a.pid, shown: 'hi all', roomUid: zone.roomUidOf(null) });
    expect(m).toMatchObject({ accountId: null, address: '203.0.113.8', hits: ['test:mask'] });
    expect(DEFAULT_POSITIVE_LINES).toContain(m!.shown); // `shown` = the positive line the others saw
    expect(r).toMatchObject({ roomName: 'Main Arena', hits: ['test:block'] });
    expect(typeof r!.roomId).toBe('string');
    expect(r!.roomUid).toBe(zone.roomUidOf(r!.roomId));
    expect(DEFAULT_POSITIVE_LINES).toContain(r!.shown);
    // commands are not chat
    chat(a, '/help');
    expect(h.entries).toHaveLength(4);
  });

  it('a blocked line is a strike; the hook may answer with a notice (automatic mute)', () => {
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    const a = join(zone, 'Ace');
    h.strikeNotice = 'You are muted for 10 minutes (repeated blocked language).';
    chat(a, 'badword');
    expect(h.strikes.map(([u, r]) => [u.name, r])).toEqual([['Ace', 'language']]);
    expect(a.systemTexts()).toContain(h.strikeNotice);
    // a refused callsign with a slur / hate / sexual term is a strike too, and it is logged on the 'name' channel
    const g = join(zone, 'badwordy');
    expect(h.strikes.at(-1)![1]).toBe('name');
    expect(h.entries.at(-1)).toMatchObject({ channel: 'name', original: 'badwordy', action: 'block', name: g.name, hits: ['slur:badword'] });
    // ...but a name refused only for profanity (real names collide with the list) is logged, not a strike
    const before = h.strikes.length;
    const d = join(zone, 'Darnell');
    expect(d.name).not.toBe('Darnell');
    expect(h.entries.at(-1)).toMatchObject({ channel: 'name', original: 'Darnell', action: 'block', hits: ['profanity:darn'] });
    chat(d, '/name Darnell');
    expect(d.systemTexts()).toContain(MSG_NAME_REFUSED);
    expect(h.strikes.length).toBe(before);
  });

  it("review-only 'flag' hits: the line / name is allowed and shown unchanged, logged as 'flag', never a strike", () => {
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    const a = join(zone, 'Ace');
    const b = join(zone, 'Bee');
    chat(a, 'meet at zorblax');
    expect(b.said('meet at zorblax')).toBe(true);
    expect(a.systemTexts()).not.toContain(MSG_BLOCKED);
    expect(h.entries.at(-1)).toMatchObject({ channel: 'all', original: 'meet at zorblax', shown: 'meet at zorblax', action: 'flag', hits: ['flag:crew:zorblax'] });
    // callsign at hello: kept, logged on the 'name' channel for review
    const g = join(zone, 'Zorblax_Ace');
    expect(g.name).toBe('Zorblax_Ace');
    expect(g.systemTexts().some((t) => t.includes("isn't allowed"))).toBe(false);
    expect(h.entries.at(-1)).toMatchObject({ channel: 'name', original: 'Zorblax_Ace', shown: 'Zorblax_Ace', action: 'flag', hits: ['flag:crew:zorblax'] });
    // /name and room names too
    chat(b, '/name BeeZorblax');
    expect(b.name).toBe('BeeZorblax');
    expect(h.entries.at(-1)).toMatchObject({ channel: 'name', original: 'BeeZorblax', action: 'flag' });
    b.send({ type: 'createRoom', settings: { name: 'Zorblax Den', botFill: 0 } });
    expect(b.last('roomState').settings.name).toBe('Zorblax Den');
    expect(h.entries.at(-1)).toMatchObject({ channel: 'room', original: 'Zorblax Den', shown: 'Zorblax Den', action: 'flag' });
    expect(h.strikes).toEqual([]);
    // a refused name logs one label per hit, so a review-only hit next to the refusing one is found by the review filter
    chat(b, '/name QuenthZorblax');
    expect(b.name).toBe('BeeZorblax');
    expect(h.entries.at(-1)).toMatchObject({ channel: 'name', original: 'QuenthZorblax', action: 'block', hits: ['custom:crew:quenth', 'flag:watch:zorblax'] });
    // offline (no hook): simply allowed
    const off = mkZone({ local: true });
    const o = join(off, 'Zorblax');
    expect(o.name).toBe('Zorblax');
    chat(o, 'zorblax zorblax');
    expect(o.said('zorblax zorblax')).toBe(true);
  });

  it("an account username the CURRENT lists match is logged for review ('flag') on join: kept, never renamed, never a strike", () => {
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    // a review-only custom term (registration never refuses it)
    const a = join(zone, 'ignored', acct('Zorblax_Ace'));
    expect(a.name).toBe('Zorblax_Ace');
    expect(h.entries.at(-1)).toMatchObject({ channel: 'name', original: 'Zorblax_Ace', shown: 'Zorblax_Ace', action: 'flag', accountId: 'acc-Zorblax_Ace', hits: ['flag:crew:zorblax'] });
    // a term the host added after the account was registered: the account keeps its name, a moderator gets the log line
    const b = join(zone, 'ignored', acct('Darnell'));
    expect(b.name).toBe('Darnell');
    expect(b.systemTexts().some((t) => t.includes("isn't allowed"))).toBe(false);
    expect(h.entries.at(-1)).toMatchObject({ channel: 'name', original: 'Darnell', action: 'flag', accountId: 'acc-Darnell', hits: ['profanity:darn'] });
    const c = join(zone, 'ignored', acct('badwordy'));
    expect(c.name).toBe('badwordy');
    expect(h.entries.at(-1)).toMatchObject({ original: 'badwordy', action: 'flag', hits: ['slur:badword'] });
    expect(h.strikes).toEqual([]);
    // a clean account username logs nothing
    const before = h.entries.length;
    join(zone, 'ignored', acct('Cleanname'));
    expect(h.entries.length).toBe(before);
  });

  it('withheld lines (muted / repeat flood) are still read: hits logged, self-harm and threats alert the moderators, no strike', () => {
    spaced();
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    const a = join(zone, 'Ace');
    h.muted.set(a.pid, { until: null, reason: 'cool off' });
    chat(a, 'sadword');
    expect(h.entries.at(-1)).toMatchObject({ action: 'muted', hits: ['selfharm:sadword'], shown: '' });
    expect(a.systemTexts()).toContain(MSG_CARE);
    expect(h.alerts).toEqual([['Ace', 'selfharm']]);
    tick();
    chat(a, 'threatword');
    expect(h.alerts).toEqual([['Ace', 'selfharm'], ['Ace', 'threat']]);
    expect(h.strikes).toEqual([]);
    h.muted.clear();
    // repeat flood: the 3rd copy is withheld as spam, but a threat in it still reaches the moderators
    const b = join(zone, 'Bee');
    tick(); chat(b, 'darn it');
    tick(); chat(b, 'darn it');
    tick(); chat(b, 'darn it');
    expect(h.entries.at(-1)).toMatchObject({ action: 'spam', hits: ['test:mask'] });
    tick(); chat(b, 'threatword now');
    tick(); chat(b, 'threatword now');
    const strikes = h.strikes.length;
    tick(); chat(b, 'threatword now');
    expect(h.entries.at(-1)).toMatchObject({ action: 'spam' });
    expect(h.strikes.length).toBe(strikes);
    expect(h.alerts.at(-1)).toEqual(['Bee', 'threat']);
    // v0.6: a self-harm statement mixed with other blocked language is still wellbeing first: withheld, the kind note,
    // the host's alert — and no strike (never punished); the other hits stay in the log for the host
    const c = join(zone, 'Cee');
    const before = h.strikes.length;
    tick(); chat(c, 'mixedword');
    expect(h.strikes.length).toBe(before);
    expect(c.systemTexts().at(-1)).toBe(MSG_CARE);
    expect(h.alerts.at(-1)).toEqual(['Cee', 'selfharm']);
    expect(h.entries.at(-1)).toMatchObject({ action: 'block', display: 'withheld', shown: '', hits: ['slur:mixedword', 'selfharm:sadword'] });
  });

  it("passes the host's strictness (ZoneOptions.chatFilter) to the filter; default strict", () => {
    const zone = mkZone({ chatFilter: 'standard' });
    const a = join(zone, 'Ace');
    chat(a, 'hello there');
    expect(filterState.lastOpts.at(-1)).toEqual({ strictness: 'standard' });
    const z2 = mkZone();
    const b = join(z2, 'Bee');
    chat(b, 'hello again');
    expect(filterState.lastOpts.at(-1)).toEqual({ strictness: 'strict' });
  });

  it('self-harm statements are withheld without a strike (a kind note; the host is alerted); threats are strikes', () => {
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    const a = join(zone, 'Ace');
    const b = join(zone, 'Bee');
    chat(a, 'sadword');
    expect(a.systemTexts()).toContain(MSG_CARE);
    expect(a.systemTexts()).not.toContain(MSG_BLOCKED);
    expect(b.of('chat').some((c) => c.line.text.includes('sadword'))).toBe(false);
    expect(h.strikes).toEqual([]); // v0.6: onStrike is never called for it (was 'selfharm'); the alert tells the host
    expect(h.alerts).toEqual([['Ace', 'selfharm']]);
    expect(h.entries.at(-1)).toMatchObject({ action: 'block', hits: ['selfharm:sadword'], display: 'withheld' });
    chat(a, 'threatword');
    expect(h.strikes.map(([, r]) => r)).toEqual(['threat']);
    expect(a.systemTexts().at(-1)).toBe(MSG_WARN_FIRST);
    // display taming applies to what is shown and logged
    chat(a, 'wow!!!!!!!');
    expect(b.said('wow!!!')).toBe(true);
    expect(h.entries.at(-1)).toMatchObject({ original: 'wow!!!!!!!', shown: 'wow!!!', action: 'pass' });
  });

  it('muted pilots: nothing is broadcast, they are told until when, the attempt is logged', () => {
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    const a = join(zone, 'Ace');
    const b = join(zone, 'Bee');
    h.muted.set(a.pid, { until: Date.UTC(2030, 0, 2, 15, 0), reason: 'cool off' });
    chat(a, 'let me talk');
    expect(b.said('let me talk')).toBe(false);
    const notice = a.systemTexts().at(-1)!;
    expect(notice).toMatch(/^You are muted until .*2030.*: cool off\.$/);
    expect(h.entries.at(-1)).toMatchObject({ action: 'muted', shown: '', original: 'let me talk' });
    h.muted.set(a.pid, { until: null, reason: '' });
    chat(a, 'still?');
    expect(a.systemTexts().at(-1)).toBe('You are muted.');
    // /report still works while muted
    chat(a, '/report Bee spamming');
    expect(h.reports).toHaveLength(1);
  });

  it('moderator commands: a non-moderator gets exactly the unknown-command line (no leak), a moderator gets the hook', async () => {
    spaced(); // the chat budget is 5 lines / 5 s
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    const pleb = join(zone, 'Pleb', acct('Pleb'));
    const mod = join(zone, 'Teach', acct('Teach'));
    h.admin.add('acc-Teach');
    for (const cmd of ['ban Pleb 1d x', 'ipban Pleb 1d x', 'mute Pleb 10m', 'unmute Pleb', 'unban Pleb', 'kick Pleb', 'warn Pleb hi',
      'log Pleb', 'reports', 'whois Pleb', 'confirm', 'modhelp', 'zzznotacommand']) {
      chat(pleb, `/${cmd}`);
      const first = cmd.split(' ')[0];
      expect(pleb.systemTexts().at(-1)).toBe(`Unknown command /${first} — try /help`);
      tick();
    }
    expect(h.commands).toHaveLength(0);
    // neither help text lists them
    const helpText = (c: FakeClient): string => { const n = c.systemTexts().length; chat(c, '/help'); tick(); return c.systemTexts().slice(n).join(' '); };
    expect(helpText(pleb)).not.toMatch(/\/(ban|ipban|mute|kick|warn|log|whois|reports)\b/);
    // in a room too
    joinMainRoom(zone, pleb);
    chat(pleb, '/whois Teach');
    tick();
    expect(pleb.systemTexts().at(-1)).toBe('Unknown command /whois — try /help');
    expect(helpText(pleb)).not.toMatch(/\/(ban|ipban|mute|kick|warn|log|whois|reports)\b/);

    chat(mod, '/ban Pleb 1d being rude');
    tick();
    expect(h.commands).toEqual([['ban', ['Pleb', '1d', 'being', 'rude']]]);
    expect(mod.systemTexts().at(-1)).toBe('did ban Pleb 1d being rude for Teach');
    h.asyncReply = true;
    joinMainRoom(zone, mod);
    chat(mod, '/whois Pleb');
    await Promise.resolve();
    await Promise.resolve();
    expect(mod.systemTexts().at(-1)).toBe('did whois Pleb for Teach');
  });

  it('/report goes to the hook with the room; usage without a reason', () => {
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    const a = join(zone, 'Ace');
    join(zone, 'Bee');
    chat(a, '/report Bee');
    expect(a.systemTexts().at(-1)).toBe(MSG_REPORT_USAGE);
    chat(a, '/report Bee said mean things');
    expect(h.reports).toEqual([['Ace', 'Bee', 'said mean things', 'Zone']]);
    expect(a.systemTexts().at(-1)).toBe('Report sent — thank you.');
    joinMainRoom(zone, a);
    chat(a, '/report Bee again');
    expect(h.reports.at(-1)![3]).toBe('Main Arena');
    // the room /help mentions /report
    chat(a, '/help');
    expect(a.systemTexts().some((t) => t.includes('/report <name> <reason>'))).toBe(true);
  });

  it('a throwing hook never breaks chat (logged; treated as no effect)', () => {
    const logs: string[] = [];
    const h = fakeHook();
    h.isMuted = () => { throw new Error('db down'); };
    h.logChat = () => { throw new Error('db down'); };
    const zone = new Zone({ snapshotEvery: 3, motd: '', local: false, moderation: h, defaultRooms: [{}], log: (l) => logs.push(l) });
    const a = join(zone, 'Ace');
    const b = join(zone, 'Bee');
    chat(a, 'still works');
    expect(b.said('still works')).toBe(true);
    expect(logs.some((l) => l.includes('moderation isMuted failed'))).toBe(true);
  });
});

describe('Zone moderation API (onlinePilots / kickPilots / tellPilot)', () => {
  it('lists pilots with account, address and room; kicks and tells by selection', () => {
    const zone = mkZone({ hook: fakeHook() });
    const a = join(zone, 'Ace', acct('Ace'), '198.51.100.1');
    const b = join(zone, 'Bee', null, '198.51.100.2');
    joinMainRoom(zone, b);
    const list = zone.onlinePilots();
    expect(list.find((p) => p.name === 'Ace')).toMatchObject({ accountId: 'acc-Ace', username: 'Ace', address: '198.51.100.1', roomId: null, roomName: null });
    expect(list.find((p) => p.name === 'Bee')).toMatchObject({ accountId: null, username: null, address: '198.51.100.2', roomName: 'Main Arena' });
    expect(zone.tellPilot(b.pid, 'Warning from a moderator: be nice')).toBe(true);
    expect(b.systemTexts()).toContain('Warning from a moderator: be nice');
    expect(zone.kickPilots((p) => p.address === '198.51.100.2', 'You are banned: test')).toBe(1);
    expect(b.last('error').message).toBe('You are banned: test');
    expect(b.closedReason).toBe('You are banned: test');
    expect(zone.onlinePilots().map((p) => p.name)).toEqual(['Ace']);
    expect(zone.tellPilot(b.pid, 'gone')).toBe(false);
    expect(a.closedReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// v0.6 LAN edition chat pipeline (docs/LAN-EDITION-proposal.md §5.6-§5.8, §11.8)
// ---------------------------------------------------------------------------------------------------------------

type ChatMsg = Extract<ServerMsg, { type: 'chat' }>;
/** Chat messages `c` received after message index `from`. */
const chatsSince = (c: FakeClient, from: number): ChatMsg[] => c.msgs.slice(from).filter((m): m is ChatMsg => m.type === 'chat');
const mainRoomId = (c: FakeClient): string => c.last('roomList').rooms.find((r) => r.name === 'Main Arena')!.id;
/** Every generic warning the sender may get: none may name a word, a category or a tag. */
const WARNINGS = [MSG_WARN_FIRST, MSG_WARN_SECOND, MSG_WARN_AGAIN, MSG_WARN_LAST, MSG_WARN_MUTED];
const NAMES_A_REASON = /badword|darn|threatword|grimtag|slur|profan|vulgar|sexual|hate|threat|gang|self.?harm|test|block|mask|tag|categor/i;

describe('LAN edition chat pipeline: log coverage (T-ROOM-1, T-ROOM-2)', () => {
  it('T-ROOM-1: lobby, room all, room team and the // prefix give exactly 4 entries with the right channel, team and roomUid', () => {
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    const a = join(zone, 'ignored', acct('Ace')); // an account: its callsign is never logged
    chat(a, 'lobby line');
    joinMainRoom(zone, a);
    a.send({ type: 'setTeam', team: 1 });
    chat(a, 'room line');
    chat(a, 'team line', 'team');
    chat(a, '//prefixed line');
    const rid = mainRoomId(a);
    expect(h.entries.map((e) => [e.channel, e.team, e.roomId, e.roomUid, e.original, e.display])).toEqual([
      ['all', NO_TEAM, null, zone.roomUidOf(null), 'lobby line', 'as-typed'],
      ['all', 1, rid, zone.roomUidOf(rid), 'room line', 'as-typed'],
      ['team', 1, rid, zone.roomUidOf(rid), 'team line', 'as-typed'],
      ['team', 1, rid, zone.roomUidOf(rid), 'prefixed line', 'as-typed'],
    ]);
    expect(zone.roomUidOf(null)).toMatch(/^[a-z0-9]+:zone$/);
    expect(zone.roomUidOf(rid)).toBe(zone.roomUidOf(null).replace(/zone$/, rid));
    // a restarted server (a new Zone) reuses room ids, never roomUids
    expect(mkZone().roomUidOf(rid)).not.toBe(zone.roomUidOf(rid));
  });

  it('T-ROOM-1: every client-sendable ChatChannel is logged (a new channel fails this test); players never send system lines', () => {
    // Type-level pin: a ChatChannel added to protocol.ts without being listed here fails `npm run typecheck`.
    const CHANNELS = ['all', 'team', 'system'] as const satisfies readonly ChatChannel[];
    type Unlisted = Exclude<ChatChannel, (typeof CHANNELS)[number]>;
    const allListed: [Unlisted] extends [never] ? true : false = true;
    expect(allListed).toBe(true);
    spaced();
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    const watcher = join(zone, 'ignored', acct('Watcher'));
    joinMainRoom(zone, watcher);
    watcher.send({ type: 'setTeam', team: 0 });
    for (const where of ['lobby', 'room'] as const) {
      for (const ch of CHANNELS) {
        tick();
        const a = join(zone, 'ignored', acct(`P_${where}_${ch}`));
        if (where === 'room') { joinMainRoom(zone, a); a.send({ type: 'setTeam', team: 0 }); }
        const before = h.entries.length;
        const n = watcher.msgs.length;
        // the wire type says 'all' | 'team'; a hand-made client can send anything
        a.send({ type: 'chat', channel: ch as 'all', text: `hello on ${ch}` });
        const logged = h.entries.slice(before);
        expect(logged, `${where}/${ch}`).toHaveLength(1);
        const expectCh = where === 'room' && ch === 'team' ? 'team' : 'all'; // 'system' from a player is plain chat
        expect(logged[0]).toMatchObject({ channel: expectCh, original: `hello on ${ch}`, action: 'pass' });
        if (where === 'room') {
          const got = chatsSince(watcher, n).find((m) => m.line.text === `hello on ${ch}`);
          expect(got?.line.channel, `${where}/${ch}`).toBe(expectCh);
          expect(got?.line.fromPlayerId).toBe(a.pid);
        }
      }
    }
    // the other human-typed text: callsigns (setName, /name) and room names (create, rename) are logged too
    const g = join(zone, 'Gus');
    g.send({ type: 'setName', name: 'Gus_Two' });
    tick(); chat(g, '/name Gus_Three');
    g.send({ type: 'createRoom', settings: { name: 'Gus Den', botFill: 0 } });
    g.send({ type: 'updateSettings', settings: { name: 'Gus Hangar' } });
    expect(h.entries.slice(-5).map((e) => [e.channel, e.original, e.action])).toEqual([
      ['name', 'Gus', 'pass'], ['name', 'Gus_Two', 'pass'], ['name', 'Gus_Three', 'pass'], ['room', 'Gus Den', 'pass'], ['room', 'Gus Hangar', 'pass'],
    ]);
  });

  it("T-ROOM-2: a guest joining as Nova and then /name Vega logs both as pass; an account holder's /name logs nothing", () => {
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    const g = join(zone, 'Nova', null, '10.1.2.3');
    chat(g, '/name Vega');
    expect(g.name).toBe('Vega');
    expect(h.entries.map((e) => [e.channel, e.original, e.shown, e.action, e.display, e.name, e.accountId, e.address])).toEqual([
      ['name', 'Nova', 'Nova', 'pass', 'as-typed', 'Nova', null, '10.1.2.3'],
      ['name', 'Vega', 'Vega', 'pass', 'as-typed', 'Vega', null, '10.1.2.3'],
    ]);
    expect(h.entries[0]).toMatchObject({ roomId: null, roomName: 'Zone', roomUid: zone.roomUidOf(null), playerId: g.pid });
    // in a room: the room's roomUid
    joinMainRoom(zone, g);
    g.send({ type: 'setName', name: 'Orion' });
    expect(h.entries.at(-1)).toMatchObject({ channel: 'name', original: 'Orion', action: 'pass', roomId: mainRoomId(g), roomUid: zone.roomUidOf(mainRoomId(g)) });
    // no change, no row
    const n0 = h.entries.length;
    g.send({ type: 'setName', name: 'Orion' });
    expect(h.entries.length).toBe(n0);
    // an account holder: callsign = username, never changes, never logged
    const acc = join(zone, 'ignored', acct('Maverick'));
    const n1 = h.entries.length;
    chat(acc, '/name Goose');
    acc.send({ type: 'setName', name: 'Iceman' });
    expect(acc.name).toBe('Maverick');
    expect(h.entries.length).toBe(n1);
    // accepted room names: create (final deduped spelling) and a rename that applied; a refused rename logs only the refusal
    acc.send({ type: 'createRoom', settings: { name: 'Main Arena', botFill: 0 } });
    const created = acc.last('roomState');
    expect(created.settings.name).not.toBe('Main Arena'); // deduped against the house room
    expect(h.entries.at(-1)).toMatchObject({ channel: 'room', original: created.settings.name, action: 'pass', roomId: created.roomId, accountId: 'acc-Maverick' });
    acc.send({ type: 'updateSettings', settings: { name: 'Top Gun' } });
    expect(h.entries.at(-1)).toMatchObject({ channel: 'room', original: 'Top Gun', shown: 'Top Gun', action: 'pass', roomName: 'Top Gun', roomUid: zone.roomUidOf(created.roomId) });
    const n2 = h.entries.length;
    acc.send({ type: 'updateSettings', settings: { name: 'badword base' } });
    expect(h.entries.length).toBe(n2 + 1);
    expect(h.entries.at(-1)).toMatchObject({ channel: 'room', original: 'badword base', action: 'block', display: 'hidden' });
    // a house room's name is fixed online: an attempted rename logs nothing
    const other = mkZone({ hook: h });
    const host = join(other, 'ignored', acct('Iceman'));
    joinMainRoom(other, host);
    const n3 = h.entries.length;
    host.send({ type: 'updateSettings', settings: { name: 'Renamed House' } });
    expect(host.last('roomState').settings.name).toBe('Main Arena');
    expect(h.entries.length).toBe(n3);
  });
});

describe('LAN edition chat pipeline: substitution and warnings (T-CHAT-1)', () => {
  it("a blocked line: the others get a positive line under the sender's name; the sender only a generic warning", () => {
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    const a = join(zone, 'Ace');
    const b = join(zone, 'Bee');
    let nA = a.msgs.length;
    let nB = b.msgs.length;
    chat(a, 'you badword');
    const toB = chatsSince(b, nB);
    expect(toB).toHaveLength(1);
    expect(toB[0]!.line).toMatchObject({ fromPlayerId: a.pid, fromName: 'Ace', channel: 'all' });
    expect(DEFAULT_POSITIVE_LINES).toContain(toB[0]!.line.text);
    // the sender never sees the substitute — only the generic warning, which names no word, category or tag
    expect(chatsSince(a, nA).map((m) => [m.line.channel, m.line.text])).toEqual([['system', MSG_WARN_FIRST]]);
    for (const w of WARNINGS) expect(NAMES_A_REASON.test(w), w).toBe(false);
    expect(h.entries.at(-1)).toMatchObject({ original: 'you badword', action: 'block', display: 'substituted', shown: toB[0]!.line.text });
    expect(h.strikes.map(([u, r]) => [u.name, r])).toEqual([['Ace', 'language']]);
    expect(h.strikeDetails.at(-1)).toEqual({ tags: ['TEST'], action: 'block' });
    // a masked line is substituted the same way (and is a strike now: the host's per-tag policy decides)
    nA = a.msgs.length;
    nB = b.msgs.length;
    chat(a, 'oh darn it');
    expect(chatsSince(b, nB).map((m) => m.line.fromName)).toEqual(['Ace']);
    expect(chatsSince(b, nB).some((m) => /darn|\*/.test(m.line.text))).toBe(false);
    expect(chatsSince(a, nA).map((m) => m.line.text)).toEqual([MSG_WARN_SECOND]);
    expect(h.entries.at(-1)).toMatchObject({ action: 'mask', display: 'substituted' });
    expect(h.strikeDetails.at(-1)).toEqual({ tags: ['TEST'], action: 'mask' });
    // history: a late joiner sees what everyone saw; the sender's own history leaves its substitutes out
    const c = join(zone, 'Cee');
    const hist = c.last('chatHistory').lines;
    expect(hist.filter((l) => l.fromPlayerId === a.pid)).toHaveLength(2);
    expect(hist.some((l) => /badword|darn/.test(l.text))).toBe(false);
    joinMainRoom(zone, a);
    a.send({ type: 'leaveRoom' });
    expect(a.last('chatHistory').lines.some((l) => l.fromPlayerId === a.pid)).toBe(false);
  });

  it('the sender never sees their own substitute, not even in the history after a reconnect (guest and account; lobby and room)', () => {
    spaced();
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    const watcher = join(zone, 'Watcher');
    const sub = (): string[] => watcher.of('chat').filter((m) => DEFAULT_POSITIVE_LINES.includes(m.line.text)).map((m) => m.line.fromName);
    // a guest: a substitute in the lobby, then one in the room
    let ace = join(zone, 'Ace');
    chat(ace, 'lobby badword'); tick();
    joinMainRoom(zone, ace);
    joinMainRoom(zone, watcher);
    chat(ace, 'room badword'); tick();
    // an account: the same in the lobby and in the room
    let kay = join(zone, 'ignored', acct('KayPilot'));
    chat(kay, 'lobby grimtag'); tick();
    joinMainRoom(zone, kay);
    chat(kay, 'room grimtag'); tick();
    // the watcher saw Ace's lobby substitute (in the lobby), then Ace's and Kay's room ones (in the room)
    expect(sub()).toEqual(['Ace', 'Ace', 'KayPilot']);
    expect(h.entries.filter((e) => e.display === 'substituted')).toHaveLength(4);
    const own = (c: FakeClient, name: string): string[] =>
      c.last('chatHistory').lines.filter((l) => l.fromName === name && DEFAULT_POSITIVE_LINES.includes(l.text)).map((l) => l.text);
    // reconnect (a new playerId): neither the lobby history nor the room history shows the sender's substitutes
    ace.conn.close();
    kay.conn.close();
    ace = join(zone, 'Ace');
    expect(ace.name).toBe('Ace');
    expect(own(ace, 'Ace')).toEqual([]);
    joinMainRoom(zone, ace);
    expect(own(ace, 'Ace')).toEqual([]);
    kay = join(zone, 'ignored', acct('KayPilot'));
    expect(own(kay, 'KayPilot')).toEqual([]);
    joinMainRoom(zone, kay);
    expect(own(kay, 'KayPilot')).toEqual([]);
    // everyone else still sees them in the history (lobby and room)
    const late = join(zone, 'Late');
    expect(own(late, 'Ace')).toHaveLength(1);
    expect(own(late, 'KayPilot')).toHaveLength(1);
    joinMainRoom(zone, late);
    expect(own(late, 'Ace')).toHaveLength(1);
    expect(own(late, 'KayPilot')).toHaveLength(1);
  });

  it("no positive line repeats twice in a row over 200 substitutions; the deck uses every line and the Zone's seeded Rng", () => {
    spaced();
    const zone = mkZone(); // no hook: nothing mutes the sender
    const a = join(zone, 'Ace');
    const b = join(zone, 'Bee');
    const random = vi.spyOn(Math, 'random');
    const nB = b.msgs.length;
    for (let i = 0; i < 200; i++) { tick(); chat(a, `badword number ${i}`); }
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
    const got = chatsSince(b, nB).filter((m) => m.line.fromPlayerId === a.pid).map((m) => m.line.text);
    expect(got).toHaveLength(200);
    let repeats = 0;
    for (let i = 1; i < got.length; i++) if (got[i] === got[i - 1]) repeats++;
    expect(repeats).toBe(0);
    expect(new Set(got).size).toBe(DEFAULT_POSITIVE_LINES.length);
    for (const s of got) expect(DEFAULT_POSITIVE_LINES).toContain(s);
  });

  it("the warning escalates on the host's strike count: 2nd, 'one more' at limit − 1, then the mute notice", () => {
    spaced();
    const run = (limit: number, lines: number): string[][] => {
      const h = fakeHook({ limit });
      const zone = mkZone({ hook: h });
      const a = join(zone, 'Ace');
      join(zone, 'Bee');
      const out: string[][] = [];
      for (let i = 0; i < lines; i++) {
        tick();
        const n = a.msgs.length;
        chat(a, `badword ${i}`);
        out.push(chatsSince(a, n).map((m) => m.line.text));
      }
      return out;
    };
    const MUTE = 'You are muted for 10 minutes (repeated blocked language).';
    expect(run(4, 5)).toEqual([
      [MSG_WARN_FIRST], [MSG_WARN_SECOND], [`${MSG_WARN_AGAIN} ${MSG_WARN_LAST}`], [MUTE],
      ['You are muted: auto.'], // muted now: the line is withheld (no substitute, no warning)
    ]);
    // the default limit of 3: the 2nd warning is the last before the mute
    expect(run(3, 3)).toEqual([[MSG_WARN_FIRST], [`${MSG_WARN_SECOND} ${MSG_WARN_LAST}`], [MUTE]]);
    // no strike status (offline, an older host): the Zone's own count; an older host's notice follows its warning
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    const a = join(zone, 'Ace');
    const texts: string[][] = [];
    for (let i = 0; i < 3; i++) {
      tick();
      h.strikeNotice = i === 2 ? "Warning: one more and you'll be muted for 10 minutes." : null;
      const n = a.msgs.length;
      chat(a, `badword ${i}`);
      texts.push(chatsSince(a, n).map((m) => m.line.text));
    }
    expect(texts).toEqual([[MSG_WARN_FIRST], [MSG_WARN_SECOND], [MSG_WARN_AGAIN, "Warning: one more and you'll be muted for 10 minutes."]]);
  });

  it("modes 'system' and 'hide'; team lines reach only the team, in every mode", () => {
    spaced();
    const h = fakeHook();
    const zone = mkZone({ hook: h, chat: { substitute: 'system' } });
    const a = join(zone, 'Ace');
    const b = join(zone, 'Bee');
    const c = join(zone, 'Cee');
    for (const x of [a, b, c]) joinMainRoom(zone, x);
    a.send({ type: 'setTeam', team: 0 });
    b.send({ type: 'setTeam', team: 0 });
    c.send({ type: 'setTeam', team: 1 });
    const say = (text: string, channel: 'all' | 'team' = 'all'): { a: ChatMsg[]; b: ChatMsg[]; c: ChatMsg[] } => {
      tick();
      const n = [a.msgs.length, b.msgs.length, c.msgs.length] as const;
      chat(a, text, channel);
      return { a: chatsSince(a, n[0]), b: chatsSince(b, n[1]), c: chatsSince(c, n[2]) };
    };
    // system: a system line with the positive text (no name); a team line stays on the team
    let r = say('badword team', 'team');
    expect(r.b.map((m) => [m.line.channel, m.line.fromPlayerId, m.line.fromName])).toEqual([['system', 0, '']]);
    expect(DEFAULT_POSITIVE_LINES).toContain(r.b[0]!.line.text);
    expect(r.c).toEqual([]);
    expect(r.a.map((m) => m.line.text)).toEqual([MSG_WARN_FIRST]);
    expect(h.entries.at(-1)).toMatchObject({ channel: 'team', display: 'system', shown: r.b[0]!.line.text });
    r = say('badword all');
    expect(r.b.map((m) => m.line.channel)).toEqual(['system']);
    expect(r.c.map((m) => m.line.channel)).toEqual(['system']);
    // a later joiner (no team yet) never sees team 0's stand-in in the history, only the all-channel one
    const d = join(zone, 'Dee');
    joinMainRoom(zone, d);
    expect(d.last('chatHistory').lines.filter((l) => l.channel === 'system' && DEFAULT_POSITIVE_LINES.includes(l.text))).toHaveLength(1);
    // hide: nothing at all
    expect(zone.setChatOptions({ substitute: 'hide' }).ok).toBe(true);
    r = say('badword hidden');
    expect([r.b, r.c]).toEqual([[], []]);
    expect(r.a.map((m) => m.line.text)).toEqual([MSG_WARN_AGAIN]);
    expect(h.entries.at(-1)).toMatchObject({ display: 'hidden', shown: '', action: 'block' });
    // sender: under the sender's name, a team line only to the team
    expect(zone.setChatOptions({ substitute: 'sender' }).ok).toBe(true);
    r = say('badword again', 'team');
    expect(r.b.map((m) => [m.line.channel, m.line.fromName, m.line.team])).toEqual([['team', 'Ace', 0]]);
    expect(r.c).toEqual([]);
    expect(r.a.some((m) => m.line.fromPlayerId === a.pid)).toBe(false);
    // the zone lobby: system mode works there too, and the sender is skipped
    expect(zone.setChatOptions({ substitute: 'system' }).ok).toBe(true);
    for (const x of [a, b]) x.send({ type: 'leaveRoom' });
    tick();
    const nb = b.msgs.length;
    const na = a.msgs.length;
    chat(a, 'badword lobby');
    expect(chatsSince(b, nb).map((m) => m.line.channel)).toEqual(['system']);
    expect(DEFAULT_POSITIVE_LINES).toContain(chatsSince(b, nb)[0]!.line.text);
    expect(chatsSince(a, na).map((m) => m.line.text)).toEqual([MSG_WARN_AGAIN]); // only its warning
  });

  it('setChatOptions: all or nothing; positive lines are validated (≤ 60 characters, pass the filter, ≥ 5 kept)', () => {
    const zone = mkZone();
    const before = zone.chatOptions();
    expect(before).toMatchObject({ substitute: 'sender', strictness: 'strict' });
    expect(before.positiveLines).toEqual([...DEFAULT_POSITIVE_LINES]);
    expect(zone.setChatOptions({ substitute: 'bogus' as never })).toMatchObject({ ok: false });
    expect(zone.setChatOptions({ strictness: 'lax' as never })).toMatchObject({ ok: false });
    const few = zone.setChatOptions({ positiveLines: ['Nice one!', 'GG!', 'badword indeed', 'x'.repeat(61)], substitute: 'hide' });
    expect(few.ok).toBe(false);
    expect(zone.chatOptions()).toEqual(before); // nothing changed, not even the mode
    const mine = ['Nice one!', 'GG!', 'Well flown!', 'Cheers!', 'Fly on!', 'gg!', 'badword indeed', 'x'.repeat(61), '   '];
    const r = zone.setChatOptions({ positiveLines: mine, strictness: 'standard' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.options.positiveLines).toEqual(['Nice one!', 'GG!', 'Well flown!', 'Cheers!', 'Fly on!']);
    expect(r.options.strictness).toBe('standard');
    expect(r.rejected.map((x) => x.why)).toEqual(['duplicate', "doesn't pass the chat filter", 'longer than 60 characters', 'empty']);
    for (const x of r.rejected) expect(/badword/.test(x.why)).toBe(false); // a reason never names the matched term
    // the new strictness reaches the filter; substitutes come from the new list
    const a = join(zone, 'Ace');
    const b = join(zone, 'Bee');
    const n = b.msgs.length;
    chat(a, 'badword');
    expect(filterState.lastOpts.at(-1)).toEqual({ strictness: 'standard' });
    expect(r.options.positiveLines).toContain(chatsSince(b, n)[0]!.line.text);
    // ZoneOptions.chat at construction
    expect(mkZone({ chat: { substitute: 'hide', strictness: 'standard' } }).chatOptions()).toMatchObject({ substitute: 'hide', strictness: 'standard' });
    // odd entries are refused, never thrown on (an object that can't be turned into a string included)
    const odd = [Object.create(null), { toString: () => { throw new Error('no'); } }, 42, null, ...DEFAULT_POSITIVE_LINES.slice(0, 5)];
    const ro = zone.setChatOptions({ positiveLines: odd as unknown as string[] });
    expect(ro.ok).toBe(true);
    expect(ro.rejected.map((x) => [x.line, x.why])).toEqual([['(object)', 'empty'], ['(object)', 'empty'], ['(number)', 'empty'], ['(null)', 'empty']]);
    // ...and a Zone built with such settings keeps the defaults instead of failing to start
    const logs: string[] = [];
    const z2 = mkZone({ chat: { positiveLines: [Object.create(null)] as unknown as string[] }, log: (l) => logs.push(l) });
    expect(z2.chatOptions().positiveLines).toEqual([...DEFAULT_POSITIVE_LINES]);
    expect(logs.some((l) => l.startsWith('chat options refused (defaults kept)'))).toBe(true);
  });
});

describe('LAN edition chat pipeline: wellbeing, threats, review-only terms, offline (T-CHAT-3)', () => {
  it('SELF-HARM is withheld with MSG_CARE (988), no strike, an alert; THREAT is substituted with an alert; flag lines are unchanged', () => {
    spaced();
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    const a = join(zone, 'Ace');
    const b = join(zone, 'Bee');
    let na = a.msgs.length;
    let nb = b.msgs.length;
    chat(a, 'i sadword');
    expect(chatsSince(b, nb)).toEqual([]); // withheld: never replaced with a cheerful line
    expect(chatsSince(a, na).map((m) => m.line.text)).toEqual([MSG_CARE]);
    expect(MSG_CARE).toContain('988');
    expect(h.strikes).toEqual([]);
    expect(h.alerts).toEqual([['Ace', 'selfharm']]);
    expect(h.entries.at(-1)).toMatchObject({ action: 'block', display: 'withheld', shown: '', hits: ['selfharm:sadword'] });
    expect(h.alertEntries.at(-1)).toBe(h.entries.at(-1)); // the host can tie the alert to its log row
    // THREAT: substituted like the others, a strike, and the alert
    tick();
    na = a.msgs.length;
    nb = b.msgs.length;
    chat(a, 'threatword you');
    expect(chatsSince(b, nb).map((m) => m.line.fromName)).toEqual(['Ace']);
    expect(DEFAULT_POSITIVE_LINES).toContain(chatsSince(b, nb)[0]!.line.text);
    expect(chatsSince(a, na).map((m) => m.line.text)).toEqual([MSG_WARN_FIRST]);
    expect(h.strikes.map(([, r]) => r)).toEqual(['threat']);
    expect(h.strikeDetails.at(-1)).toEqual({ tags: ['THREAT'], action: 'block' });
    expect(h.alerts.at(-1)).toEqual(['Ace', 'threat']);
    expect(h.entries.at(-1)).toMatchObject({ action: 'block', display: 'substituted' });
    // review-only ('flag', e.g. an unconfirmed GANG term): shown unchanged, logged with its hit, no warning, no strike
    tick();
    na = a.msgs.length;
    nb = b.msgs.length;
    chat(a, 'meet at vexmark');
    expect(chatsSince(b, nb).map((m) => m.line.text)).toEqual(['meet at vexmark']);
    expect(chatsSince(a, na).filter((m) => m.line.channel === 'system')).toEqual([]);
    expect(h.entries.at(-1)).toMatchObject({ action: 'flag', display: 'as-typed', hits: ['flag:gang:vexmark'] });
    expect(h.strikes).toHaveLength(1);
    // a confirmed GANG term: blocked, substituted, struck with its tag
    tick();
    chat(a, 'grimtag');
    expect(h.entries.at(-1)).toMatchObject({ action: 'block', display: 'substituted', hits: ['custom:gang:grimtag'] });
    expect(h.strikeDetails.at(-1)).toEqual({ tags: ['GANG'], action: 'block' });
    // the whole run: nobody but the host ever got the original of a filtered line
    for (const w of ['sadword', 'threatword', 'grimtag']) expect(b.of('chat').some((m) => m.line.text.includes(w)), w).toBe(false);
  });

  it('a self-harm term in a callsign or a room name: not used, the kind note (988), the alert, never a strike, on every name path', () => {
    spaced();
    const h = fakeHook({ limit: 3 }); // the v0.6 server's shape: three strikes would auto-mute
    const zone = mkZone({ hook: h });
    const isCare = (e: ChatLogEntry | undefined, channel: 'name' | 'room', original: string): void => {
      expect(e).toMatchObject({ channel, original, action: 'block', shown: '', display: 'withheld', hits: ['selfharm:sadword'] });
    };
    // 1. hello: a generated callsign, and the kind note instead of "isn't allowed"
    const g = join(zone, 'sadword');
    expect(g.name).toMatch(GENERATED);
    expect(g.systemTexts()).toContain(MSG_CARE_NAME);
    expect(MSG_CARE_NAME).toContain('988');
    expect(g.systemTexts().some((t) => t.includes(g.name) && t.includes('/name'))).toBe(true);
    expect(g.systemTexts().some((t) => t.includes("isn't allowed"))).toBe(false);
    isCare(h.entries.find((e) => e.channel === 'name' && e.original === 'sadword'), 'name', 'sadword');
    expect(h.alerts).toEqual([[g.name, 'selfharm']]);
    expect(h.alertEntries.at(-1)).toBe(h.entries.find((e) => e.display === 'withheld'));
    // 2. /name and 3. setName: not used, the kind note (a setName error toast carries it too), the name stays
    const before = g.name;
    tick(); chat(g, '/name sadword');
    expect(g.systemTexts().at(-1)).toBe(MSG_CARE_NAME);
    isCare(h.entries.at(-1), 'name', 'sadword');
    tick(); g.send({ type: 'setName', name: 'sadword_2' });
    expect(g.last('error').message).toBe(MSG_CARE_NAME);
    expect(g.systemTexts().at(-1)).toBe(MSG_CARE_NAME);
    expect(g.name).toBe(before);
    // 4. createRoom: no room, the kind note
    const rooms = g.last('roomList').rooms.length;
    g.send({ type: 'createRoom', settings: { name: 'sadword room' } });
    expect(g.last('error').message).toBe(MSG_CARE_NAME);
    isCare(h.entries.at(-1), 'room', 'sadword room');
    g.send({ type: 'listRooms' });
    expect(g.last('roomList').rooms.length).toBe(rooms);
    // 5. a room host's rename: the name is dropped, the kind note instead of "that room name isn't allowed"
    g.send({ type: 'createRoom', settings: { name: 'Fine Room', botFill: 0 } });
    const nsys = g.systemTexts().length;
    g.send({ type: 'updateSettings', settings: { name: 'sadword town' } });
    expect(g.last('roomState').settings.name).toBe('Fine Room');
    expect(g.systemTexts().slice(nsys)).toEqual([MSG_CARE_NAME]);
    isCare(h.entries.at(-1), 'room', 'sadword town');
    // five tries, five alerts, no strike: the pilot is never muted for it
    expect(h.alerts.map(([, k]) => k)).toEqual(['selfharm', 'selfharm', 'selfharm', 'selfharm', 'selfharm']);
    expect(h.strikes).toEqual([]);
    expect(h.muted.size).toBe(0);
    for (const e of h.entries.filter((x) => x.display === 'withheld')) expect(h.alertEntries).toContain(e);
    // a slur next to it: still wellbeing first (the same rule as a chat line), so no strike, and the kind note
    const m = join(zone, 'mixedword');
    expect(m.systemTexts()).toContain(MSG_CARE_NAME);
    expect(h.entries.find((e) => e.original === 'mixedword')).toMatchObject({ channel: 'name', display: 'withheld', hits: ['slur:mixedword', 'selfharm:sadword'] });
    expect(h.strikes).toEqual([]);
    // a slur alone in a name is still a strike, and its StrikeDetail never carries SELF-HARM
    join(zone, 'badword');
    expect(h.strikes.map(([, r]) => r)).toEqual(['name']);
    expect(h.strikeDetails.at(-1)).toEqual({ tags: ['HATE'], action: 'block' });
    expect(h.alerts).toHaveLength(6);
  });

  it('a review-only (unconfirmed) self-harm term: the line or name is shown unchanged with no warning, but the host is alerted', () => {
    spaced();
    const h = fakeHook({ limit: 3 });
    const zone = mkZone({ hook: h });
    const a = join(zone, 'Ace');
    const b = join(zone, 'Bee');
    const na = a.msgs.length;
    const nb = b.msgs.length;
    chat(a, 'feeling glumword');
    expect(chatsSince(b, nb).map((m) => [m.line.fromName, m.line.text])).toEqual([['Ace', 'feeling glumword']]);
    expect(chatsSince(a, na).filter((m) => m.line.channel === 'system')).toEqual([]); // no warning, no kind note
    expect(h.entries.at(-1)).toMatchObject({ action: 'flag', display: 'as-typed', hits: ['flag:selfharm:glumword'] });
    expect(h.alerts).toEqual([['Ace', 'selfharm']]);
    expect(h.alertEntries.at(-1)).toBe(h.entries.at(-1)); // entry.action 'flag' = from an unconfirmed term
    expect(h.strikes).toEqual([]);
    // mixed with enforced language: handled as that language (substituted, warned, struck), plus the alert
    tick(); chat(a, 'glumword badword');
    expect(h.entries.at(-1)).toMatchObject({ action: 'block', display: 'substituted', hits: ['slur:badword', 'flag:selfharm:glumword'] });
    expect(h.strikes.map(([, r]) => r)).toEqual(['language']);
    expect(h.strikeDetails.at(-1)).toEqual({ tags: ['HATE'], action: 'block' });
    expect(h.alerts.at(-1)).toEqual(['Ace', 'selfharm']);
    expect(h.alerts).toHaveLength(2);
    // a muted pilot's line is withheld anyway; the alert still goes out
    h.muted.set(a.pid, { until: null, reason: 'test' });
    tick(); chat(a, 'so glumword');
    expect(h.entries.at(-1)).toMatchObject({ action: 'muted' });
    expect(h.alerts).toHaveLength(3);
    // a guest callsign with it: accepted, logged as 'flag', alerted once
    const g = join(zone, 'glumword');
    expect(g.name).toBe('glumword');
    expect(h.entries.at(-1)).toMatchObject({ channel: 'name', action: 'flag', display: 'as-typed', hits: ['flag:selfharm:glumword'] });
    expect(h.alerts.at(-1)).toEqual(['glumword', 'selfharm']);
    expect(h.alerts).toHaveLength(4);
    // an account username with it is logged for review on every join, but not alerted each time
    join(zone, 'ignored', acct('Glumword_Fan'));
    expect(h.entries.at(-1)).toMatchObject({ channel: 'name', action: 'flag', original: 'Glumword_Fan' });
    expect(h.alerts).toHaveLength(4);
    // other unconfirmed terms stay review-only (no alert): only SELF-HARM's notify can't be switched off
    tick(); chat(b, 'meet at vexmark');
    expect(h.alerts).toHaveLength(4);
  });

  it('offline play vs bots substitutes and warns the same way, and logs nothing', () => {
    spaced();
    const logs: string[] = [];
    const zone = mkZone({ local: true, log: (l) => logs.push(l) });
    const me = join(zone, 'Ace');
    const peek = join(zone, 'Peek'); // stands in for what the bots "hear"
    joinMainRoom(zone, me);
    joinMainRoom(zone, peek);
    const na = me.msgs.length;
    const np = peek.msgs.length;
    chat(me, 'badword bots');
    expect(chatsSince(peek, np).map((m) => m.line.fromName)).toEqual(['Ace']);
    expect(DEFAULT_POSITIVE_LINES).toContain(chatsSince(peek, np)[0]!.line.text);
    expect(chatsSince(me, na).map((m) => m.line.text)).toEqual([MSG_WARN_FIRST]);
    tick(); chat(me, 'oh darn');
    expect(chatsSince(me, na).map((m) => m.line.text)).toEqual([MSG_WARN_FIRST, MSG_WARN_SECOND]);
    tick(); chat(me, 'sadword');
    expect(chatsSince(me, na).at(-1)!.line.text).toBe(MSG_CARE);
    // no hook = no chat log; the Zone's own log sink never carries chat text
    expect(logs.some((l) => /badword|darn|sadword/.test(l))).toBe(false);
  });
});

describe('LAN edition: announcements and reserved callsigns (T-ADM-14, §4.1)', () => {
  it('T-ADM-14: announce everywhere vs one room; logged as announce', () => {
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    const lobby = join(zone, 'ignored', acct('Lobbyist'));
    const inMain = join(zone, 'ignored', acct('Mainer'));
    joinMainRoom(zone, inMain);
    const other = join(zone, 'ignored', acct('Other'));
    other.send({ type: 'createRoom', settings: { name: 'Side Room', botFill: 0 } });
    const sideId = other.last('roomState').roomId!;
    const all = [lobby, inMain, other];
    let n = all.map((c) => c.msgs.length);
    const r1 = zone.announce('Finish your match');
    expect(r1).toEqual({ ok: true, delivered: 3, roomId: null });
    all.forEach((c, i) => {
      expect(chatsSince(c, n[i]!).map((m) => [m.line.channel, m.line.fromPlayerId, m.line.text])).toEqual([['system', 0, '[Host] Finish your match']]);
    });
    expect(h.entries.at(-1)).toEqual({
      time: expect.any(Number), roomId: null, roomName: 'All rooms', roomUid: null, channel: 'announce', team: NO_TEAM, playerId: 0,
      name: 'Host', accountId: null, address: null, original: 'Finish your match', shown: '[Host] Finish your match', action: 'pass',
      hits: [], display: 'as-typed',
    });
    // one room only
    const main = mainRoomId(inMain);
    n = all.map((c) => c.msgs.length);
    expect(zone.announce('  5 minutes   left ', main)).toEqual({ ok: true, delivered: 1, roomId: main });
    expect(chatsSince(inMain, n[1]!).map((m) => m.line.text)).toEqual(['[Host] 5 minutes left']);
    expect(chatsSince(lobby, n[0]!)).toEqual([]);
    expect(chatsSince(other, n[2]!)).toEqual([]);
    expect(h.entries.at(-1)).toMatchObject({ channel: 'announce', roomId: main, roomName: 'Main Arena', roomUid: zone.roomUidOf(main), original: '5 minutes left' });
    expect(zone.announce('Server restarting soon', sideId)).toMatchObject({ ok: true, delivered: 1 });
    // refused: empty text, unknown room (nothing sent, nothing logged)
    const e = h.entries.length;
    expect(zone.announce('   ')).toMatchObject({ ok: false });
    expect(zone.announce('hello', 'r999')).toMatchObject({ ok: false });
    expect(zone.announce(42 as unknown as string)).toMatchObject({ ok: false });
    // an unset room picker ('') is refused, never read as "every room"; only undefined / null mean everyone
    const nAll = all.map((c) => c.msgs.length);
    expect(zone.announce('hello', '')).toMatchObject({ ok: false });
    expect(zone.announce('hello', 7 as unknown as string)).toMatchObject({ ok: false });
    all.forEach((c, i) => expect(chatsSince(c, nAll[i]!)).toEqual([]));
    expect(h.entries.length).toBe(e);
    expect(zone.announce('Everyone', null)).toMatchObject({ ok: true, roomId: null, delivered: 3 });
    // long text is cut to ANNOUNCE_MAX_LEN
    zone.announce('y'.repeat(500));
    expect(h.entries.at(-1)!.original).toHaveLength(ANNOUNCE_MAX_LEN);
    // history: a late lobby joiner sees the zone-wide announcements, a late room joiner the room's too
    const late = join(zone, 'ignored', acct('Latecomer'));
    expect(late.last('chatHistory').lines.map((l) => l.text)).toContain('[Host] Finish your match');
    joinMainRoom(zone, late);
    expect(late.last('chatHistory').lines.map((l) => l.text)).toEqual(expect.arrayContaining(['[Host] Finish your match', '[Host] 5 minutes left']));
  });

  it('reserved callsigns (Host, Teacher, Admin, ... and look-alikes) are refused for guests at join and on /name; no strike', () => {
    spaced();
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    for (const n of ['Host', 'Host PC', 'Host_PC', 'H0st', 'host2', 'Teacher', 'Teach3r', 'ADMIN_2', 'Administrator', 'Moderator', 'Mod', 'System', 'Sys7em', 'Server', '5erver', 'Hos7', 'H057', 'Hos77']) {
      const g = join(zone, n);
      expect(g.name, n).toMatch(GENERATED);
      expect(g.systemTexts().some((t) => t.startsWith('That callsign is reserved') && t.includes(g.name)), n).toBe(true);
      expect(h.entries.at(-1), n).toMatchObject({ channel: 'name', action: 'block', hits: ['reserved'], display: 'hidden' });
    }
    expect(h.strikes).toEqual([]);
    for (const n of ['Hostile', 'Teach', 'Nova', 'Admiral', 'Ghost', 'Servo', 'Modesty']) expect(join(zone, n).name, n).toBe(n);
    const g = join(zone, 'Nova');
    tick(); chat(g, '/name Host');
    expect(g.systemTexts().at(-1)).toBe(MSG_NAME_RESERVED);
    g.send({ type: 'setName', name: 'Teacher' });
    expect(g.last('error').message).toBe(MSG_NAME_RESERVED);
    expect(g.name).toMatch(/^Nova/);
    // the host admin's username (setReservedNames / ZoneOptions.reservedNames)
    zone.setReservedNames(['ms_rivera']);
    expect(join(zone, 'Ms_Rivera').name).toMatch(GENERATED);
    expect(join(zone, 'MsRivera2').name).toMatch(GENERATED);
    const z2 = new Zone({ snapshotEvery: 3, motd: '', local: false, defaultRooms: [{}], reservedNames: ['coach_k'] });
    const c = new FakeClient();
    c.conn = z2.connect(c);
    c.send({ type: 'hello', name: 'Coach_K', protocol: PROTOCOL_VERSION, version: 'test' });
    expect(c.name).toMatch(GENERATED);
    // accounts keep their username (registration is the auth service's to refuse), but every join of one that is
    // reserved is logged for review ('flag', hits ['reserved', ...]): no rename, no strike, no private notice
    const srv = join(zone, 'ignored', acct('Server'));
    expect(srv.name).toBe('Server');
    expect(srv.systemTexts().some((t) => t.includes('reserved'))).toBe(false);
    expect(h.entries.at(-1)).toMatchObject({ channel: 'name', original: 'Server', shown: 'Server', action: 'flag', hits: ['reserved'], accountId: 'acc-Server', display: 'as-typed' });
    join(zone, 'ignored', acct('Ms_Rivera')); // the host admin's username (setReservedNames) as an old game account
    expect(h.entries.at(-1)).toMatchObject({ original: 'Ms_Rivera', action: 'flag', hits: ['reserved'] });
    join(zone, 'ignored', acct('Zorblax_Host')); // not reserved (Host is not the whole name), only the review-only term
    expect(h.entries.at(-1)).toMatchObject({ original: 'Zorblax_Host', action: 'flag', hits: ['flag:crew:zorblax'] });
    join(zone, 'ignored', acct('Admin_Zorblax'));
    expect(h.entries.at(-1)).toMatchObject({ original: 'Admin_Zorblax', action: 'flag', hits: ['flag:crew:zorblax'] });
    const n = h.entries.length;
    join(zone, 'ignored', acct('Vega_Ace'));
    expect(h.entries.length).toBe(n); // a clean, unreserved account username logs nothing
    expect(h.strikes).toEqual([]);
  });

  it('a generated callsign is never itself reserved (a host admin named like one: another stem); extras reserve their leet reading', () => {
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    zone.setReservedNames(['Pilot1']); // every PilotNNNN is a look-alike of it
    for (const n of ['Host', 'badword', 'Pilot7']) {
      const g = join(zone, n);
      expect(g.name, n).not.toMatch(/^Pilot/);
      expect(g.name, n).toMatch(/^[A-Za-z]+\d{4,}$/);
      expect(isReservedCallsign(g.name, ['Pilot1']), n).toBe(false);
    }
    // an extra reserved name ending in a leet digit reserves its letter reading too (Jone5 = Jones)
    expect(isReservedCallsign('Jones', ['Jone5'])).toBe(true);
    expect(isReservedCallsign('Jone5', ['Jones'])).toBe(true);
    expect(isReservedCallsign('J0nes', ['Jone5'])).toBe(true);
    expect(isReservedCallsign('Jonas', ['Jone5'])).toBe(false);
    zone.setReservedNames(['Jone5']);
    expect(join(zone, 'Jones').name).toMatch(GENERATED);
    expect(join(zone, 'Jonah').name).toBe('Jonah');
  });
});
