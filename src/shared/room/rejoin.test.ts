// SEC-2 round 2 (free respawn via spectate / leave-room toggles), exercised against the REAL Sim.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COUNTDOWN_SEC, RESPAWN_SEC, RESULTS_SEC, TICK_RATE } from '../constants';
import { TEAM_UNASSIGNED, type AccountInfo, type ClientMsg, type ServerMsg } from '../protocol';
import type { Ship, Snapshot, World } from '../types';
import { PROTOCOL_VERSION } from '../version';
import { Room, TEAM_CHANGE_GAP_SEC } from './Room';
import { Zone, type ClientSink, type ZoneConnection } from './Zone';

class FakeClient implements ClientSink {
  msgs: ServerMsg[] = [];
  conn!: ZoneConnection;
  close(): void { /* not needed */ }
  sendMsg(m: ServerMsg): void { this.msgs.push(m); }
  sendSnapshot(_s: Snapshot): void { /* not needed */ }
  send(m: ClientMsg): void { this.conn.handle(m); }
  of<T extends ServerMsg['type']>(t: T): Extract<ServerMsg, { type: T }>[] {
    return this.msgs.filter((m) => m.type === t) as Extract<ServerMsg, { type: T }>[];
  }
  last<T extends ServerMsg['type']>(t: T): Extract<ServerMsg, { type: T }> { const a = this.of(t); return a[a.length - 1]; }
  chatTexts(): string[] { return this.of('chat').map((c) => c.line.text); }
  get pid(): number { return this.last('welcome').playerId; }
}

const DELAY = RESPAWN_SEC * TICK_RATE;
let now = 1_000_000;

function mkZone(): Zone {
  // No bots and no swarm (v0.3: Arena has none; Warzone's swarm is 1-3): nothing but the test touches the ship.
  return new Zone({
    snapshotEvery: 3, motd: 'hi', local: false,
    defaultRooms: [{ name: 'Main Arena', gameType: 'arena', subMode: 'deathmatch', mode: 'teams', teamCount: 2, botFill: 0 }],
  });
}

function join(zone: Zone, name: string, account: AccountInfo | null = null): FakeClient {
  const c = new FakeClient();
  c.conn = zone.connect(c);
  c.conn.setAccount(account);
  c.conn.setAddress('10.0.0.1');
  c.send({ type: 'hello', name, protocol: PROTOCOL_VERSION, version: 'test', token: account ? 'tok' : undefined });
  return c;
}

/** Advance the zone (and the wall clock the rate limits read) by n ticks. */
function ticks(zone: Zone, n: number): void {
  for (let i = 0; i < n; i++) { now += 1000 / TICK_RATE; vi.setSystemTime(now); zone.tick(); }
}

const roomOf = (zone: Zone): Room => [...(zone as unknown as { rooms: Map<string, Room> }).rooms.values()][0];
const worldOf = (zone: Zone): World => roomOf(zone).sim!.world;
const shipOf = (zone: Zone, c: FakeClient): Ship | undefined => {
  const w = worldOf(zone);
  const id = w.shipsByPlayer.get(c.pid);
  return id ? w.ships.get(id) : undefined;
};
const meIn = (c: FakeClient) => c.last('roomState').players.find((p) => p.playerId === c.pid)!;
const rejoinLine = (c: FakeClient): string | undefined => c.chatTexts().filter((t) => t.startsWith('Rejoining in')).pop();

function playing(zone: Zone, c: FakeClient): void {
  c.send({ type: 'joinRoom', roomId: c.last('roomList').rooms[0].id });
  c.send({ type: 'setTeam', team: 0 });
  c.send({ type: 'startMatch' });
  ticks(zone, COUNTDOWN_SEC * TICK_RATE + 1);
  expect(roomOf(zone).phase).toBe('playing');
  ticks(zone, 10);
}

