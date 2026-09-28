import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IGameRenderer } from '../contracts';
import type { ServerMsg } from '../../shared/protocol';
import type { MovementBody } from '../../shared/sim/movement';
import type { GameMap, InputState, ShipStats, ShipView, Snapshot } from '../../shared/types';
import { emptyInput } from '../../shared/types';
import { SHIP_CLASSES } from '../../shared/data/ships';
import { BEAM_LASER, BEAM_NONE, SHIPFLAG_CARRIER, type DeployableView } from '../../shared/types';
import { CTF_CARRIER_MAX_TURRETS } from '../../shared/sim/objectives/rules';
import { turretOffset } from '../../shared/sim/world';
import { hostEnergyState, hostLaserDraw, hostRadii, hostSpeedMult, laserResonance, pickAttachCandidate } from './attach';
import { findBracket, insertSnapshot, interpDeployables, interpProjectiles, interpShips, RenderClock } from './interp';
import { Predictor, type PredictCtx, type StepFn } from './prediction';
import {
  defaultServerUrl, isPrivateHost, isTrustedServerUrl, normalizeServerUrl, resolveServer, serverHost,
} from './serverUrl';
import { GameClient, matchMapParams } from './GameClient';

// v0.3: the client rebuilds every match map through sim/mapgen.buildMatchMap (SIM owns it). Mocked here so these
// tests pin exactly what the client passes, independent of the generator.
const mapgen = vi.hoisted(() => ({ calls: [] as unknown[], fail: false }));
vi.mock('../../shared/sim/mapgen', () => ({
  buildMatchMap: (p: unknown) => {
    mapgen.calls.push(p);
    if (mapgen.fail) throw new Error('boom');
    return { width: 6400, height: 6400, tag: 'fake-map' };
  },
}));

function ship(id: number, x: number, y: number, extra: Partial<ShipView> = {}): ShipView {
  return {
    id, playerId: id, team: 0, shipClass: 'brute', x, y, vx: 0, vy: 0, angle: 0, energyFrac: 1, alive: true,
    attachedTo: 0, turretSlot: -1, turretCount: 0, flags: 0, level: 1, orbitals: 0,
    pathIdx: -1, beamLen: 0, beamKind: BEAM_NONE, resonance: 1, ...extra,
  };
}

function snap(tick: number, ships: ShipView[] = [], extra: Partial<Snapshot> = {}): Snapshot {
  return {
    tick, ackSeq: 0, you: null, ships, enemies: [], projectiles: [], gems: [], deployables: [], events: [],
    match: { phase: 'playing', mode: 'teams', teamCount: 2, timeLeftSec: 600, teamScores: [0, 0], wave: 0, winnerTeam: -1, winnerPlayerId: 0 },
    ...extra,
  };
}

