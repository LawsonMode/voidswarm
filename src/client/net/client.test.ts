// GameClient + helpers: connect supersession (F10), bounded event queue (NET-6/PERF-1),
// one pick per offer with offerId (F3/NET-7).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROOM_SETTINGS, type ClientMsg, type ServerMsg } from '../../shared/protocol';
import { WS_CLOSE_KICKED } from '../../shared/net/closeCodes';
import type { GameEvent, ShipView, Snapshot, UpgradeChoice, YouState } from '../../shared/types';
import { EventQueue, MAX_BATCHES, RELEASE_MS, STALE_MS } from './eventQueue';
import { ConnectSuperseded, GameClient } from './GameClient';
import type { Transport } from './transport';
import { NEXT_OFFER_ARM_MS, PICK_RETRY_MS, UpgradePickGuard } from './upgradePick';

class FakeTransport implements Transport {
  readonly kind = 'online' as const;
  onMessage: ((msg: ServerMsg) => void) | null = null;
  onSnapshot: ((s: Snapshot) => void) | null = null;
  onClose: ((reason: string, code?: number) => void) | null = null;
  sent: ClientMsg[] = [];
  closed = false;
  private resolveOpen: (() => void) | null = null;
  private rejectOpen: ((e: Error) => void) | null = null;
  connect(): Promise<void> {
    return new Promise((res, rej) => { this.resolveOpen = res; this.rejectOpen = rej; });
  }
  open(): void { this.resolveOpen?.(); }
  welcome(playerId: number): void {
    this.onMessage?.({ type: 'welcome', playerId, name: 'p', serverVersion: 'x', motd: '', account: null });
  }
  send(msg: ClientMsg): void { this.sent.push(msg); }
  close(): void {
    this.closed = true;
    // like a browser WebSocket closed while CONNECTING: the pending connect() fails
    this.rejectOpen?.(new Error('closed (1006)'));
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('GameClient connect attempts (F10)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('a second connect while the first is still opening supersedes it without breaking the second', async () => {
    const c = new GameClient(null);
    const t1 = new FakeTransport(), t2 = new FakeTransport();
    const p1 = c.connectTransport(t1, 'a');
    const p2 = c.connectTransport(t2, 'a');
    await expect(p1).rejects.toBeInstanceOf(ConnectSuperseded);
    expect(t1.closed).toBe(true);
    t2.open();
    await flush();
    t2.welcome(7);
    await p2;
    expect(c.connected && c.welcomed).toBe(true);
    expect(c.playerId).toBe(7);
    expect(t2.closed).toBe(false);
    c.disconnect(true);
  });

  it('a superseded attempt waiting for welcome never installs a second ping timer', async () => {
    vi.useFakeTimers();
    const c = new GameClient(null);
    const t1 = new FakeTransport(), t2 = new FakeTransport();
    const p1 = c.connectTransport(t1, 'a');
    t1.open();
    await vi.advanceTimersByTimeAsync(0);
    const p2 = c.connectTransport(t2, 'a'); // t1 is open and waiting for welcome
    await expect(p1).rejects.toBeInstanceOf(ConnectSuperseded);
    t2.open();
    await vi.advanceTimersByTimeAsync(0);
    t2.welcome(3);
    await p2;
    const pings = () => t2.sent.filter((m) => m.type === 'ping').length;
    const before = pings();
    await vi.advanceTimersByTimeAsync(2000 * 5 + 10);
    expect(pings() - before).toBe(5); // one interval, not two
    c.disconnect(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(t1.sent.filter((m) => m.type === 'ping').length).toBe(0);
  });

  it('disconnect() during a connect settles it at once as superseded', async () => {
    const c = new GameClient(null);
    const t = new FakeTransport();
    const p = c.connectTransport(t, 'a');
    t.open();
    await flush();
    c.disconnect(true);
    await expect(p).rejects.toBeInstanceOf(ConnectSuperseded);
  });
});

