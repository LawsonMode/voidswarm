// v0.6 LAN edition (docs/LAN-EDITION-proposal.md §5.8, §4.1) with the REAL word filter: tags (A1, T-CHAT-2), the
// curated positive lines (A2), the warning steps and the reserved callsigns. Test words come from the filter's own
// lists (stored ROT13 there) and are decoded in memory only: this file holds no offensive term in clear text, and no
// assertion prints one (failures show categories and tags, never the term).
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../sim/Sim', () => ({ Sim: class { constructor() { throw new Error('no sim in chatTags.test'); } } }));
vi.mock('../ai/bots', () => ({ createBotBrain: () => ({ think: () => ({}), chooseUpgrade: () => 0 }) }));

import { checkName, clearCustomTerms, filterChat, setCustomTerms, type Category } from '../moderation/filter';
import { TERM_GROUPS, rot13 } from '../moderation/lists';
import type { ClientMsg, ServerMsg } from '../protocol';
import type { Snapshot } from '../types';
import { PROTOCOL_VERSION } from '../version';
import {
  DEFAULT_POSITIVE_LINES, MSG_CARE, MSG_CARE_NAME, MSG_WARN_AGAIN, MSG_WARN_FIRST, MSG_WARN_LAST, MSG_WARN_MUTED, MSG_WARN_SECOND,
  POSITIVE_LINE_MAX_LEN, POSITIVE_LINES_MIN, RESERVED_CALLSIGNS, enforcedTagsOf, hitLabel, isReservedCallsign, reservedKey, reservedKeys,
  tagOfCategory, tagsOf, warningText,
  type ChatLogEntry, type ModerationHook, type StrikeDetail,
} from './moderation';
import { sanitizeGuestName } from './util';
import { Zone, type ClientSink, type ZoneConnection } from './Zone';

afterEach(() => { clearCustomTerms(); vi.useRealTimers(); });

/** A term of the built-in `category` that the chat filter reports under it (decoded in memory; never printed). */
function termOf(category: Category, skip = 0): string {
  let seen = 0;
  for (const g of TERM_GROUPS) {
    if (g.category !== category) continue;
    for (const t of g.terms) {
      const term = rot13(t);
      if (!filterChat(`well ${term} then`, { strictness: 'strict' }).hits.some((h) => h.category === category)) continue;
      if (seen++ >= skip) return term;
    }
  }
  throw new Error(`no usable test term for category ${category}`);
}

/**
 * A built-in self-harm term that the NAME check refuses for its self-harm hit only, in guest-callsign form (so the
 * Zone checks exactly this spelling). Decoded in memory; never printed.
 */
function selfHarmCallsign(): string {
  for (const g of TERM_GROUPS) {
    if (g.category !== 'selfharm') continue;
    for (const t of g.terms) {
      const name = sanitizeGuestName(rot13(t));
      if (name !== rot13(t).replace(/\s+/g, '_') || isReservedCallsign(name)) continue;
      const r = checkName(name, { strictness: 'strict' });
      const cats = (r.hits ?? []).map((h) => h.category);
      if (!r.ok && cats.length && cats.every((c) => c === 'selfharm')) return name;
    }
  }
  throw new Error('no usable self-harm callsign');
}

const BUILTIN: Readonly<Record<Category, string>> = {
  profanity: 'PROFANITY', mild: 'PROFANITY', sexual: 'VULGAR', slur: 'HATE', hate: 'HATE', threat: 'THREAT', selfharm: 'SELF-HARM',
};

