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
    if (/mixedword/i.test(text)) {
      return { text: '', action: 'block', hits: [{ term: 'mixedword', tier: 'block', category: 'slur' }, { term: 'sadword', tier: 'block', category: 'selfharm' }] };
    }
    if (/sadword/i.test(text)) return { text: '', action: 'block', hits: [{ term: 'sadword', tier: 'block', category: 'selfharm' }] };
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

import type { AccountInfo, ClientMsg, ServerMsg } from '../protocol';
import type { Snapshot } from '../types';
import { PROTOCOL_VERSION } from '../version';
import {
  MSG_BLOCKED, MSG_CARE, MSG_NAME_REFUSED, MSG_REPORT_OFFLINE, MSG_REPORT_USAGE, MSG_ROOM_NAME_REFUSED, MSG_SPAM,
  type ChatLogEntry, type ModerationHook, type ModUser,
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
  admin: Set<string>;
  commands: [string, string[]][];
  reports: [string, string, string, string][];
  muted: Map<number, { until: number | null; reason: string }>;
  strikeNotice: string | null;
  asyncReply: boolean;
  alerts: [string, string][];
}

function fakeHook(): FakeHook {
  const h: FakeHook = {
    entries: [], strikes: [], admin: new Set(), commands: [], reports: [], muted: new Map(), strikeNotice: null, asyncReply: false, alerts: [],
    logChat: (e) => { h.entries.push(e); },
    isMuted: (u) => h.muted.get(u.playerId) ?? null,
    onStrike: (u, r) => { h.strikes.push([u, r]); return h.strikeNotice; },
    isAdmin: (u) => !!u.accountId && h.admin.has(u.accountId),
    adminCommand: (u, cmd, args) => {
      h.commands.push([cmd, args]);
      const lines = [`did ${cmd} ${args.join(' ')} for ${u.name}`];
      return h.asyncReply ? Promise.resolve(lines) : lines;
    },
    report: (u, target, reason, ctx) => { h.reports.push([u.name, target, reason, ctx.roomName]); return ['Report sent — thank you.']; },
    alert: (u, kind) => { h.alerts.push([u.name, kind]); },
  };
  return h;
}

function mkZone(opts: { local?: boolean; hook?: ModerationHook; chatFilter?: 'strict' | 'standard' } = {}): Zone {
  return new Zone({
    snapshotEvery: 3, motd: 'hi', local: opts.local ?? false, moderation: opts.hook, chatFilter: opts.chatFilter,
    defaultRooms: [{ name: 'Main Arena', mode: 'teams', teamCount: 2, botFill: 0 }],
  });
}

function join(zone: Zone, name: string, account: AccountInfo | null = null, address: string | null = '10.0.0.1'): FakeClient {
  const c = new FakeClient();
  c.conn = zone.connect(c);
  c.conn.setAccount(account);
  c.conn.setAddress(address);
  c.send({ type: 'hello', name, protocol: PROTOCOL_VERSION, version: 'test', token: account ? 'tok' : undefined });
  return c;
}

const chat = (c: FakeClient, text: string, channel: 'all' | 'team' = 'all'): void => c.send({ type: 'chat', channel, text });

function joinMainRoom(zone: Zone, c: FakeClient): void {
  const id = c.last('roomList').rooms.find((r) => r.name === 'Main Arena')!.id;
  c.send({ type: 'joinRoom', roomId: id });
}

// allowChat: 5 lines / 5 s per pilot — tests that send many lines advance the clock.
afterEach(() => { vi.useRealTimers(); filterState.throwOnChat = false; filterState.lastOpts = []; });
function spaced(): void { vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] }); }
const tick = (ms = 1100): void => { vi.setSystemTime(Date.now() + ms); };

describe('word filter on chat (no hook: offline / filter only)', () => {
  it('zone lobby: pass is broadcast, block is withheld with a private notice, mask is starred for everyone', () => {
    for (const local of [true, false]) {
      const zone = mkZone({ local });
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

  it('room chat (all + team, and the // prefix): blocked lines never reach anyone, masked lines are starred', () => {
    const zone = mkZone({ local: false });
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

  it('a throwing filter fails closed (the line is blocked)', () => {
    const zone = mkZone();
    const a = join(zone, 'Ace');
    const b = join(zone, 'Bee');
    filterState.throwOnChat = true;
    chat(a, 'perfectly fine');
    expect(b.said('perfectly fine')).toBe(false);
    expect(a.systemTexts()).toContain(MSG_BLOCKED);
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
    expect(g.name).toMatch(/^Pilot\d{4}$/);
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
  it('logs every human line (zone + room) with who / where / what was shown', () => {
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    const a = join(zone, 'Ace', acct('Ace'), '203.0.113.7');
    const b = join(zone, 'Bee', null, '203.0.113.8');
    chat(a, 'hi all');
    chat(b, 'darn');
    joinMainRoom(zone, a);
    chat(a, 'badword');
    expect(h.entries.map((e) => [e.roomId === null ? 'zone' : 'room', e.name, e.original, e.shown, e.action])).toEqual([
      ['zone', 'Ace', 'hi all', 'hi all', 'pass'],
      ['zone', 'Bee', 'darn', '****', 'mask'],
      ['room', 'Ace', 'badword', '', 'block'],
    ]);
    const [z, , r] = h.entries;
    expect(z).toMatchObject({ roomName: 'Zone', channel: 'all', accountId: 'acc-Ace', address: '203.0.113.7', playerId: a.pid });
    expect(h.entries[1]).toMatchObject({ accountId: null, address: '203.0.113.8', hits: ['test:mask'] });
    expect(r).toMatchObject({ roomName: 'Main Arena', hits: ['test:block'] });
    expect(typeof r!.roomId).toBe('string');
    // commands are not chat
    chat(a, '/help');
    expect(h.entries).toHaveLength(3);
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
    // a self-harm statement mixed with other blocked language: a strike for the language AND a moderator alert
    const c = join(zone, 'Cee');
    tick(); chat(c, 'mixedword');
    expect(h.strikes.at(-1)).toMatchObject([{ name: 'Cee' }, 'language']);
    expect(h.alerts.at(-1)).toEqual(['Cee', 'selfharm']);
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

  it('self-harm statements are withheld without a strike (a kind note; the host is told); threats are strikes', () => {
    const h = fakeHook();
    const zone = mkZone({ hook: h });
    const a = join(zone, 'Ace');
    const b = join(zone, 'Bee');
    chat(a, 'sadword');
    expect(a.systemTexts()).toContain(MSG_CARE);
    expect(a.systemTexts()).not.toContain(MSG_BLOCKED);
    expect(b.of('chat').some((c) => c.line.text.includes('sadword'))).toBe(false);
    expect(h.strikes.map(([, r]) => r)).toEqual(['selfharm']);
    expect(h.entries.at(-1)).toMatchObject({ action: 'block', hits: ['selfharm:sadword'] });
    chat(a, 'threatword');
    expect(h.strikes.map(([, r]) => r)).toEqual(['selfharm', 'threat']);
    expect(a.systemTexts().at(-1)).toBe(MSG_BLOCKED);
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