describe('snapshot buffer + bracket', () => {
  it('keeps order and ignores duplicates', () => {
    const buf: Snapshot[] = [];
    insertSnapshot(buf, snap(6));
    insertSnapshot(buf, snap(3));
    insertSnapshot(buf, snap(9));
    insertSnapshot(buf, snap(6));
    expect(buf.map((s) => s.tick)).toEqual([3, 6, 9]);
  });

  it('brackets and interpolates ships, angles the short way', () => {
    const a = snap(3, [ship(1, 0, 0, { angle: Math.PI - 0.1 })]);
    const b = snap(6, [ship(1, 30, 60, { angle: -Math.PI + 0.1 }), ship(2, 5, 5)]);
    const br = findBracket([a, b], 4.5)!;
    expect(br.t).toBeCloseTo(0.5);
    const ships = interpShips(br);
    expect(ships[0].x).toBeCloseTo(15);
    expect(ships[0].y).toBeCloseTo(30);
    // halfway across the ±π seam, not through 0
    expect(Math.abs(Math.abs(ships[0].angle) - Math.PI)).toBeLessThan(0.01);
    // ship 2 only in newer snapshot: appears immediately at its position
    expect(ships[1].x).toBe(5);
  });

  it('clamps before oldest and extrapolates past newest', () => {
    const a = snap(3, [ship(1, 0, 0)]);
    const b = snap(6, [ship(1, 30, 0, { vx: 600 })]);
    expect(findBracket([a, b], 1)!.b.tick).toBe(3);
    const br = findBracket([a, b], 8)!;
    expect(br.extra).toBeCloseTo(2);
    const s = interpShips(br)[0];
    expect(s.x).toBeCloseTo(30 + 600 * (2 / 60));
  });

  it('interpolates deployables by id and tolerates a missing array', () => {
    const dep = (id: number, x: number, extra: Partial<DeployableView> = {}): DeployableView => ({
      id, kind: 'sentry', ownerId: 1, team: 0, x, y: 0, angle: 0, hpFrac: 1, radius: 14, length: 0, lifeFrac: 1, ...extra,
    });
    const a = snap(3, [], { deployables: [dep(7, 0)] });
    const b = snap(6, [], { deployables: [dep(7, 30, { hpFrac: 0.5 }), dep(8, 99, { kind: 'wall' })] });
    const d = interpDeployables(findBracket([a, b], 4.5)!);
    expect(d[0].x).toBeCloseTo(15);
    expect(d[0].hpFrac).toBe(0.5);
    expect(d[1]).toMatchObject({ id: 8, kind: 'wall', x: 99 });
    const legacy = { ...snap(9), deployables: undefined } as unknown as Snapshot;
    expect(interpDeployables(findBracket([legacy], 9)!)).toEqual([]);
  });

  it('does not slide ships across a teleport (Blink, mid-match respawn)', () => {
    const a = snap(3, [ship(1, 100, 100), ship(2, 100, 100)]);
    const b = snap(6, [ship(1, 580, 100), ship(2, 160, 100)]); // 480 px in 3 ticks vs 60 px
    const early = interpShips(findBracket([a, b], 4)!);
    const late = interpShips(findBracket([a, b], 5)!);
    expect(early[0].x).toBe(100); // still at the old spot, not 260
    expect(late[0].x).toBe(580);
    expect(early[1].x).toBeCloseTo(120); // normal flight still interpolates
    // a class change respawns the ship elsewhere: no lerp either
    const c = snap(9, [ship(1, 590, 100, { shipClass: 'tech' })]);
    expect(interpShips(findBracket([b, c], 7)!)[0].shipClass).toBe('brute');
    expect(interpShips(findBracket([b, c], 8.5)!)[0]).toMatchObject({ shipClass: 'tech', x: 590 });
  });

  it('places new projectiles by velocity relative to the newer tick', () => {
    const a = snap(3);
    const b = snap(6, [], { projectiles: [{ id: 9, kind: 'bullet', x: 100, y: 0, vx: 600, vy: 0, team: 0, ownerId: 1, level: 1 }] });
    const br = findBracket([a, b], 5)!;
    const p = interpProjectiles(br, 5)[0];
    expect(p.x).toBeCloseTo(100 - 600 / 60);
  });
});

describe('RenderClock', () => {
  it('holds render tick about delay behind the latest server tick', () => {
    const c = new RenderClock(3, 6, 15);
    let now = 0;
    let tick = 0;
    for (let i = 0; i < 200; i++) {
      now += 1000 / 60;
      if (i % 3 === 0) { tick += 3; c.onSnapshot(tick, now); }
      c.update(now, 1 / 60);
    }
    const behind = tick - c.renderTick;
    expect(behind).toBeGreaterThan(4);
    expect(behind).toBeLessThan(9);
    expect(c.delayTicks()).toBeGreaterThanOrEqual(6);
  });

  it('never runs backwards between snapshots and widens delay with jitter', () => {
    const c = new RenderClock(3, 6, 15);
    let now = 0, tick = 0, prev = -Infinity;
    for (let i = 0; i < 300; i++) {
      now += 1000 / 60;
      if (i % 3 === 0) { tick += 3; c.onSnapshot(tick, now + (i % 9 === 0 ? 60 : 0)); }
      const rt = c.update(now, 1 / 60);
      if (i > 5) expect(rt).toBeGreaterThanOrEqual(prev);
      prev = rt;
    }
    expect(c.delayTicks()).toBeGreaterThan(6);
    expect(c.delayTicks()).toBeLessThanOrEqual(15);
  });

  it('offline uses a short delay', () => {
    const c = new RenderClock(1, 1.5, 4);
    expect(c.delayTicks()).toBeCloseTo(1.5);
  });
});