describe('tags (A1, T-CHAT-2)', () => {
  it('each built-in category maps to its tag (from the filter hits and from the logged labels)', () => {
    for (const [cat, tag] of Object.entries(BUILTIN) as [Category, string][]) {
      const r = filterChat(`well ${termOf(cat)} then`, { strictness: 'strict' });
      const own = r.hits.filter((h) => h.category === cat);
      expect(own.length, cat).toBeGreaterThan(0);
      expect(tagsOf(own), cat).toEqual([tag]);
      expect(tagsOf(own.map(hitLabel)), cat).toEqual([tag]); // ChatLogEntry.hits are labels
      expect(enforcedTagsOf(r.hits), cat).toContain(tag);
      expect(tagOfCategory(cat)).toBe(tag);
    }
  });

  it("custom categories: 'gang' → GANG, 'bullying' → BULLYING, any other label upper-cased; review-only hits tag but don't enforce", () => {
    const r = setCustomTerms([
      { term: 'zorblax', action: 'block', category: 'gang' },
      { term: 'quenth', action: 'mask', category: 'bullying' },
      { term: 'vorpik', action: 'flag', category: 'gang' },
      { term: 'glimmek', action: 'mask', category: 'Crew: North Side!' },
      { term: 'drazzle', action: 'block', category: 'Self-Harm' }, // custom.ts folds it to the built-in meaning
    ]);
    expect(r.ok).toBe(true);
    const tags = (text: string): string[] => tagsOf(filterChat(text).hits);
    expect(tags('zorblax')).toEqual(['GANG']);
    expect(tags('a quenth b')).toEqual(['BULLYING']);
    expect(tags('meet at vorpik')).toEqual(['GANG']);
    expect(enforcedTagsOf(filterChat('meet at vorpik').hits)).toEqual([]); // 'flag' tier: for review only
    expect(tags('glimmek')).toEqual(['CREW NORTH SIDE']);
    expect(tags('drazzle')).toEqual(['SELF-HARM']);
    expect(tagsOf(filterChat('zorblax').hits.map(hitLabel))).toEqual(['GANG']);
    // labels: custom, review-only, no category
    expect(tagsOf(['custom:gang:zorblax', 'flag:bullying:quenth', 'custom:zorb'])).toEqual(['GANG', 'BULLYING', 'CUSTOM']);
    expect(enforcedTagsOf(['custom:gang:zorblax', 'flag:bullying:quenth'])).toEqual(['GANG']);
    // log labels that are not filter hits give no tag
    expect(tagsOf(['filter-error', 'reserved', 'offensive name (profanity)', 'name'])).toEqual([]);
    expect(tagsOf(null)).toEqual([]);
    expect(tagOfCategory('')).toBe('CUSTOM');
    // a host's custom category spelled with spaces, underscores or hyphens is still the wellbeing tag (never a strike tag)
    for (const c of ['self harm', 'self_harm', 'Self-Harm', ' SELF - HARM ']) expect(tagOfCategory(c), c).toBe('SELF-HARM');
    expect(tagOfCategory('local slang')).toBe('LOCAL SLANG');
  });

  it('one tag per category per line, so a store counting tagsOf(entry.hits) bumps conduct_daily once per tag per line', () => {
    const two = `${termOf('profanity')} and ${termOf('profanity', 1)}`;
    const r = filterChat(two, { strictness: 'strict' });
    expect(r.hits.filter((h) => h.category === 'profanity').length).toBeGreaterThanOrEqual(2);
    expect(tagsOf(r.hits)).toEqual(['PROFANITY']);
    expect(tagsOf(['profanity:a', 'mild:b', 'custom:gang:c', 'flag:gang:d', 'profanity:e'])).toEqual(['PROFANITY', 'GANG']);
  });
});

// --- the real filter through the Zone ---

class FakeClient implements ClientSink {
  msgs: ServerMsg[] = [];
  conn!: ZoneConnection;
  sendMsg(m: ServerMsg): void { this.msgs.push(m); }
  sendSnapshot(_s: Snapshot): void { /* no sim */ }
  send(m: ClientMsg): void { this.conn.handle(m); }
  get pid(): number { return (this.msgs.filter((m) => m.type === 'welcome').at(-1) as Extract<ServerMsg, { type: 'welcome' }>).playerId; }
  chats(): Extract<ServerMsg, { type: 'chat' }>[] { return this.msgs.filter((m): m is Extract<ServerMsg, { type: 'chat' }> => m.type === 'chat'); }
}

function rig(): { zone: Zone; a: FakeClient; b: FakeClient; entries: ChatLogEntry[]; strikes: (StrikeDetail | undefined)[]; alerts: string[] } {
  const entries: ChatLogEntry[] = [];
  const strikes: (StrikeDetail | undefined)[] = [];
  const alerts: string[] = [];
  const hook: ModerationHook = {
    logChat: (e) => { entries.push(e); },
    isMuted: () => null,
    onStrike: (_u, _r, d) => { strikes.push(d); return null; },
    isAdmin: () => false,
    adminCommand: () => [],
    report: () => [],
    alert: (_u, kind) => { alerts.push(kind); },
  };
  const zone = new Zone({ snapshotEvery: 3, motd: '', local: false, moderation: hook, defaultRooms: [{ name: 'Main', botFill: 0 }] });
  const mk = (name: string): FakeClient => {
    const c = new FakeClient();
    c.conn = zone.connect(c);
    c.conn.setAccount({ accountId: `acc-${name}`, username: name, emailMasked: 'x***@y.z', createdAt: 1 });
    c.send({ type: 'hello', name, protocol: PROTOCOL_VERSION, version: 'test', token: 'tok' });
    return c;
  };
  return { zone, a: mk('Ace'), b: mk('Bee'), entries, strikes, alerts };
}