describe('EventQueue (NET-6 / PERF-1)', () => {
  const ev = (n: number): GameEvent[] => [{ t: 'waveStart', wave: n, boss: false } as unknown as GameEvent];

  it('releases by render tick or after RELEASE_MS, once each', () => {
    const q = new EventQueue();
    q.push(10, 0, ev(1));
    q.push(13, 0, ev(2));
    expect(q.drain(9, 10)).toEqual([]);
    expect(q.drain(10, 20)).toEqual(ev(1));
    expect(q.drain(10, RELEASE_MS + 1)).toEqual(ev(2));
    expect(q.drain(99, RELEASE_MS + 2)).toEqual([]);
  });

  it('stays bounded while frames are not drawn (hidden tab) and drops stale batches instead of flooding', () => {
    const q = new EventQueue();
    // 10 minutes of 20 Hz snapshots with nobody draining
    for (let i = 0; i < 20 * 600; i++) q.push(i * 3, i * 50, ev(i));
    expect(q.size).toBeLessThanOrEqual(Math.ceil(STALE_MS / 50) + 1);
    // back in the foreground much later: nothing that old is played
    expect(q.drain(20 * 600 * 3, 20 * 600 * 50 + STALE_MS + 1)).toEqual([]);
    // offline (60 Hz) is capped by count too
    const q2 = new EventQueue();
    for (let i = 0; i < 1000; i++) q2.push(i, 0, ev(i));
    expect(q2.size).toBe(MAX_BATCHES);
  });

  it('is cleared with the match', () => {
    const c = new GameClient(null) as unknown as { events: EventQueue; handleSnapshot(s: Snapshot): void; endMatch(): void; matchActive: boolean };
    c.matchActive = true;
    c.handleSnapshot({ tick: 3, ackSeq: 0, you: null, ships: [], enemies: [], projectiles: [], gems: [], deployables: [], events: ev(1), match: {} as Snapshot['match'] });
    expect(c.events.size).toBe(1);
    c.endMatch();
    expect(c.events.size).toBe(0);
  });
});

describe('UpgradePickGuard (F3 / NET-7)', () => {
  const card = (id: string): UpgradeChoice => ({ id, name: id, icon: '', description: '', level: 1, maxLevel: 5, category: 'passive' } as UpgradeChoice);
  const you = (offerId: number, ids = ['a', 'b', 'c']): YouState =>
    ({ shipId: 5, offerId, offer: ids.map(card), queuedOffers: 1 } as unknown as YouState);

  it('sends one pick per offer, with its offerId, until a new offer shows up', () => {
    const g = new UpgradePickGuard();
    expect(g.pick(you(4), 0, 0)).toEqual({ type: 'chooseUpgrade', index: 0, offerId: 4 });
    // double-click / "1 then 2" before the next snapshot: nothing more is sent
    expect(g.pick(you(4), 0, 30)).toBeNull();
    expect(g.pick(you(4), 1, 60)).toBeNull();
    expect(g.pickedFor(you(4))).toBe(0);
    // the next (queued) offer arrives: it can be picked, and nothing is marked on it yet
    expect(g.pickedFor(you(5, ['path:ram', 'path:barrage', 'path:bulwark']))).toBe(-1);
    // ...but not by the same double-tap: the next offer's cards arm NEXT_OFFER_ARM_MS after the last pick
    expect(g.pick(you(5, ['path:ram', 'path:barrage', 'path:bulwark']), 2, 90)).toBeNull();
    expect(g.pick(you(5, ['path:ram', 'path:barrage', 'path:bulwark']), 2, NEXT_OFFER_ARM_MS + 1)).toEqual({ type: 'chooseUpgrade', index: 2, offerId: 5 });
  });

  it('allows a retry for the same offer after a while (lost / refused pick) — the server offerId check keeps it safe', () => {
    const g = new UpgradePickGuard();
    g.pick(you(1), 1, 0);
    expect(g.pick(you(1), 1, PICK_RETRY_MS + 1)).toEqual({ type: 'chooseUpgrade', index: 1, offerId: 1 });
  });

  it('ignores bad indices and missing offers; reset() forgets (new match)', () => {
    const g = new UpgradePickGuard();
    expect(g.pick(null, 0, 0)).toBeNull();
    expect(g.pick({ ...you(1), offer: null } as YouState, 0, 0)).toBeNull();
    expect(g.pick(you(1), 3, 0)).toBeNull();
    expect(g.pick(you(1), -1, 0)).toBeNull();
    g.pick(you(1), 0, 0);
    g.reset();
    expect(g.pick(you(1), 0, 1)).not.toBeNull();
  });

  it('GameClient.chooseUpgrade de-dupes against the snapshot offer', () => {
    const c = new GameClient(null);
    const sent: ClientMsg[] = [];
    (c as unknown as { transport: Partial<Transport> }).transport = { send: (m: ClientMsg) => sent.push(m) };
    c.matchActive = true;
    c.latest = { you: you(9) } as unknown as Snapshot;
    expect(c.chooseUpgrade(0, 0)).toBe(true);
    expect(c.chooseUpgrade(1, 10)).toBe(false);
    expect(sent).toEqual([{ type: 'chooseUpgrade', index: 0, offerId: 9 }]);
    expect(c.pickedUpgrade).toBe(0);
  });
});