describe('Predictor', () => {
  // Mock movement: x += moveX * 10 per step.
  const step: StepFn = (b: MovementBody, inp: InputState) => { b.x += inp.moveX * 10; b.vx = inp.moveX; };
  const stats = SHIP_CLASSES.brute.base as ShipStats;
  const map = {} as GameMap;
  const ctx = (energy = 100, speedMult = 1): PredictCtx => ({ stats, map, energy, speedMult, skills: null });
  const inp = (seq: number, moveX: number): InputState => ({ ...emptyInput(), seq, moveX });

  it('replays unacked inputs on top of server state', () => {
    const p = new Predictor(step, 1 / 60);
    p.reconcile({ x: 0, y: 0, vx: 0, vy: 0, angle: 0 }, 0, ctx());
    for (let s = 1; s <= 5; s++) p.applyLocal(inp(s, 1), ctx());
    expect(p.body!.x).toBe(50);
    // server applied inputs 1..3 and is at x=30: replay 4,5 -> 50, no visual error
    p.reconcile({ x: 30, y: 0, vx: 1, vy: 0, angle: 0 }, 3, ctx());
    expect(p.body!.x).toBe(50);
    expect(p.pendingCount).toBe(2);
    expect(p.errX).toBeCloseTo(0);
  });

  it('smooths corrections instead of snapping', () => {
    const p = new Predictor(step, 1 / 60);
    p.reconcile({ x: 0, y: 0, vx: 0, vy: 0, angle: 0 }, 0, ctx());
    for (let s = 1; s <= 3; s++) p.applyLocal(inp(s, 1), ctx());
    // server disagrees: after all 3 inputs it's at 20 (a wall, say)
    p.reconcile({ x: 20, y: 0, vx: 0, vy: 0, angle: 0 }, 3, ctx());
    expect(p.body!.x).toBe(20);
    expect(p.visual().x).toBeCloseTo(30); // visual still where we drew it
    for (let i = 0; i < 30; i++) p.decay(1 / 60);
    expect(p.visual().x).toBeLessThan(21);
  });

  it('snaps on huge corrections (respawn)', () => {
    const p = new Predictor(step, 1 / 60);
    p.reconcile({ x: 0, y: 0, vx: 0, vy: 0, angle: 0 }, 0, ctx());
    p.reconcile({ x: 3000, y: 0, vx: 0, vy: 0, angle: 0 }, 0, ctx());
    expect(p.visual().x).toBe(3000);
  });

  it('uses the server afterburner rule (moving + energy for this tick) and passes speedMult through', () => {
    const calls: [boolean, number][] = [];
    const spy: StepFn = (_b, _i, _s, _m, _dt, ab, sm) => { calls.push([ab, sm]); };
    const p = new Predictor(spy, 1 / 60);
    const tickCost = stats.afterburnerCostPerSec / 60;
    p.reconcile({ x: 0, y: 0, vx: 0, vy: 0, angle: 0 }, 0, ctx(1000, 0.86));
    p.applyLocal({ ...inp(1, 0), afterburner: true }, ctx(1000, 0.86)); // held but coasting: no afterburner
    p.applyLocal({ ...inp(2, 1), afterburner: true }, ctx(1000, 0.86)); // held + thrusting: on
    p.reconcile({ x: 0, y: 0, vx: 0, vy: 0, angle: 0 }, 2, ctx(tickCost * 0.5, 0.86));
    p.applyLocal({ ...inp(3, 1), afterburner: true }, ctx(tickCost * 0.5, 0.86)); // energy > 0 but < this tick's cost: off
    expect(calls).toEqual([[false, 0.86], [true, 0.86], [false, 0.86]]);
  });
});

