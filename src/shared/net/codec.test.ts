import { describe, expect, it } from 'vitest';
import { CODEC_VERSION, decodeSnapshot, encodeSnapshot } from './codec';
import { validateClientMsg } from './validate';
import { SHIPFLAG_CARRIER, SHIPFLAG_CLOAKED, SHIPFLAG_INVULN, type MatchView, type ShipStats, type Snapshot } from '../types';
import { SHIP_CLASSES } from '../data/ships';
import { CTF_CARRIER_SPEED_MULT, carrierSpeedMult } from '../sim/objectives/rules';

function angDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

function sample(): Snapshot {
  return {
    tick: 123456, ackSeq: 987,
    you: {
      playerId: 3, shipId: 70001, alive: true, respawnIn: 0, energy: 812.3456,
      stats: { ...SHIP_CLASSES.engineer.base, gunCooldown: 0.14, armor: 0.333, skill: { ...SHIP_CLASSES.engineer.base.skill } }, xp: 12, xpToNext: 40, level: 4,
      offer: [{ id: 'orbit', name: 'Orbit Blades', description: 'x', level: 1, maxLevel: 5, category: 'auto', icon: 'O' }],
      offerId: 17, queuedOffers: 1, upgrades: [{ id: 'orbit', name: 'Orbit Blades', icon: 'O', level: 2, maxLevel: 5 }],
      cd: { primary: 0.3333333, secondary: 0, mobility: 1, utility: 0.25, attach: 0.5 },
      cdSec: { secondary: 0, mobility: 4.25, utility: 1.5 }, deployables: { sentry: 2, wall: 1 },
      path: 'summoner', talents: ['swarmlord'], bounty: 18, attachedTo: 0, turrets: [70002], skillActive: true,
    },
    ships: [
      { id: 70001, playerId: 3, team: 1, shipClass: 'engineer', x: 1234.56, y: 6399.9, vx: -432.7, vy: 900.2, angle: -1.2,
        energyFrac: 0.678, alive: true, attachedTo: 0, turretSlot: -1, turretCount: 1, flags: 34, level: 4, orbitals: 3,
        pathIdx: 0, beamLen: 0, beamKind: 0, resonance: 1 },
      { id: 70002, playerId: 9, team: 1, shipClass: 'tech', x: 10, y: 20, vx: 0, vy: 0, angle: 7.5,
        energyFrac: 1, alive: false, attachedTo: 70001, turretSlot: 0, turretCount: 1, flags: 0, level: 1, orbitals: 0,
        pathIdx: 2, beamLen: 612, beamKind: 1, resonance: 3 },
      { id: 5, playerId: 12, team: -1, shipClass: 'brute', x: 0, y: 0, vx: 0, vy: 0, angle: 0,
        energyFrac: 0, alive: true, attachedTo: 0, turretSlot: -1, turretCount: 0, flags: 2, level: 30, orbitals: 0,
        pathIdx: -1, beamLen: 0, beamKind: 0, resonance: 1 },
    ],
    enemies: [
      { id: 100000, kind: 'hive', x: 3000.1, y: 3000.2, angle: 3.14, hpFrac: 0.5, radius: 72.5, elite: true },
      { id: 101, kind: 'splitling', x: 1, y: 2, angle: 0.1, hpFrac: 0.01, radius: 8, elite: false },
    ],
    projectiles: [
      { id: 4000000, kind: 'seeker', x: 50.125, y: 60.5, vx: 950, vy: -950, team: 100, ownerId: 99999, level: 3 },
      { id: 7, kind: 'mine', x: 7, y: 8, vx: 0, vy: 0, team: -1, ownerId: 5, level: 1 },
      { id: 8, kind: 'singularity', x: 9, y: 9, vx: 300, vy: 0, team: 1, ownerId: 70001, level: 2 },
      { id: 9, kind: 'rocket', x: 9, y: 9, vx: 300, vy: 0, team: 1, ownerId: 70001, level: 1 },
      { id: 10, kind: 'plasma', x: 9, y: 9, vx: 300, vy: 0, team: 1, ownerId: 70001, level: 1 },
    ],
    deployables: [
      { id: 5000001, kind: 'wall', ownerId: 70001, team: 1, x: 2000.3, y: 1500.7, angle: 1.3, hpFrac: 0.8, radius: 6.25, length: 180, lifeFrac: 0.5 },
      { id: 12, kind: 'nanite', ownerId: 5, team: -1, x: 3, y: 4, angle: 0, hpFrac: 1, radius: 90, length: 0, lifeFrac: 0.01 },
    ],
    gems: [{ id: 77, x: 400.4, y: 500.5, value: 25 }],
    events: [
      { t: 'shipDeath', shipId: 5, playerId: 12, killerPlayerId: 3, cause: 'player', x: 1.23456, y: 2, bounty: 30 },
      { t: 'arc', points: [1, 2, 3, 4], team: 1 },
      { t: 'beam', fromId: 70001, toId: 70002, kind: 'heal' },
      { t: 'heal', x: 5, y: 6, targetId: 70002, amount: 12.5 },
    ],
    match: { phase: 'playing', mode: 'teams', teamCount: 2, timeLeftSec: 431.23456, teamScores: [10, 20], wave: 3, winnerTeam: -1, winnerPlayerId: 0 },
  };
}