describe('SEC-2 round 2: leaving the match counts as a death for respawn purposes (real Sim)', () => {
  let zone: Zone;
  let a: FakeClient;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    now = 1_000_000;
    vi.setSystemTime(now);
    zone = mkZone();
    a = join(zone, 'Ace');
    playing(zone, a);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('spectate -> rejoin waits a full respawn delay; the pilot watches meanwhile', () => {
    const s = shipOf(zone, a)!;
    expect(s.alive).toBe(true);
    s.energy = 1; // about to die
    const w = worldOf(zone);
    const left = w.tick;
    a.send({ type: 'setTeam', team: TEAM_UNASSIGNED });
    expect(shipOf(zone, a)).toBeUndefined();
    a.send({ type: 'setTeam', team: 0 });
    expect(shipOf(zone, a)).toBeUndefined(); // no instant fresh ship
    expect(rejoinLine(a)).toBe(`Rejoining in ${RESPAWN_SEC}s — spectating until then.`);
    expect(meIn(a)).toMatchObject({ team: 0, inMatch: false });
    const starts = a.of('matchStart').length;
    ticks(zone, DELAY / 2);
    a.send({ type: 'joinMatch' }); // asking again changes nothing
    a.send({ type: 'setTeam', team: 0 });
    expect(shipOf(zone, a)).toBeUndefined();
    ticks(zone, DELAY / 2 - 1);
    expect(shipOf(zone, a)).toBeUndefined();
    ticks(zone, 1); // the step on which a ship that died when they left would respawn
    const back = shipOf(zone, a)!;
    expect(back).toBeDefined();
    expect(back.id).not.toBe(s.id);
    expect(a.of('matchStart')).toHaveLength(starts + 1);
    expect(a.last('matchStart').yourShipId).toBe(back.id);
    expect(meIn(a)).toMatchObject({ team: 0, inMatch: true });
    // the new ship's first step is a full respawn delay after leaving — never earlier
    ticks(zone, 1);
    expect(back.alive).toBe(true);
    expect(worldOf(zone).tick).toBeGreaterThanOrEqual(left + DELAY);
  });

  it("a dead ship's later respawn tick is kept across spectate -> rejoin", () => {
    const s = shipOf(zone, a)!;
    const w = worldOf(zone);
    s.alive = false; s.energy = 0; s.respawnTick = w.tick + 5 * TICK_RATE;
    const due = s.respawnTick;
    a.send({ type: 'setTeam', team: TEAM_UNASSIGNED });
    a.send({ type: 'setTeam', team: 0 });
    expect(rejoinLine(a)).toBe('Rejoining in 5s — spectating until then.');
    ticks(zone, 5 * TICK_RATE - 2);
    expect(shipOf(zone, a)).toBeUndefined();
    ticks(zone, 2);
    const back = shipOf(zone, a)!;
    expect(back.alive).toBe(true);
    expect(worldOf(zone).tick).toBeGreaterThanOrEqual(due);
  });

  it('rejoining after the delay has passed is immediate', () => {
    a.send({ type: 'setTeam', team: TEAM_UNASSIGNED });
    ticks(zone, DELAY + 5);
    a.send({ type: 'setTeam', team: 1 });
    expect(shipOf(zone, a)).toBeDefined();
    expect(shipOf(zone, a)!.team).toBe(1);
    expect(rejoinLine(a)).toBeUndefined();
  });

  it(`spectate toggles are capped to one per ${TEAM_CHANGE_GAP_SEC} s`, () => {
    a.send({ type: 'setTeam', team: TEAM_UNASSIGNED });
    a.send({ type: 'setTeam', team: 0 }); // accepted, waiting
    a.send({ type: 'setTeam', team: TEAM_UNASSIGNED }); // too soon
    expect(a.chatTexts().filter((t) => t.startsWith('Slow down — one team change every')).length).toBe(1);
    expect(meIn(a)).toMatchObject({ team: 0, inMatch: false });
    a.send({ type: 'setTeam', team: 1 }); // hopping teams while shipless is capped too
    expect(meIn(a).team).toBe(0);
    ticks(zone, DELAY);
    expect(shipOf(zone, a)).toBeDefined(); // the queued rejoin still lands on time
    // once the gap has passed, spectating works again
    ticks(zone, TEAM_CHANGE_GAP_SEC * TICK_RATE - DELAY + 1);
    a.send({ type: 'setTeam', team: TEAM_UNASSIGNED });
    expect(shipOf(zone, a)).toBeUndefined();
    expect(meIn(a).team).toBe(TEAM_UNASSIGNED);
  });

  it('the verifier loop: /team spec and /team 1 every second never yields a ship sooner than a respawn delay', () => {
    let lastGone = -1;
    let lastId = shipOf(zone, a)!.id;
    let respawns = 0;
    let slowDowns = 0;
    for (let sec = 0; sec < 30; sec++) {
      a.send({ type: 'chat', channel: 'all', text: sec % 2 === 0 ? '/team spec' : '/team 1' });
      for (let i = 0; i < TICK_RATE; i++) {
        ticks(zone, 1);
        const s = shipOf(zone, a);
        const tick = worldOf(zone).tick;
        if (!s) { if (lastGone < 0) lastGone = tick; continue; }
        if (s.id !== lastId) {
          respawns++;
          expect(lastGone).toBeGreaterThanOrEqual(0);
          expect(tick - lastGone).toBeGreaterThanOrEqual(DELAY - 1); // shipless for a full respawn delay
          lastId = s.id;
        }
        lastGone = -1;
      }
    }
    slowDowns = a.chatTexts().filter((t) => t.startsWith('Slow down')).length;
    expect(respawns).toBeGreaterThan(0);
    expect(respawns).toBeLessThanOrEqual(8); // ≤ one full cycle per ~4 s
    expect(slowDowns).toBeGreaterThan(0);
  });

  it('leave room -> rejoin room -> Join Match waits out the delay too', () => {
    const rid = a.last('roomState').roomId!;
    a.send({ type: 'leaveRoom' });
    a.send({ type: 'joinRoom', roomId: rid });
    a.send({ type: 'joinMatch' });
    expect(shipOf(zone, a)).toBeUndefined();
    expect(rejoinLine(a)).toMatch(/^Rejoining in [1-3]s/);
    expect(a.last('matchStart').yourShipId).toBe(0); // watching meanwhile
    ticks(zone, DELAY);
    const back = shipOf(zone, a)!;
    expect(back).toBeDefined();
    expect(a.last('matchStart').yourShipId).toBe(back.id);
  });

  it('an account reconnecting on a new connection waits out the delay too', () => {
    const z = mkZone();
    const acc: AccountInfo = { accountId: 'acc-1', username: 'Maverick', emailMasked: 'm***@x.y', createdAt: 1 };
    const m1 = join(z, '', acc);
    playing(z, m1);
    m1.conn.close();
    const m2 = join(z, '', acc);
    m2.send({ type: 'joinRoom', roomId: m2.last('roomList').rooms[0].id });
    m2.send({ type: 'joinMatch' });
    expect(shipOf(z, m2)).toBeUndefined();
    expect(rejoinLine(m2)).toMatch(/^Rejoining in/);
    ticks(z, DELAY);
    expect(shipOf(z, m2)).toBeDefined();
  });

  it('a new match starts with no leftover delay (world ticks restart)', () => {
    a.send({ type: 'setTeam', team: TEAM_UNASSIGNED }); // leaves with a rejoin tick in this world
    a.send({ type: 'chat', channel: 'all', text: '/end' });
    ticks(zone, RESULTS_SEC * TICK_RATE + 1);
    expect(roomOf(zone).phase).toBe('lobby');
    a.send({ type: 'startMatch' });
    ticks(zone, COUNTDOWN_SEC * TICK_RATE + 1);
    expect(roomOf(zone).phase).toBe('playing');
    expect(worldOf(zone).tick).toBeLessThan(DELAY); // the old rejoin tick would still be "in the future"
    a.send({ type: 'joinMatch' }); // watch as a spectator
    a.send({ type: 'setTeam', team: 0 });
    expect(shipOf(zone, a)).toBeDefined();
    expect(rejoinLine(a)).toBeUndefined();
  });
});