describe('the real filter through the Zone', () => {
  it('a confirmed custom GANG term is substituted and struck with GANG; the unconfirmed (flag) one is shown unchanged', () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    setCustomTerms([{ term: 'zorblax', action: 'block', category: 'gang' }, { term: 'vorpik', action: 'flag', category: 'gang' }]);
    const { a, b, entries, strikes } = rig();
    const say = (text: string): void => { vi.setSystemTime(Date.now() + 1100); a.send({ type: 'chat', channel: 'all', text }); };
    say('zorblax crew rules');
    expect(entries.at(-1)).toMatchObject({ action: 'block', display: 'substituted' });
    expect(tagsOf(entries.at(-1)!.hits)).toEqual(['GANG']);
    expect(strikes.at(-1)).toEqual({ tags: ['GANG'], action: 'block' });
    expect(DEFAULT_POSITIVE_LINES).toContain(b.chats().at(-1)!.line.text);
    say('meet at vorpik');
    expect(entries.at(-1)).toMatchObject({ action: 'flag', display: 'as-typed', shown: 'meet at vorpik' });
    expect(tagsOf(entries.at(-1)!.hits)).toEqual(['GANG']);
    expect(strikes).toHaveLength(1);
    expect(b.chats().at(-1)!.line.text).toBe('meet at vorpik');
  });

  it('built-in THREAT: substituted + strike + alert; SELF-HARM: withheld + MSG_CARE + alert, no strike; PROFANITY: substituted', () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    const { a, b, entries, strikes, alerts } = rig();
    const say = (text: string): void => { vi.setSystemTime(Date.now() + 1100); a.send({ type: 'chat', channel: 'all', text }); };
    const seenByB = (): string => b.chats().at(-1)!.line.text;
    say(`well ${termOf('threat')} then`);
    expect(entries.at(-1)!.display).toBe('substituted');
    expect(strikes.at(-1)?.tags).toEqual(['THREAT']);
    expect(alerts).toEqual(['threat']);
    expect(DEFAULT_POSITIVE_LINES.includes(seenByB())).toBe(true);
    const nb = b.chats().length;
    say(`well ${termOf('selfharm')} then`);
    expect(b.chats().length).toBe(nb);
    expect(entries.at(-1)!.display).toBe('withheld');
    expect(a.chats().at(-1)!.line.text).toBe(MSG_CARE);
    expect(strikes).toHaveLength(1);
    expect(alerts).toEqual(['threat', 'selfharm']);
    say(`well ${termOf('profanity')} then`);
    // (fields only: a failing diff of the whole entry would print its original)
    expect([entries.at(-1)!.action, entries.at(-1)!.display]).toEqual(['mask', 'substituted']);
    expect(strikes.at(-1)).toEqual({ tags: ['PROFANITY'], action: 'mask' });
    expect(a.chats().at(-1)!.line.text).toBe(MSG_WARN_SECOND);
    // the sender never received a line from itself for any of them
    expect(a.chats().some((m) => m.line.fromPlayerId === a.pid)).toBe(false);
  });
});

describe('a self-harm term as a name, with the real filter (§5.8, §5.11)', () => {
  it('guest callsign (hello, /name, setName) and room name (create, rename): not used, the kind note, an alert each, no strike', () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    const { zone, entries, strikes, alerts } = rig();
    const bad = selfHarmCallsign();
    const g = new FakeClient();
    g.conn = zone.connect(g);
    g.send({ type: 'hello', name: bad, protocol: PROTOCOL_VERSION, version: 'test' });
    const sys = (): string[] => g.chats().filter((m) => m.line.channel === 'system').map((m) => m.line.text);
    const welcome = g.msgs.filter((m): m is Extract<ServerMsg, { type: 'welcome' }> => m.type === 'welcome').at(-1)!;
    expect(welcome.name === bad).toBe(false); // (a boolean: a failing diff never prints the term)
    expect(sys()).toContain(MSG_CARE_NAME);
    const tries = (): void => {
      vi.setSystemTime(Date.now() + 1100);
      g.send({ type: 'chat', channel: 'all', text: `/name ${bad}` });
      vi.setSystemTime(Date.now() + 1100);
      g.send({ type: 'setName', name: bad });
    };
    tries();
    tries(); // retried: still never a strike, so never an auto-mute for "repeated offensive names"
    g.send({ type: 'createRoom', settings: { name: bad } });
    g.send({ type: 'createRoom', settings: { name: 'Fine Room', botFill: 0 } });
    g.send({ type: 'updateSettings', settings: { name: `${bad} base` } });
    expect(sys().filter((t) => t === MSG_CARE_NAME).length).toBe(7);
    const withheld = entries.filter((e) => e.display === 'withheld');
    expect(withheld.map((e) => e.channel)).toEqual(['name', 'name', 'name', 'name', 'name', 'room', 'room']);
    for (const e of withheld) expect(tagsOf(e.hits)).toEqual(['SELF-HARM']);
    expect(alerts).toEqual(Array(7).fill('selfharm'));
    expect(strikes).toEqual([]);
  });
});