describe('NET-1: GameClient mirrors its spectate target to the server', () => {
  const view = (id: number, alive = true): ShipView => ({
    id, playerId: id, team: 0, shipClass: 'brute', x: id * 100, y: 100, vx: 0, vy: 0, angle: 0, energyFrac: 1, alive,
    attachedTo: 0, turretSlot: -1, turretCount: 0, flags: 0, level: 1, orbitals: 0, pathIdx: -1, beamLen: 0, beamKind: 0, resonance: 1,
  });
  const snapAt = (tick: number, ships: ShipView[]): Snapshot => ({
    tick, ackSeq: 0, you: null, ships, enemies: [], projectiles: [], gems: [], deployables: [], events: [],
    match: { phase: 'playing', mode: 'teams', teamCount: 2, timeLeftSec: 600, teamScores: [0, 0], wave: 0, winnerTeam: -1, winnerPlayerId: 0 },
  });
  type Internals = { transport: Partial<Transport>; handleSnapshot(s: Snapshot): void; handleMsg(m: ServerMsg): void };

  function spectator() {
    const c = new GameClient(null);
    const sent: ClientMsg[] = [];
    const inner = c as unknown as Internals;
    inner.transport = { send: (m: ClientMsg) => { sent.push(m); } };
    c.matchActive = true; // watching a running match without a ship (matchStart with yourShipId 0)
    const feed = (tick: number, ships: ShipView[]) => {
      inner.handleSnapshot(snapAt(tick, ships));
      return c.buildFrame(performance.now(), 0, 1 / 60, 0, 0, 0);
    };
    const targets = () => sent.flatMap((m) => (m.type === 'spectate' ? [m.shipId] : []));
    return { c, inner, feed, targets };
  }

  it('sends the automatic target, each manual cycle, the fallback when the target dies, and 0 on leaving spectate', () => {
    const { c, inner, feed, targets } = spectator();
    expect(feed(100, [view(1), view(2), view(3)])!.focusX).toBe(100);
    expect(targets()).toEqual([1]); // the default target is announced
    feed(200, [view(1), view(2), view(3)]);
    expect(targets()).toEqual([1]); // unchanged: nothing more is sent
    c.cycleSpectate();
    expect(c.spectateId).toBe(2);
    c.cycleSpectate();
    expect(targets()).toEqual([1, 2, 3]);
    feed(300, [view(1), view(2), view(3, false)]);
    expect(c.spectateId).toBe(1); // the target died: automatic fallback...
    expect(targets()).toEqual([1, 2, 3, 1]); // ...which the server hears about too
    feed(400, [view(1, false), view(2, false), view(3, false)]);
    expect(targets()).toEqual([1, 2, 3, 1, 0]); // nobody left to follow: server default
    feed(500, [view(1), view(2), view(3)]);
    expect(targets()).toEqual([1, 2, 3, 1, 0, 1]);
    // leaving spectate (a matchStart with our new ship): cleared once, then nothing while flying
    inner.handleMsg({
      type: 'matchStart', mapSeed: 1, mode: 'teams', teamCount: 2, gameType: 'warzone', subMode: 'deathmatch', floor: 0,
      yourShipId: 3, tick: 500, snapshotEvery: 3,
    });
    expect(targets()).toEqual([1, 2, 3, 1, 0, 1, 0]);
    expect(c.spectateId).toBe(0);
    feed(600, [view(1), view(2), view(3)]);
    feed(700, [view(1), view(3)]);
    expect(targets()).toEqual([1, 2, 3, 1, 0, 1, 0]);
  });

  it('nothing is sent while not in a match', () => {
    const { c, targets } = spectator();
    c.matchActive = false;
    c.cycleSpectate();
    expect(targets()).toEqual([]);
  });
});