describe('attach + misc helpers', () => {
  it('picks the nearest allied non-turret ship near the aim point', () => {
    const ships = [
      ship(1, 0, 0), // self
      ship(2, 100, 0), // ally
      ship(3, 105, 0, { team: 1 }), // enemy
      ship(4, 98, 0, { attachedTo: 2 }), // turret
      ship(5, 400, 0), // too far
    ];
    expect(pickAttachCandidate(ships, 1, 0, 'teams', 100, 5)).toBe(2);
    expect(pickAttachCandidate(ships, 1, 0, 'teams', 400, 300)).toBe(0);
    expect(pickAttachCandidate(ships, 1, 0, 'ffa', 100, 5)).toBe(0);
  });

  it('v0.3 M3 CTF: a flag carrier never gets an attach target; a carrier host is offered only while its gunner seat is free', () => {
    const ally = (flags: number, turretCount: number) => [ship(1, 0, 0), ship(2, 100, 0, { flags, turretCount })];
    expect(pickAttachCandidate(ally(0, 3), 1, 0, 'teams', 100, 0)).toBe(2); // a plain host with turrets: fine
    expect(pickAttachCandidate(ally(SHIPFLAG_CARRIER, 0), 1, 0, 'teams', 100, 0)).toBe(2); // carrier, gunner seat free
    expect(pickAttachCandidate(ally(SHIPFLAG_CARRIER, CTF_CARRIER_MAX_TURRETS), 1, 0, 'teams', 100, 0)).toBe(0); // seat taken
    const self = [ship(1, 0, 0, { flags: SHIPFLAG_CARRIER }), ship(2, 100, 0)];
    expect(pickAttachCandidate(self, 1, 0, 'teams', 100, 0)).toBe(0); // carriers can't attach
  });

  it('counts laser resonance on a host and estimates host draw', () => {
    const laser = (id: number, host: number) => ship(id, 0, 0, { shipClass: 'tech', attachedTo: host, beamKind: BEAM_LASER, beamLen: 600 });
    const ships = [ship(1, 0, 0), laser(2, 1), laser(3, 1), laser(4, 1), ship(5, 0, 0, { shipClass: 'tech', attachedTo: 1 }), laser(6, 9)];
    const r = laserResonance(ships, 1);
    expect(r.lasers).toBe(3);
    expect(r.factor).toBeCloseTo(2.25);
    const per = SHIP_CLASSES.tech.base.skill.laserHostCostPerSec;
    expect(hostLaserDraw(ships, 1)).toBeCloseTo(3 * per * 2.25);
    expect(laserResonance(ships, 0)).toEqual({ lasers: 0, factor: 1 });
    expect(hostLaserDraw([ship(1, 0, 0)], 1)).toBe(0);
  });

  it('classifies host energy against the turret floor', () => {
    expect(hostEnergyState(0.9)).toBe('ok');
    expect(hostEnergyState(0.25)).toBe('warn');
    expect(hostEnergyState(0.2)).toBe('offline');
    expect(hostEnergyState(0.05)).toBe('offline');
  });

  it('reads host radius (talents included) off the server turret placement', () => {
    const host = ship(1, 1000, 1000, { angle: 0.7, turretCount: 2 });
    const titan = 22 * 1.15; // Bulwark Titan
    const o = turretOffset(host.angle, 1, 2, titan);
    const ships = [host, ship(2, 1000 + o.dx, 1000 + o.dy, { attachedTo: 1, turretSlot: 1, turretCount: 2 }), ship(3, 0, 0)];
    expect(hostRadii(ships).get(1)).toBeCloseTo(titan, 3);
    expect(hostRadii(ships).has(3)).toBe(false);
    // implausible offsets (a knock between placement and snapshot) are ignored
    expect(hostRadii([host, ship(2, 1400, 1000, { attachedTo: 1 })]).has(1)).toBe(false);
  });

  it('host speed mult floors at 0.5', () => {
    expect(hostSpeedMult(0)).toBe(1);
    expect(hostSpeedMult(2)).toBeCloseTo(0.86);
    expect(hostSpeedMult(20)).toBe(0.5);
  });

});