describe('positive lines and warnings (A2)', () => {
  it('the curated list: about 40, unique, each ≤ 60 characters and passing the real filter (strict and standard)', () => {
    expect(DEFAULT_POSITIVE_LINES.length).toBeGreaterThanOrEqual(35);
    expect(DEFAULT_POSITIVE_LINES.length).toBeGreaterThanOrEqual(POSITIVE_LINES_MIN);
    expect(new Set(DEFAULT_POSITIVE_LINES.map((s) => s.toLowerCase())).size).toBe(DEFAULT_POSITIVE_LINES.length);
    for (const s of DEFAULT_POSITIVE_LINES) {
      expect(s.length, s).toBeLessThanOrEqual(POSITIVE_LINE_MAX_LEN);
      expect(s.trim(), s).toBe(s);
      expect(filterChat(s, { strictness: 'strict' }).action, s).toBe('pass');
      expect(filterChat(s, { strictness: 'standard' }).action, s).toBe('pass');
    }
  });

  it('warningText: 1st, 2nd, later; "one more" added at limit − 1; muted at the limit; offline (no limit) never threatens a mute', () => {
    expect([1, 2, 3, 4].map((n) => warningText(n, 5))).toEqual([MSG_WARN_FIRST, MSG_WARN_SECOND, MSG_WARN_AGAIN, `${MSG_WARN_AGAIN} ${MSG_WARN_LAST}`]);
    expect(warningText(5, 5)).toBe(MSG_WARN_MUTED);
    expect([1, 2, 3].map((n) => warningText(n, 3))).toEqual([MSG_WARN_FIRST, `${MSG_WARN_SECOND} ${MSG_WARN_LAST}`, MSG_WARN_MUTED]);
    expect(warningText(1, 2)).toBe(`${MSG_WARN_FIRST} ${MSG_WARN_LAST}`);
    expect([1, 2, 3, 9].map((n) => warningText(n))).toEqual([MSG_WARN_FIRST, MSG_WARN_SECOND, MSG_WARN_AGAIN, MSG_WARN_AGAIN]);
    expect(warningText(Number.NaN)).toBe(MSG_WARN_FIRST);
    for (const w of [MSG_WARN_FIRST, MSG_WARN_SECOND, MSG_WARN_AGAIN, MSG_WARN_LAST, MSG_WARN_MUTED]) {
      expect(filterChat(w, { strictness: 'strict' }).action, w).toBe('pass');
    }
  });
});

describe('reserved callsigns (§4.1)', () => {
  it('the reserved names and their look-alikes; ordinary names that merely contain them are fine', () => {
    for (const n of RESERVED_CALLSIGNS) expect(isReservedCallsign(n), n).toBe(true);
    for (const n of ['host', 'HOST', 'H0st', 'Hоst' /* Cyrillic o */, 'Host_PC', 'Host-PC', 'hostpc', 'Host2', 'Host_007', 'Teach3r',
      'T3ACHER', 'Adm1n', '4dmin', 'M0derator', 'Sys7em', '5erver', 'SERVER99', 'mod',
      // a trailing digit read as a letter, not only as a number (Hos7 = Host)
      'Hos7', 'H0s7', 'H057', 'HOS7', 'Ho57', 'Hos77', 'M0d0', 'Admin_7']) {
      expect(isReservedCallsign(n), n).toBe(true);
    }
    for (const n of ['Hostile', 'Ghost', 'Teach', 'Teachers_Pet', 'Admiral', 'Modesty', 'Servo', 'Systematic', 'Nova', '', '123', 'Pilot4821',
      'Nova7', 'Ghost7', 'Hostile9', 'Hos', 'Teache', 'Mo0', 'Serv', 'Syst3m4tic']) {
      expect(isReservedCallsign(n), n).toBe(false);
    }
    expect(isReservedCallsign('Ms_Rivera', ['ms_rivera'])).toBe(true);
    expect(isReservedCallsign('MsRivera2', ['ms_rivera'])).toBe(true);
    expect(isReservedCallsign('Ms_Riviera', ['ms_rivera'])).toBe(false);
    expect(isReservedCallsign('Ms_Riv3r4', ['ms_rivera'])).toBe(true);
    expect(reservedKey('H0st_PC-2')).toBe('hostpc');
    expect(reservedKey('Hos7')).toBe('hos'); // the plain key drops the number; reservedKeys also reads it as a letter
    expect(reservedKeys('H057')).toEqual(['h', 'ho', 'hos', 'host']);
    expect(reservedKeys('Admin_007')).toEqual(['admin', 'admino', 'adminoo', 'adminoot']);
    expect(reservedKeys('')).toEqual([]);
    expect(reservedKeys(42 as unknown as string)).toEqual([]);
  });
});