describe('server kicks (ws close 4001)', () => {
  async function connected() {
    const c = new GameClient(null);
    const t = new FakeTransport();
    const p = c.connectTransport(t, 'a');
    t.open();
    await flush();
    t.welcome(5);
    await p;
    const closes: string[] = [];
    c.on('close', (r) => closes.push(r));
    return { c, t, closes };
  }

  it('a 4001 close is flagged as the server ending the session, with its message', async () => {
    const { c, t, closes } = await connected();
    t.onClose!('Session ended — please log in again', WS_CLOSE_KICKED);
    expect(c.closeKicked).toBe(true);
    expect(closes).toEqual(['Session ended — please log in again']);
    expect(c.connected).toBe(false);
    // the next connection starts unflagged
    const t2 = new FakeTransport();
    const p2 = c.connectTransport(t2, 'a');
    expect(c.closeKicked).toBe(false);
    t2.open();
    await flush();
    t2.welcome(6);
    await p2;
    c.disconnect(true);
  });

  it('an ordinary drop is not a kick', async () => {
    const { c, t, closes } = await connected();
    t.onClose!('Connection lost (code 1006)', 1006);
    expect(c.closeKicked).toBe(false);
    expect(closes).toEqual(['Connection lost (code 1006)']);
  });
});

describe('v0.3 Command senders + room list', () => {
  class OfflineFake extends FakeTransport {
    // LocalTransport's kind: GameClient derives `offline` from it.
    override readonly kind = 'offline' as unknown as 'online';
  }
  const summary = (id: string) => ({
    id, name: id, mode: 'teams', teamCount: 2, phase: 'lobby', humans: 0, bots: 12, maxPlayers: 32, gameType: 'warzone',
    subMode: 'deathmatch', pveIntensity: 2, floors: 0, house: true, hostName: '', spectators: 0, joinable: true,
    watchable: false, startsInSec: 0, live: null,
  }) as const;

  async function connectedVia(t: FakeTransport) {
    const c = new GameClient(null);
    const p = c.connectTransport(t, 'a');
    t.open();
    await flush();
    t.welcome(5);
    await p;
    return c;
  }

  it('offline no longer auto-joins the first room: it lands on Command; online + roomsAt are stored', async () => {
    const t = new OfflineFake();
    const c = await connectedVia(t);
    expect(c.offline).toBe(true);
    const before = performance.now();
    t.onMessage!({ type: 'roomList', rooms: [summary('h1'), summary('h2')], online: 1 });
    expect(t.sent.some((m) => m.type === 'joinRoom')).toBe(false);
    expect(c.roomId).toBeNull();
    expect(c.rooms.map((r) => r.id)).toEqual(['h1', 'h2']);
    expect(c.online).toBe(1);
    expect(c.roomsAt).toBeGreaterThanOrEqual(before);
    expect(c.roomsAt).toBeLessThanOrEqual(performance.now());
    // the next session starts from scratch
    const t2 = new OfflineFake();
    const p2 = c.connectTransport(t2, 'a');
    expect(c.online).toBe(0);
    expect(c.rooms).toEqual([]);
    t2.open();
    await flush();
    t2.welcome(6);
    await p2;
    c.disconnect(true);
  });

  it('quickPlay / joinRoom send the v0.3 shapes (intent only when given)', async () => {
    const t = new FakeTransport();
    const c = await connectedVia(t);
    t.sent.length = 0;
    c.quickPlay('arena');
    c.quickPlay('warzone', 'deathmatch');
    c.joinRoom('r7');
    c.joinRoom('r7', 'play');
    c.joinRoom('r8', 'watch');
    expect(t.sent).toEqual([
      { type: 'quickPlay', gameType: 'arena' },
      { type: 'quickPlay', gameType: 'warzone', subMode: 'deathmatch' },
      { type: 'joinRoom', roomId: 'r7' },
      { type: 'joinRoom', roomId: 'r7', intent: 'play' },
      { type: 'joinRoom', roomId: 'r8', intent: 'watch' },
    ]);
    c.disconnect(true);
  });
});