describe('server URL resolution + trust (a ?server= link must not redirect logins)', () => {
  const loc = (port: string, search = '', protocol = 'http:', hostname = 'example.com') =>
    ({ protocol, hostname, host: port ? `${hostname}:${port}` : hostname, port, search });

  it('defaults to the page\'s own server', () => {
    expect(defaultServerUrl(loc('7777'))).toBe('ws://example.com:7777');
    expect(defaultServerUrl(loc('7777', '', 'https:'))).toBe('wss://example.com:7777');
    expect(defaultServerUrl(loc('5173'))).toBe('ws://example.com:7777');
    expect(defaultServerUrl(loc('', '', 'https:'))).toBe('wss://example.com'); // behind a TLS reverse proxy
    expect(normalizeServerUrl('https://x.io')).toBe('wss://x.io');
    expect(serverHost('wss://x.io:8443/ws')).toBe('x.io:8443');
    expect(serverHost('nonsense')).toBe('');
  });

  it('never lets an untrusted ?server= win without confirmation', () => {
    const r = resolveServer(loc('', '?server=wss://evil.example', 'https:', 'voidswarm.example.com'), null);
    expect(r.url).toBe('wss://voidswarm.example.com'); // login would still go to the real site
    expect(r.source).toBe('default');
    expect(r.pending).toBe('wss://evil.example');
    const saved = resolveServer(loc('5173', '?server=evil.net:9000'), 'ws://saved.example:1');
    expect(saved).toEqual({ url: 'ws://saved.example:1', source: 'saved', pending: 'ws://evil.net:9000' });
    // a lookalike isn't the page host
    expect(resolveServer(loc('', '?server=wss://example.com.evil.io', 'https:'), null).pending).toBe('wss://example.com.evil.io');
  });

  it('accepts same-host and private/LAN ?server= values directly', () => {
    expect(resolveServer(loc('5173', '?server=example.com:9000'), 'ws://saved:1')).toEqual({ url: 'ws://example.com:9000', source: 'query', pending: null });
    expect(resolveServer(loc('5173', '?server=192.168.1.20:7777'), null).url).toBe('ws://192.168.1.20:7777');
    expect(resolveServer(loc('5173', '?server=localhost:7778'), null).source).toBe('query');
    expect(resolveServer(loc('5173'), 'ws://saved:1')).toEqual({ url: 'ws://saved:1', source: 'saved', pending: null });
    expect(resolveServer(loc('5173', '?server=%20'), null).source).toBe('default');
  });

  it('classifies private hosts strictly', () => {
    for (const h of ['localhost', 'game.localhost', '127.0.0.1', '10.0.0.8', '172.16.4.4', '192.168.0.9', '169.254.1.1', '[::1]', 'fd00::1', 'box.local', 'nas.home.arpa']) {
      expect(isPrivateHost(h)).toBe(true);
    }
    for (const h of ['evil.example', '8.8.8.8', '172.32.0.1', 'fcbarcelona.com', 'bat-computer', '10.0.0.1.nip.io']) {
      expect(isPrivateHost(h)).toBe(false);
    }
    expect(isTrustedServerUrl('wss://example.com:9443', loc('5173'))).toBe(true);
    expect(isTrustedServerUrl('ftp://example.com', loc('5173'))).toBe(false);
  });
});