describe('snapshot codec', () => {
  it('round-trips within quantization error', () => {
    const s = sample();
    const buf = encodeSnapshot(s);
    const d = decodeSnapshot(buf);
    expect(d.tick).toBe(s.tick);
    expect(d.ackSeq).toBe(s.ackSeq);
    expect(d.ships.length).toBe(3);
    s.ships.forEach((a, i) => {
      const b = d.ships[i];
      expect(b.id).toBe(a.id); expect(b.playerId).toBe(a.playerId); expect(b.team).toBe(a.team);
      expect(b.shipClass).toBe(a.shipClass);
      expect(Math.abs(b.x - a.x)).toBeLessThanOrEqual(1 / 16 + 1e-9);
      expect(Math.abs(b.y - a.y)).toBeLessThanOrEqual(1 / 16 + 1e-9);
      expect(Math.abs(b.vx - a.vx)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(b.vy - a.vy)).toBeLessThanOrEqual(0.5);
      expect(angDiff(b.angle, a.angle)).toBeLessThanOrEqual(Math.PI / 256 + 1e-9);
      expect(Math.abs(b.energyFrac - a.energyFrac)).toBeLessThanOrEqual(1 / 510 + 1e-9);
      expect(b.alive).toBe(a.alive); expect(b.attachedTo).toBe(a.attachedTo);
      expect(b.turretSlot).toBe(a.turretSlot); expect(b.turretCount).toBe(a.turretCount);
      expect(b.flags).toBe(a.flags); expect(b.level).toBe(a.level); expect(b.orbitals).toBe(a.orbitals);
      expect(b.pathIdx).toBe(a.pathIdx); expect(b.beamLen).toBe(a.beamLen);
      expect(b.beamKind).toBe(a.beamKind); expect(b.resonance).toBe(a.resonance);
    });
    expect(d.deployables).toHaveLength(2);
    s.deployables.forEach((a, i) => {
      const b = d.deployables[i];
      expect(b.id).toBe(a.id); expect(b.kind).toBe(a.kind); expect(b.ownerId).toBe(a.ownerId); expect(b.team).toBe(a.team);
      expect(Math.abs(b.x - a.x)).toBeLessThanOrEqual(1 / 16); expect(Math.abs(b.y - a.y)).toBeLessThanOrEqual(1 / 16);
      expect(angDiff(b.angle, a.angle)).toBeLessThanOrEqual(Math.PI / 256 + 1e-9);
      expect(Math.abs(b.hpFrac - a.hpFrac)).toBeLessThanOrEqual(1 / 510 + 1e-9);
      expect(Math.abs(b.lifeFrac - a.lifeFrac)).toBeLessThanOrEqual(1 / 510 + 1e-9);
      expect(Math.abs(b.radius - a.radius)).toBeLessThanOrEqual(1 / 8);
      expect(b.length).toBe(a.length);
    });
    s.enemies.forEach((a, i) => {
      const b = d.enemies[i];
      expect(b.id).toBe(a.id); expect(b.kind).toBe(a.kind); expect(b.elite).toBe(a.elite);
      expect(Math.abs(b.x - a.x)).toBeLessThanOrEqual(1 / 16);
      expect(Math.abs(b.radius - a.radius)).toBeLessThanOrEqual(1 / 8);
      expect(Math.abs(b.hpFrac - a.hpFrac)).toBeLessThanOrEqual(1 / 510 + 1e-9);
      expect(angDiff(b.angle, a.angle)).toBeLessThanOrEqual(Math.PI / 256 + 1e-9);
    });
    s.projectiles.forEach((a, i) => {
      const b = d.projectiles[i];
      expect(b.id).toBe(a.id); expect(b.kind).toBe(a.kind); expect(b.level).toBe(a.level);
      expect(b.team).toBe(a.team); expect(b.ownerId).toBe(a.ownerId);
      expect(Math.abs(b.x - a.x)).toBeLessThanOrEqual(1 / 16); expect(b.vx).toBe(Math.round(a.vx));
    });
    expect(d.gems[0]).toEqual({ id: 77, x: 400.375, y: 500.5, value: 25 });
    expect(d.you!.offer![0].id).toBe('orbit');
    expect(d.you!.offerId).toBe(17);
    expect(d.you!.cd.primary).toBeCloseTo(0.333, 3);
    expect(d.you!.cdSec.mobility).toBe(4.25);
    expect(d.you!.deployables).toEqual({ sentry: 2, wall: 1 });
    expect(d.you!.path).toBe('summoner');
    expect(d.you!.skillActive).toBe(true);
    expect(d.projectiles.map((p) => p.kind)).toEqual(['seeker', 'mine', 'singularity', 'rocket', 'plasma']);
    expect(d.you!.turrets).toEqual([70002]);
    expect(d.match.teamScores).toEqual([10, 20]);
    expect(d.events).toHaveLength(4);
    expect(d.events[1]).toEqual({ t: 'arc', points: [1, 2, 3, 4], team: 1 });
  });

  it('packs you.stats in binary exactly (7 significant digits) incl. unknown keys', () => {
    const s = sample();
    const st = s.you!.stats as ShipStats & Record<string, unknown>;
    st.skill.sentryDamage = 12.3456;
    st.skill.brandNewKnob = 4.5; // not in the knob tables -> JSON fallback
    st.futureStat = 7; // not a known ShipStats key -> JSON fallback
    const d = decodeSnapshot(encodeSnapshot(s));
    const ds = d.you!.stats as ShipStats & Record<string, unknown>;
    expect(ds.gunCooldown).toBe(0.14);
    expect(ds.armor).toBe(0.333);
    expect(ds.maxEnergy).toBe(st.maxEnergy);
    expect(ds.skill.sentryDamage).toBe(12.3456);
    expect(ds.skill.brandNewKnob).toBe(4.5);
    expect(ds.futureStat).toBe(7);
    const { skill: a, ...ra } = st;
    const { skill: b, ...rb } = ds;
    expect(rb).toEqual(ra);
    expect(b).toEqual(a);
  });

  it('handles empty snapshots and null you', () => {
    const s = sample();
    s.you = null; s.ships = []; s.enemies = []; s.projectiles = []; s.gems = []; s.events = []; s.deployables = [];
    const d = decodeSnapshot(encodeSnapshot(s));
    expect(d.you).toBeNull();
    expect(d.ships).toEqual([]);
    expect(d.events).toEqual([]);
  });

  it('keeps ship playerIds above 65535 (ids are never reused on a long-lived server)', () => {
    const s = sample();
    s.ships[0].playerId = 65536;
    s.ships[1].playerId = 70001;
    s.ships[2].playerId = 4_000_000_000;
    const d = decodeSnapshot(encodeSnapshot(s));
    expect(d.ships.map((v) => v.playerId)).toEqual([65536, 70001, 4_000_000_000]);
    expect(d.ships[1].attachedTo).toBe(70001); // fields after playerId still line up
    expect(d.ships[1].resonance).toBe(3);
  });

  it('is compact', () => {
    const buf = encodeSnapshot(sample());
    expect(buf.byteLength).toBeLessThan(1800); // incl. a full engineer stats block
  });
});

