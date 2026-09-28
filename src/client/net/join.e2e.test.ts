// v0.3 M1 end to end: real Zone / Room / Sim / bots + real GameClients over an in-process transport that
// runs every client message through validate.ts (+ JSON) and every snapshot through the binary codec, like
// the ws server. Covers Command's Join (play), Watch and Quick Play into a LIVE match (the join-order
// blocker: the joiner's roomState must come before its matchStart), the room chat on join, and fix #2's
// reverse order (watch first, then a pilot from the same network drops in).
import { afterEach, describe, expect, it } from 'vitest';
import { COUNTDOWN_SEC, SNAPSHOT_EVERY_ONLINE, TICK_RATE } from '../../shared/constants';
import { decodeSnapshot, encodeSnapshot } from '../../shared/net/codec';
import { validateClientMsg } from '../../shared/net/validate';
import type { ClientMsg, ServerMsg } from '../../shared/protocol';
import { houseRooms } from '../../shared/room/houseRooms';
import { WATCH_SAME_NETWORK_MSG } from '../../shared/room/Room';
import { Zone, type ZoneConnection } from '../../shared/room/Zone';
import type { Snapshot } from '../../shared/types';
import { GameClient } from './GameClient';
import type { Transport } from './transport';

/** In-process "network": async delivery (microtasks), JSON + validate.ts upstream, codec downstream. */
class ZoneTransport implements Transport {
  onMessage: ((m: ServerMsg) => void) | null = null;
  onSnapshot: ((s: Snapshot) => void) | null = null;
  onClose: ((r: string, c?: number) => void) | null = null;
  conn: ZoneConnection | null = null;
  /** Server → client message types in arrival order. */
  order: string[] = [];
  constructor(private zone: Zone, private address: string | null, readonly kind: 'online' | 'offline' = 'online') {}
  async connect(): Promise<void> {
    this.conn = this.zone.connect({
      sendMsg: (m) => { const j = JSON.stringify(m); queueMicrotask(() => { this.order.push(m.type); this.onMessage?.(JSON.parse(j)); }); },
      sendSnapshot: (s) => { const b = encodeSnapshot(s); queueMicrotask(() => this.onSnapshot?.(decodeSnapshot(b))); },
      close: (r) => queueMicrotask(() => this.onClose?.(r, 4001)),
    });
    this.conn.setAddress(this.address);
  }
  send(m: ClientMsg): void {
    const v = validateClientMsg(JSON.parse(JSON.stringify(m)));
    if (!v) throw new Error(`validate.ts rejected ${JSON.stringify(m)}`);
    queueMicrotask(() => this.conn?.handle(v));
  }
  close(): void { this.conn?.close(); this.conn = null; }
}

const flush = async (): Promise<void> => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
const clients: GameClient[] = [];
afterEach(() => { for (const c of clients.splice(0)) c.disconnect(true); });

async function pilot(zone: Zone, name: string, address: string | null, kind: 'online' | 'offline' = 'online') {
  const c = new GameClient(null);
  clients.push(c);
  const t = new ZoneTransport(zone, address, kind);
  await c.connectTransport(t, name);
  await flush();
  return { c, t, system: () => c.chat.filter((l) => l.channel === 'system').map((l) => l.text) };
}

async function ticks(zone: Zone, n: number): Promise<void> {
  for (let i = 0; i < n; i++) zone.tick();
  await flush();
}

/** An online zone with its house rooms and one running Warzone Classic match (flown by `host`). */
async function liveWarzone(blockSameNetworkWatch = false) {
  const zone = new Zone({ snapshotEvery: SNAPSHOT_EVERY_ONLINE, local: false, defaultRooms: houseRooms(false), motd: 'e2e', blockSameNetworkWatch });
  const host = await pilot(zone, 'Host', '10.0.0.1');
  const room = host.c.rooms.find((r) => r.name === 'Warzone Classic')!;
  host.c.joinRoom(room.id);
  await flush();
  host.c.send({ type: 'startMatch' });
  await flush();
  await ticks(zone, COUNTDOWN_SEC * TICK_RATE + 2);
  expect(host.c.matchActive).toBe(true);
  return { zone, host, roomId: room.id };
}