describe('v0.3 matchStart (PROTOCOL 4): gameType / subMode / floor → buildMatchMap', () => {
  type MatchStart = Extract<ServerMsg, { type: 'matchStart' }>;
  const start = (p: Partial<MatchStart> = {}): MatchStart => ({
    type: 'matchStart', mapSeed: 1234, mode: 'teams', teamCount: 4, gameType: 'warzone', subMode: 'deathmatch', floor: 0,
    yourShipId: 7, tick: 100, snapshotEvery: 3, ...p,
  });
  beforeEach(() => { mapgen.calls.length = 0; mapgen.fail = false; });

  it('maps the message to buildMatchMap params (FFA → teamCount 0; floor only in dungeons)', () => {
    expect(matchMapParams(start())).toEqual({ seed: 1234, gameType: 'warzone', subMode: 'deathmatch', teamCount: 4, floor: 0 });
    expect(matchMapParams(start({ gameType: 'arena', mode: 'ffa', teamCount: 2 }))).toEqual({ seed: 1234, gameType: 'arena', subMode: 'deathmatch', teamCount: 0, floor: 0 });
    expect(matchMapParams(start({ gameType: 'arena', subMode: 'ctf', teamCount: 2, floor: 5 })).floor).toBe(0);
    expect(matchMapParams(start({ gameType: 'dungeon', subMode: 'coop', teamCount: 1, floor: 4 }))).toEqual({ seed: 1234, gameType: 'dungeon', subMode: 'coop', teamCount: 1, floor: 4 });
    // a dungeon always has a 1-based floor; garbage type/sub fall back to Warzone Classic
    expect(matchMapParams(start({ gameType: 'dungeon', subMode: 'coop', teamCount: 1, floor: 0 })).floor).toBe(1);
    expect(matchMapParams(start({ gameType: 'nope' as MatchStart['gameType'], subMode: 'bad' as MatchStart['subMode'] }))).toMatchObject({ gameType: 'warzone', subMode: 'deathmatch' });
  });

  it('GameClient stores the new fields, builds the map once and hands it to the renderer', () => {
    const maps: unknown[] = [];
    const renderer = { setMap: (m: unknown) => maps.push(m) } as unknown as IGameRenderer;
    const c = new GameClient(renderer);
    const inner = c as unknown as { handleMsg(m: ServerMsg): void };
    let started = 0;
    c.on('matchStart', () => started++);
    inner.handleMsg(start({ gameType: 'arena', subMode: 'deathmatch', mode: 'ffa', teamCount: 2, yourShipId: 9 }));
    expect(mapgen.calls).toEqual([{ seed: 1234, gameType: 'arena', subMode: 'deathmatch', teamCount: 0, floor: 0 }]);
    expect(c).toMatchObject({ matchActive: true, gameType: 'arena', subMode: 'deathmatch', floor: 0, mode: 'ffa', yourShipId: 9 });
    expect(maps).toHaveLength(1);
    expect((c.map as unknown as { tag: string }).tag).toBe('fake-map');
    expect(started).toBe(1);
    // a dungeon drop-in on floor 3
    inner.handleMsg(start({ gameType: 'dungeon', subMode: 'coop', teamCount: 1, floor: 3 }));
    expect(mapgen.calls[1]).toEqual({ seed: 1234, gameType: 'dungeon', subMode: 'coop', teamCount: 1, floor: 3 });
    expect(c).toMatchObject({ gameType: 'dungeon', subMode: 'coop', floor: 3 });
    expect(c.mapParams).toEqual(mapgen.calls[1]);
  });

  it('a map build failure still enters the match (UI stays usable) with no map', () => {
    mapgen.fail = true;
    const c = new GameClient(null);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    (c as unknown as { handleMsg(m: ServerMsg): void }).handleMsg(start());
    err.mockRestore();
    expect(c.matchActive).toBe(true);
    expect(c.map).toBeNull();
  });
});