describe('snapshot codec v5 (v0.3 layout, docs/v0.3-proposal.md §8.9)', () => {
  const HEADER = 21;

  it('VERSION 5 header with nLoot; other versions are refused', () => {
    const buf = encodeSnapshot(sample());
    const dv = new DataView(buf);
    expect(CODEC_VERSION).toBe(5);
    expect(dv.getUint8(0)).toBe(5);
    expect(dv.getUint16(19, true)).toBe(0); // nLoot: 0 until M2
    const d = decodeSnapshot(buf);
    expect('loot' in d).toBe(false); // absent = none, like the SnapshotBuilder's own objects
    expect('carry' in d).toBe(false);
    const old = buf.slice(0);
    new DataView(old).setUint8(0, 4);
    expect(() => decodeSnapshot(old)).toThrow(/unsupported version 4/);
  });

  it('loot section round-trips (u32 ids and reservedFor, 1/8 px, rarity | set, lifeFrac) at 14 B per cache', () => {
    const s = sample();
    const base = encodeSnapshot(s).byteLength;
    s.loot = [
      { id: 9_000_001, x: 1234.56, y: 6000.2, rarity: 4, set: 'swarm', reservedFor: 70_000, lifeFrac: 0.5 },
      { id: 3, x: 0, y: 8191.875, rarity: 0, set: 'common', reservedFor: 0, lifeFrac: 1 },
      { id: 4, x: 10, y: 20, rarity: 2, set: 'rift', reservedFor: 4_000_000_000, lifeFrac: 0 },
      { id: 5, x: 10, y: 20, rarity: 3, set: 'gladiator', reservedFor: 1, lifeFrac: 0.01 },
    ];
    const buf = encodeSnapshot(s);
    expect(buf.byteLength - base).toBe(4 * 14);
    expect(new DataView(buf).getUint16(19, true)).toBe(4);
    const d = decodeSnapshot(buf);
    expect(d.loot).toHaveLength(4);
    s.loot.forEach((a, i) => {
      const b = d.loot![i];
      expect(b.id).toBe(a.id); expect(b.rarity).toBe(a.rarity); expect(b.set).toBe(a.set);
      expect(b.reservedFor).toBe(a.reservedFor);
      expect(Math.abs(b.x - a.x)).toBeLessThanOrEqual(1 / 16); expect(Math.abs(b.y - a.y)).toBeLessThanOrEqual(1 / 16);
      expect(Math.abs(b.lifeFrac - a.lifeFrac)).toBeLessThanOrEqual(1 / 510 + 1e-9);
    });
    // everything after the loot section still lines up
    expect(d.you!.offerId).toBe(17);
    expect(d.you!.stats.maxEnergy).toBe(s.you!.stats.maxEnergy);
    expect(d.events).toHaveLength(4);
  });

  it("'carry' travels as a flat tail array and comes back as CarryView[]", () => {
    const s = sample();
    s.carry = [{ shipId: 70001, n: 5, best: 3 }, { shipId: 4_000_000, n: 1, best: 0 }];
    const d = decodeSnapshot(encodeSnapshot(s));
    expect(d.carry).toEqual(s.carry);
    s.carry = [];
    expect('carry' in decodeSnapshot(encodeSnapshot(s))).toBe(false);
  });

  it("ship playerIds are u32; EnemyKind 'matriarch' round-trips; an unknown kind index decodes as 'drone'", () => {
    const s = sample();
    s.ships[0].playerId = 3_000_000_000;
    s.enemies[0].kind = 'matriarch';
    const buf = encodeSnapshot(s);
    const d = decodeSnapshot(buf);
    expect(d.ships[0].playerId).toBe(3_000_000_000);
    expect(d.enemies[0].kind).toBe('matriarch');
    expect(d.enemies[0].elite).toBe(true);
    const bad = buf.slice(0);
    const off = HEADER + s.ships.length * 35 + 4; // first enemy's kind byte
    new DataView(bad).setUint8(off, 100 | 128);
    const e = decodeSnapshot(bad).enemies[0];
    expect(e.kind).toBe('drone');
    expect(e.elite).toBe(true);
  });

  it("an unknown ship class index decodes as 'brute' (not the v0.1 'striker')", () => {
    const buf = encodeSnapshot(sample());
    new DataView(buf).setUint8(HEADER + 9, 250);
    expect(decodeSnapshot(buf).ships[0].shipClass).toBe('brute');
  });

  it('match timed / gameType / subMode and the objective + rift tails round-trip; you.rift / carried / carryCap too', () => {
    const s = sample();
    s.match = {
      ...s.match, timed: false, gameType: 'dungeon', subMode: 'coop', timeLeftSec: 0,
      dungeon: {
        floor: 3, floorsTotal: 6, biome: 'hive', rooms: [3, 2, 0, 1], chests: [1, 0, 0, 0], lives: [7], seen: [11],
        anchors: [1000, 2000], portal: 1, departIn: 0, extractOpen: true,
        boss: { id: 100000, kind: 'matriarch', hpFrac: 0.5, phase: 2 }, waiting: [9], extracting: [{ playerId: 3, frac: 0.25 }], floorSec: 312.5,
      },
    };
    s.you = {
      ...s.you!,
      rift: { party: 0, lives: 7, waiting: false, extracted: false, extract: 0.25, followId: 0 },
      carried: [{ rarity: 4, set: 'rift' }, { rarity: 1, set: 'common' }], carryCap: 24,
    };
    let d = decodeSnapshot(encodeSnapshot(s));
    expect(d.match).toEqual(s.match);
    expect(d.you!.rift).toEqual(s.you.rift);
    expect(d.you!.carried).toEqual(s.you.carried);
    expect(d.you!.carryCap).toBe(24);

    const obj: MatchView = {
      ...sample().match, timeLeftSec: 431.5, timed: true, gameType: 'arena', subMode: 'ctf',
      objective: {
        mode: 'ctf', limit: 3, overtime: false, suddenDeath: false,
        flags: [{ team: 0, s: 1, x: 100.5, y: 200.25, carrierId: 70002, returnIn: 0 }, { team: 1, s: 2, x: 5, y: 6, carrierId: 0, returnIn: 12.5 }],
      },
    };
    s.match = obj;
    d = decodeSnapshot(encodeSnapshot(s));
    expect(d.match).toEqual(obj);
  });

  it('v0.3 M4: every RiftGameEvent, a waiting / extracted RiftYou and a boss-floor RiftView survive the tail; matriarch enemies too', () => {
    const s = sample();
    const events: Snapshot['events'] = [
      { t: 'roomSeal', room: 4, team: 0, sec: 1.5 }, { t: 'roomSeal', room: 4, team: 0, sec: 0 },
      { t: 'roomClear', room: 4, team: 0, x: 2400.5, y: 3100.25 }, { t: 'roomReset', room: 5, team: 0 },
      { t: 'spawnWarn', x: 100.125, y: 200.5, radius: 90, sec: 0.8 },
      { t: 'chestOpen', room: 3, chest: 1, playerId: 4_000_000_000, team: 0, x: 10, y: 20 },
      { t: 'bossIntro', id: 100000, kind: 'matriarch', x: 3200, y: 3200 },
      { t: 'bossPhase', id: 100000, kind: 'matriarch', phase: 3, x: 3100.5, y: 3150 },
      { t: 'telegraph', shape: 'line', x: 1, y: 2, x2: 900.5, y2: 40, r: 44, sec: 0.8 },
      { t: 'telegraph', shape: 'ring', x: 5, y: 6, x2: 0, y2: 0, r: 300, sec: 0.6 },
      { t: 'portalOpen', x: 3200, y: 3200, extract: false }, { t: 'portalOpen', x: 3552, y: 3200, extract: true },
      { t: 'departing', sec: 20, team: 0 }, { t: 'floorStart', floor: 4 },
      { t: 'lifeLost', team: 0, playerId: 9, lives: 6 }, { t: 'outOfLives', playerId: 9, x: 1, y: 2 },
      { t: 'extract', playerId: 3, x: 3552, y: 3200 }, { t: 'partyWiped', team: 0 }, { t: 'instability', sec: 0 },
      { t: 'riftEnd', outcome: 'cleared' },
      { t: 'lootSecured', playerId: 3, how: 'extract', tokens: [{ rarity: 3, set: 'rift', source: 'bossCache' }] },
    ];
    s.events = events;
    s.enemies = [{ id: 100000, kind: 'matriarch', x: 3200.5, y: 3199.875, angle: 1, hpFrac: 0.66, radius: 88, elite: false }];
    s.match = {
      ...s.match, timed: false, gameType: 'dungeon', subMode: 'coop', timeLeftSec: 0, wave: 11,
      dungeon: {
        floor: 6, floorsTotal: 6, biome: 'prism', rooms: [3, 3, 3, 3, 3, 3, 3, 3, 2, 3], chests: [0, 1, 0, 3, 0, 0, 0, 1, 0, 0],
        lives: [12], seen: [1023], anchors: [3200, 3080], portal: 0, departIn: 44.5, extractOpen: true,
        boss: null, waiting: [], extracting: [{ playerId: 3, frac: 0.999 }, { playerId: 4_000_000_000, frac: 0.004 }], floorSec: 419.95,
      },
    };
    const d = decodeSnapshot(encodeSnapshot(s));
    expect(d.events).toEqual(events);
    expect(d.match).toEqual(s.match);
    expect(d.enemies[0]).toMatchObject({ kind: 'matriarch', radius: 88 });
    for (const rift of [
      { party: 0, lives: 0, waiting: true, extracted: false, extract: 0, followId: 70002 },
      { party: 0, lives: 3, waiting: false, extracted: true, extract: 1, followId: 0 },
    ]) {
      s.you = { ...s.you!, alive: false, rift };
      expect(decodeSnapshot(encodeSnapshot(s)).you!.rift).toEqual(rift);
    }
  });

  it('v0.3 M3: Control Zones / Hot Point objective tails (incl. FFA playerPoints, overtime, sudden death) round-trip', () => {
    const s = sample();
    const zones: MatchView = {
      ...sample().match, timeLeftSec: 431.5, timed: true, gameType: 'warzone', subMode: 'zones', teamScores: [212, 187, 90], teamCount: 3,
      objective: {
        mode: 'zones', limit: 300, overtime: true, suddenDeath: false,
        zones: [
          { i: 0, owner: 1, ownerPid: 0, cap: -1, capPid: 0, p: 0, contested: true, swarm: false, active: true },
          { i: 1, owner: -1, ownerPid: 0, cap: 2, capPid: 70001, p: 62.5, contested: false, swarm: true, active: true },
          { i: 4, owner: 0, ownerPid: 0, cap: 1, capPid: 4_000_000_000, p: 12.345, contested: false, swarm: false, active: false },
        ],
      },
    };
    s.match = zones;
    expect(decodeSnapshot(encodeSnapshot(s)).match).toEqual(zones);

    const hot: MatchView = {
      ...sample().match, mode: 'ffa', teamCount: 0, teamScores: [], timeLeftSec: 12, timed: true, gameType: 'arena', subMode: 'hotpoint',
      objective: {
        mode: 'hotpoint', limit: 120, overtime: false, suddenDeath: true,
        zones: [{ i: 5, owner: -1, ownerPid: 70001, cap: -1, capPid: 9, p: 40, contested: false, swarm: false, active: true }],
        hot: { site: 5, next: 2, moveIn: 7.25, armIn: 0 },
        playerPoints: [[70001, 88], [9, 12], [4_000_000_000, 1]],
      },
    };
    s.match = hot;
    const d = decodeSnapshot(encodeSnapshot(s));
    expect(d.match).toEqual(hot);
    expect(d.match.objective!.playerPoints![2][0]).toBe(4_000_000_000);
    // everything after the tail's match block still lines up
    expect(d.events).toHaveLength(4);
    expect(d.you!.offerId).toBe(17);
  });

  it('v0.3 M3: SHIPFLAG_CARRIER (128, the last u8 flag bit) round-trips alone and with every other flag bit', () => {
    const s = sample();
    s.ships[0].flags = SHIPFLAG_CARRIER;
    s.ships[1].flags = 0xff; // carrier + every lower bit
    s.ships[2].flags = SHIPFLAG_CARRIER | SHIPFLAG_CLOAKED | SHIPFLAG_INVULN;
    const d = decodeSnapshot(encodeSnapshot(s));
    expect(d.ships.map((v) => v.flags)).toEqual([SHIPFLAG_CARRIER, 0xff, SHIPFLAG_CARRIER | SHIPFLAG_CLOAKED | SHIPFLAG_INVULN]);
    expect(d.ships.map((v) => (v.flags & SHIPFLAG_CARRIER) !== 0)).toEqual([true, true, true]);
    expect(carrierSpeedMult(d.ships[0].flags)).toBe(CTF_CARRIER_SPEED_MULT); // client prediction reads the decoded flag
    expect(carrierSpeedMult(sample().ships[0].flags)).toBe(1);
    // the fields after the flags byte are untouched
    s.ships.forEach((a, i) => { expect(d.ships[i].level).toBe(a.level); expect(d.ships[i].attachedTo).toBe(a.attachedTo); });
  });

  it('the shared match JSON is serialized once per MatchView and reused for every viewer', () => {
    const stringify = JSON.stringify;
    const match: MatchView = { ...sample().match, timeLeftSec: 431.5, timed: true, gameType: 'warzone', subMode: 'deathmatch' };
    let matchCalls = 0;
    const spy = (v: unknown, ...rest: unknown[]): string => {
      if (v === match) matchCalls++;
      return (stringify as (...a: unknown[]) => string)(v, ...rest);
    };
    JSON.stringify = spy as typeof JSON.stringify;
    try {
      for (let i = 0; i < 5; i++) {
        const s = sample();
        s.match = match;
        s.ackSeq = i;
        expect(decodeSnapshot(encodeSnapshot(s)).match).toEqual(match);
      }
    } finally {
      JSON.stringify = stringify;
    }
    expect(matchCalls).toBe(1);
  });
});