describe('v0.3 M1 e2e: Join / Watch / Quick Play into a live match reach the game screen', () => {
  it('Watch: roomState arrives before matchStart; the client stays in the match and gets snapshots', async () => {
    const { zone, roomId } = await liveWarzone();
    const w = await pilot(zone, 'Watcher', '10.0.0.2');
    w.t.order.length = 0;
    w.c.joinRoom(roomId, 'watch');
    await flush();
    expect(w.t.order.indexOf('roomState')).toBeGreaterThanOrEqual(0);
    expect(w.t.order.indexOf('roomState')).toBeLessThan(w.t.order.indexOf('chatHistory'));
    expect(w.t.order.indexOf('roomState')).toBeLessThan(w.t.order.indexOf('matchStart'));
    expect(w.c.roomId).toBe(roomId);
    expect(w.c.matchActive).toBe(true);
    expect(w.c.yourShipId).toBe(0);
    await ticks(zone, 12);
    expect(w.c.matchActive).toBe(true);
    expect(w.c.latest).not.toBeNull();
    expect(w.c.latest!.you).toBeNull();
    // the room's join-time chat landed in the ROOM log (not the zone log), e.g. the Watch tell
    expect(w.system().some((t) => t.startsWith('Watching Warzone Classic'))).toBe(true);
  });

  it('Join (play): drops straight in with a ship; the room log keeps its join lines', async () => {
    const { zone, roomId } = await liveWarzone();
    const p = await pilot(zone, 'Joiner', '10.0.0.3');
    p.c.joinRoom(roomId, 'play');
    await flush();
    expect(p.c.roomId).toBe(roomId);
    expect(p.c.matchActive).toBe(true);
    expect(p.c.yourShipId).toBeGreaterThan(0);
    await ticks(zone, 12);
    expect(p.c.latest?.you?.shipId).toBe(p.c.yourShipId);
    expect(p.system()).toContain('Joiner joined the room.');
    expect(p.system().some((t) => t.startsWith('Joiner dropped in for'))).toBe(true);
  });

  it('Quick Play into the live room: game screen at once, and the Quick Play line is in the room chat', async () => {
    const { zone, roomId } = await liveWarzone();
    const q = await pilot(zone, 'Quick', '10.0.0.4');
    q.c.quickPlay('warzone');
    await flush();
    expect(q.c.roomId).toBe(roomId);
    expect(q.c.matchActive).toBe(true);
    expect(q.c.yourShipId).toBeGreaterThan(0);
    expect(q.system().some((t) => t.startsWith('Quick Play → Warzone Classic (Classic). Dropping in'))).toBe(true);
    await ticks(zone, 12);
    expect(q.c.latest?.you?.shipId).toBe(q.c.yourShipId);
  });

  it('offline: Join (play) on the live house room after going back to Command re-enters the match', async () => {
    const zone = new Zone({ snapshotEvery: 1, local: true, defaultRooms: houseRooms(true), motd: 'e2e' });
    const s = await pilot(zone, 'Solo', null, 'offline');
    s.c.quickPlay('warzone');
    await flush();
    await ticks(zone, COUNTDOWN_SEC * TICK_RATE + 2);
    expect(s.c.matchActive).toBe(true);
    const roomId = s.c.roomId!;
    s.c.send({ type: 'leaveRoom' });
    await flush();
    expect(s.c.roomId).toBeNull();
    expect(s.c.matchActive).toBe(false);
    s.c.joinRoom(roomId, 'play'); // the Command row's JOIN on a playing room
    await flush();
    expect(s.c.roomId).toBe(roomId);
    expect(s.c.matchActive).toBe(true); // spectating out the SEC-2 rejoin delay, then the ship drops in
    await ticks(zone, 5 * TICK_RATE);
    expect(s.c.matchActive).toBe(true);
    expect(s.c.latest?.you?.shipId).toBeGreaterThan(0);
  });
});

describe('v0.3 M1 e2e: fix #2 reverse order (watch first, then fly from the same network)', () => {
  it('the watcher loses the feed and lands on Command; a watcher from another network keeps watching', async () => {
    const { zone, roomId } = await liveWarzone(true);
    const ghost = await pilot(zone, 'Ghost', '203.0.113.9');
    const other = await pilot(zone, 'Other', '198.51.100.7');
    ghost.c.joinRoom(roomId, 'watch');
    other.c.joinRoom(roomId, 'watch');
    await flush();
    await ticks(zone, 6);
    expect(ghost.c.matchActive).toBe(true);
    const twin = await pilot(zone, 'Twin', '203.0.113.9');
    twin.c.joinRoom(roomId, 'play');
    await flush();
    expect(twin.c.matchActive).toBe(true);
    expect(twin.c.yourShipId).toBeGreaterThan(0);
    expect(ghost.c.roomId).toBeNull();
    expect(ghost.c.matchActive).toBe(false);
    expect(ghost.system()).toContain(WATCH_SAME_NETWORK_MSG);
    // and can't come back to watch while the twin flies
    ghost.c.joinRoom(roomId, 'watch');
    await flush();
    expect(ghost.c.roomId).toBeNull();
    await ticks(zone, 6);
    expect(other.c.matchActive).toBe(true);
    expect(other.c.roomId).toBe(roomId);
  });
});