describe('v0.3 M1: joining a room whose match is already running', () => {
  async function connected() {
    const t = new FakeTransport();
    const c = new GameClient(null);
    const p = c.connectTransport(t, 'a');
    t.open();
    await flush();
    t.welcome(5);
    await p;
    return { c, t };
  }
  const line = (text: string) => ({ fromPlayerId: 0, fromName: '', channel: 'system' as const, team: -1, text, time: 1 });
  const roomState = (roomId: string | null, phase: 'lobby' | 'playing' = 'playing'): ServerMsg => ({
    type: 'roomState', roomId, phase, settings: { ...DEFAULT_ROOM_SETTINGS }, players: [], hostPlayerId: 0, countdown: 0,
  });
  const matchStart: ServerMsg = {
    type: 'matchStart', mapSeed: 7, mode: 'teams', teamCount: 2, gameType: 'warzone', subMode: 'deathmatch', floor: 0,
    yourShipId: 9, tick: 100, snapshotEvery: 3,
  };

  it('the server order (roomState, history, tells, matchStart) enters the match with the room chat', async () => {
    const { c, t } = await connected();
    t.onMessage!(roomState(null, 'lobby'));
    t.onMessage!({ type: 'chatHistory', lines: [line('zone line')] });
    t.onMessage!(roomState('r1'));
    t.onMessage!({ type: 'chatHistory', lines: [line('room history')] });
    t.onMessage!({ type: 'chat', line: line('Ace joined the room.') });
    t.onMessage!(matchStart);
    t.onMessage!(roomState('r1'));
    expect(c.matchActive).toBe(true);
    expect(c.yourShipId).toBe(9);
    expect(c.chat.map((l) => l.text)).toEqual(['room history', 'Ace joined the room.']);
    // back to Command: the match ends and the zone log is back
    t.onMessage!(roomState(null, 'lobby'));
    expect(c.matchActive).toBe(false);
    expect(c.chat.map((l) => l.text)).toEqual(['zone line']);
    c.disconnect(true);
  });

  it('defensive: a matchStart that beat its roomState (pre-fix server order) is kept, not dropped', async () => {
    const { c, t } = await connected();
    t.onMessage!(roomState(null, 'lobby'));
    t.onMessage!({ type: 'chatHistory', lines: [line('room history')] });
    t.onMessage!({ type: 'chat', line: line('Ace joined the room.') });
    t.onMessage!(matchStart);
    t.onMessage!({ type: 'chat', line: line('Ace dropped in.') });
    t.onMessage!(roomState('r1'));
    expect(c.roomId).toBe('r1');
    expect(c.matchActive).toBe(true);
    expect(c.yourShipId).toBe(9);
    // ...but only for the first roomState after it: a later room switch still ends the match
    t.onMessage!(roomState('r2', 'lobby'));
    expect(c.matchActive).toBe(false);
    c.disconnect(true);
  });

  it('a room switch without such a matchStart still ends the old match', async () => {
    const { c, t } = await connected();
    t.onMessage!(roomState('r1'));
    t.onMessage!(matchStart);
    expect(c.matchActive).toBe(true);
    t.onMessage!(roomState('r2', 'lobby'));
    expect(c.matchActive).toBe(false);
    c.disconnect(true);
  });
});