describe('validateClientMsg', () => {
  it('drops garbage and accepts well-formed messages', () => {
    expect(validateClientMsg(null)).toBeNull();
    expect(validateClientMsg([1])).toBeNull();
    expect(validateClientMsg({ type: 'nuke' })).toBeNull();
    expect(validateClientMsg({ type: 'chat' })).toBeNull();
    expect(validateClientMsg({ type: 'chat', channel: 'all', text: 'hi' })).not.toBeNull();
    expect(validateClientMsg({ type: 'startMatch' })).not.toBeNull();
    expect(validateClientMsg({ type: 'setTeam', team: 'x' })).toBeNull();
  });
  it('chooseUpgrade must carry an integer offerId; hello token must be a string if present', () => {
    expect(validateClientMsg({ type: 'chooseUpgrade', index: 1, offerId: 4 })).not.toBeNull();
    expect(validateClientMsg({ type: 'chooseUpgrade', index: 1 })).toBeNull();
    expect(validateClientMsg({ type: 'chooseUpgrade', index: 1, offerId: '4' })).toBeNull();
    expect(validateClientMsg({ type: 'chooseUpgrade', index: 1, offerId: 1.5 })).toBeNull();
    expect(validateClientMsg({ type: 'chooseUpgrade', index: 1, offerId: NaN })).toBeNull();
    expect(validateClientMsg({ type: 'hello', name: 'a', protocol: 2, version: 'x' })).not.toBeNull();
    expect(validateClientMsg({ type: 'hello', name: 'a', protocol: 2, version: 'x', token: 'abc' })).not.toBeNull();
    expect(validateClientMsg({ type: 'hello', name: 'a', protocol: 2, version: 'x', token: { evil: 1 } })).toBeNull();
  });
  it('NET-1: spectate is known and carries a non-negative integer shipId (only that field passes)', () => {
    expect(validateClientMsg({ type: 'spectate', shipId: 12 })).toEqual({ type: 'spectate', shipId: 12 });
    expect(validateClientMsg({ type: 'spectate', shipId: 0 })).toEqual({ type: 'spectate', shipId: 0 });
    expect(validateClientMsg({ type: 'spectate', shipId: 7, evil: { x: 1 } })).toEqual({ type: 'spectate', shipId: 7 });
    for (const shipId of [-1, 1.5, NaN, Infinity, '3', null, 2 ** 40]) {
      expect(validateClientMsg({ type: 'spectate', shipId })).toBeNull();
    }
    expect(validateClientMsg({ type: 'spectate' })).toBeNull();
  });

  it("v0.3 joinRoom intents are whitelisted to lobby | play | watch — 'quick' never comes from the wire", () => {
    expect(validateClientMsg({ type: 'joinRoom', roomId: 'r1' })).toEqual({ type: 'joinRoom', roomId: 'r1' });
    expect(validateClientMsg({ type: 'joinRoom', roomId: 'r1', intent: null })).toEqual({ type: 'joinRoom', roomId: 'r1' });
    for (const intent of ['lobby', 'play', 'watch'] as const) {
      expect(validateClientMsg({ type: 'joinRoom', roomId: 'r1', intent, evil: 1 })).toEqual({ type: 'joinRoom', roomId: 'r1', intent });
    }
    for (const intent of ['quick', 'QUICK', 'spectate', 1, {}, '']) {
      expect(validateClientMsg({ type: 'joinRoom', roomId: 'r1', intent })).toBeNull();
    }
    expect(validateClientMsg({ type: 'joinRoom', roomId: 5 })).toBeNull();
  });

  it('v0.3 quickPlay: a known game type and optional known sub-mode (only those fields pass)', () => {
    expect(validateClientMsg({ type: 'quickPlay', gameType: 'arena' })).toEqual({ type: 'quickPlay', gameType: 'arena' });
    expect(validateClientMsg({ type: 'quickPlay', gameType: 'arena', subMode: 'ctf', x: 1 })).toEqual({ type: 'quickPlay', gameType: 'arena', subMode: 'ctf' });
    expect(validateClientMsg({ type: 'quickPlay', gameType: 'warzone', subMode: null })).toEqual({ type: 'quickPlay', gameType: 'warzone' });
    expect(validateClientMsg({ type: 'quickPlay' })).toBeNull();
    expect(validateClientMsg({ type: 'quickPlay', gameType: 'pong' })).toBeNull();
    expect(validateClientMsg({ type: 'quickPlay', gameType: 'arena', subMode: 'points' })).toBeNull();
    expect(validateClientMsg({ type: 'quickPlay', gameType: 'arena', subMode: 'toString' })).toBeNull();
  });

  it('v0.3 equip / seenItems shape checks', () => {
    expect(validateClientMsg({ type: 'equip', slot: 'hull', itemId: 'rift.hull.brute', shipClass: 'brute' }))
      .toEqual({ type: 'equip', slot: 'hull', itemId: 'rift.hull.brute', shipClass: 'brute' });
    expect(validateClientMsg({ type: 'equip', slot: 'title', itemId: '' })).toEqual({ type: 'equip', slot: 'title', itemId: '' });
    expect(validateClientMsg({ type: 'equip', slot: 'tracer', itemId: 'x' })).toBeNull(); // v0.4 slot
    expect(validateClientMsg({ type: 'equip', slot: 'hull', itemId: 7 })).toBeNull();
    expect(validateClientMsg({ type: 'equip', slot: 'hull', itemId: 'x'.repeat(41) })).toBeNull(); // §7.4: ids ≤ 40
    expect(validateClientMsg({ type: 'equip', slot: 'hull', itemId: 'x'.repeat(40) })).not.toBeNull();
    expect(validateClientMsg({ type: 'equip', slot: 'hull', itemId: 'x', shipClass: 3 })).toBeNull();
    expect(validateClientMsg({ type: 'seenItems', ids: ['a', 'b'] })).toEqual({ type: 'seenItems', ids: ['a', 'b'] });
    expect(validateClientMsg({ type: 'seenItems', ids: [] })).toEqual({ type: 'seenItems', ids: [] });
    expect(validateClientMsg({ type: 'seenItems', ids: 'a' })).toBeNull();
    expect(validateClientMsg({ type: 'seenItems', ids: [1] })).toBeNull();
    expect(validateClientMsg({ type: 'seenItems', ids: new Array(65).fill('a') })).toBeNull();
  });
});
