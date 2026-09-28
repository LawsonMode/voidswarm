// CLIENT M4: rift HUD presentation (strip, boss bar, banners + announcer, waiting overlay, extract ring, portal arrows,
// roster, results). Pure: no DOM, no Sim.
import { describe, expect, it } from 'vitest';
import { RIFT_SOFT_LIMIT_SEC } from '../../shared/constants';
import type { RiftResult } from '../../shared/protocol';
import type { GameEvent, RiftGameEvent, RiftLayout, RiftRoom, RiftView, RiftYou } from '../../shared/types';
import {
  biomeName, bossBarModel, bossFloors, edgeArrow, extractRingModel, floorBanner, hudShowsRift, INSTABILITY_REPEAT_MS,
  isFinalFloor, mergeArrows, partyOf, portalTargets, projectorFrom, RIFT_WARN_SEC, RiftAnnouncer, riftBannerFor, riftResultModel,
  riftRespawnLine, riftRulesLine, riftSpectateModel, riftStatusLabel, riftStatusMap, riftStripModel, rosterModel,
  shipPilotName, waitingModel, type RiftCtx,
} from './riftInfo';

function view(p: Partial<RiftView> = {}): RiftView {
  return {
    floor: 1, floorsTotal: 6, biome: 'hive', rooms: [3, 0, 0, 0, 0, 0, 0], chests: [0, 0, 0, 0, 0, 0, 0], lives: [10], seen: [1],
    anchors: [100, 100], portal: 0, departIn: 0, extractOpen: false, boss: null, waiting: [], extracting: [], floorSec: 0, ...p,
  };
}

function room(idx: number, kind: RiftRoom['kind'], chests: number[] = []): RiftRoom {
  return { idx, kind, c0: 0, r0: 0, c1: 10, r1: 10, x: 160, y: 160, doors: [], spawns: [], chests, links: [], depth: idx, mainPath: true, party: kind === 'entrance' ? 0 : -1 };
}

function layout(p: Partial<RiftLayout> = {}): RiftLayout {
  return {
    floor: 1, biome: 'hive', bossFloor: false,
    rooms: [room(0, 'entrance'), room(1, 'hall'), room(2, 'arena', [10, 20]), room(3, 'treasure', [1, 2, 3, 4]), room(4, 'key', [5, 6]), room(5, 'boss', [7, 8])],
    entrances: [0], keyRoom: 4, portalX: 3000, portalY: 3200, extractX: -1, extractY: -1, ...p,
  };
}

const ctx = (p: Partial<RiftCtx> = {}): RiftCtx => ({
  myPid: 1, party: 0, name: (pid) => ({ 1: 'Me', 2: 'Kestrel', 3: 'Bot Vex' } as Record<number, string>)[pid] ?? `#${pid}`,
  layout: layout(), view: view(), ...p,
});

describe('strip: FLOOR n/N · biome · lives · rooms c/R · mm:ss', () => {
  it('reads the view for the viewer party', () => {
    const m = riftStripModel(view({ floor: 3, floorsTotal: 6, biome: 'hive', rooms: [3, 3, 2, 0, 3, 0, 0, 0], lives: [7], floorSec: 125 }), 0);
    expect(m).toMatchObject({ floor: 'FLOOR 3/6', biome: 'HIVE', lives: 7, livesLevel: 0, rooms: 'ROOMS 3/8', clock: '2:05', clockLevel: 0, badge: '' });
    expect(riftStripModel(view({ biome: 'prism' }), 0).biome).toBe('PRISM');
  });

  it('clock turns amber at RIFT_WARN_SEC (360 s) and unstable at RIFT_SOFT_LIMIT_SEC (420 s)', () => {
    expect(RIFT_WARN_SEC).toBe(360);
    expect(riftStripModel(view({ floorSec: 359.9 }), 0).clockLevel).toBe(0);
    expect(riftStripModel(view({ floorSec: 360 }), 0)).toMatchObject({ clockLevel: 1, clock: '6:00' });
    expect(riftStripModel(view({ floorSec: RIFT_SOFT_LIMIT_SEC }), 0).clockLevel).toBe(2);
  });

  it('lives: low at ≤ 2, none at 0; a missing party entry reads 0', () => {
    expect(riftStripModel(view({ lives: [2] }), 0).livesLevel).toBe(1);
    expect(riftStripModel(view({ lives: [0] }), 0).livesLevel).toBe(2);
    expect(riftStripModel(view({ lives: [5] }), 1).lives).toBe(0);
  });

  it('badges: descending countdown, final-floor exit / run end, extract open, portal open', () => {
    expect(riftStripModel(view({ portal: 2, departIn: 16.2 }), 0)).toMatchObject({ badge: 'DESCENDING 0:17', badgeKind: 'depart' });
    expect(riftStripModel(view({ floor: 6, extractOpen: true, departIn: 44.5 }), 0)).toMatchObject({ badge: 'EXIT · RUN ENDS 0:45', badgeKind: 'exit' });
    expect(riftStripModel(view({ floor: 6, extractOpen: true }), 0).badge).toBe('EXIT OPEN');
    expect(riftStripModel(view({ floor: 3, extractOpen: true, portal: 1 }), 0)).toMatchObject({ badge: 'EXTRACT OPEN', badgeKind: 'extract' });
    expect(riftStripModel(view({ portal: 1 }), 0).badge).toBe('PORTAL OPEN');
  });

  it('the rift strip replaces the others whenever a RiftView is present', () => {
    expect(hudShowsRift(null)).toBe(false);
    expect(hudShowsRift({ dungeon: undefined })).toBe(false);
    expect(hudShowsRift({ dungeon: view() })).toBe(true);
  });

  it('party of the viewer: RiftYou.party, else the team, else 0', () => {
    expect(partyOf({ rift: { party: 1, lives: 3, waiting: false, extracted: false, extract: 0, followId: 0 } }, 0)).toBe(1);
    expect(partyOf(null, 0)).toBe(0);
    expect(partyOf(null, -2)).toBe(0);
    expect(biomeName('prism')).toBe('Prism Vaults');
    expect(biomeName(undefined)).toBe('The Rift');
    expect(isFinalFloor(view({ floor: 3, floorsTotal: 3 }))).toBe(true);
    expect(isFinalFloor(view({ floor: 3, floorsTotal: 6 }))).toBe(false);
  });
});

describe('boss bar', () => {
  it('absent without a boss; Matriarch name, hp %, phase pips and phase names', () => {
    expect(bossBarModel(view())).toBeNull();
    const b = bossBarModel(view({ boss: { id: 9, kind: 'matriarch', hpFrac: 0.642, phase: 2 } }))!;
    expect(b).toMatchObject({ name: 'THE HIVE MATRIARCH', pct: '65%', phase: 2, phaseName: 'BROOD BURST', phases: 3 });
    expect(bossBarModel(view({ boss: { id: 9, kind: 'matriarch', hpFrac: 0.2, phase: 3 } }))!.phaseName).toBe('FRENZY');
    expect(bossBarModel(view({ boss: { id: 9, kind: 'matriarch', hpFrac: 1, phase: 0 } }))!.phase).toBe(1);
    // a key-room mini-boss
    const hive = bossBarModel(view({ boss: { id: 4, kind: 'hive', hpFrac: 2, phase: 1 } }))!;
    expect(hive).toMatchObject({ name: 'HIVE', hpFrac: 1, phases: 1, phaseName: '' });
  });
});

describe('banners', () => {
  const b = (ev: RiftGameEvent, c = ctx()) => riftBannerFor(ev, c);

  it('room sealing → sealed → cleared (with the chest), reset; other parties are skipped', () => {
    expect(b({ t: 'roomSeal', room: 2, team: 0, sec: 1.5 })).toMatchObject({ text: 'ARENA SEALING', kind: 'rift-alert' });
    expect(b({ t: 'roomSeal', room: 4, team: 0, sec: 0 })).toMatchObject({ text: 'KEY VAULT SEALED — CLEAR IT' });
    expect(b({ t: 'roomClear', room: 2, team: 0, x: 0, y: 0 })!.text).toBe('ARENA CLEARED · CHEST UNLOCKED');
    expect(b({ t: 'roomClear', room: 1, team: 0, x: 0, y: 0 })!.text).toBe('HALL CLEARED');
    expect(b({ t: 'roomClear', room: 5, team: 0, x: 0, y: 0 })!.text).toBe('BOSS CHAMBER CLEARED · +2 LIVES');
    expect(b({ t: 'roomReset', room: 2, team: 0 })!.text).toBe('ROOM RESET — REGROUP');
    expect(b({ t: 'roomSeal', room: 2, team: 1, sec: 0 })).toBeNull();
    expect(b({ t: 'roomSeal', room: 99, team: 0, sec: 0 })!.text).toBe('ROOM SEALED — CLEAR IT');
  });

  it('portal open / extract open (final floor: Exit), departing', () => {
    expect(b({ t: 'portalOpen', x: 0, y: 0, extract: false })!.text).toBe('DESCEND PORTAL OPEN');
    expect(b({ t: 'portalOpen', x: 0, y: 0, extract: true })!.text).toBe('EXTRACT OPEN — BANK YOUR CACHES');
    expect(b({ t: 'portalOpen', x: 0, y: 0, extract: true }, ctx({ view: view({ floor: 6 }) }))!.text).toBe('EXIT OPEN — EXTRACT TO FINISH');
    expect(b({ t: 'departing', sec: 19.5, team: 0 })!.text).toBe('DESCENDING IN 20s');
    expect(b({ t: 'departing', sec: 3, team: 0 })!.text).toBe('DESCENDING IN 3s');
  });

  it('life lost (you / a teammate / the last one), out of lives, extract, party wiped', () => {
    expect(b({ t: 'lifeLost', team: 0, playerId: 1, lives: 6 })).toMatchObject({ text: 'YOU WENT DOWN · 6 LIVES LEFT', kind: 'rift-bad' });
    expect(b({ t: 'lifeLost', team: 0, playerId: 2, lives: 1 })).toMatchObject({ text: 'KESTREL DOWN · 1 LIFE LEFT', kind: 'rift', priority: 1 });
    expect(b({ t: 'lifeLost', team: 0, playerId: 2, lives: 0 })).toMatchObject({ text: 'KESTREL DOWN · NO LIVES LEFT', kind: 'rift-alert' });
    expect(b({ t: 'outOfLives', playerId: 1, x: 0, y: 0 })!.text).toBe('OUT OF LIVES — YOU REJOIN NEXT FLOOR');
    expect(b({ t: 'outOfLives', playerId: 3, x: 0, y: 0 })!.text).toBe('BOT VEX IS OUT FOR THE FLOOR');
    expect(b({ t: 'extract', playerId: 1, x: 0, y: 0 })).toMatchObject({ text: 'EXTRACTED — YOUR CACHES ARE BANKED', kind: 'rift-good' });
    expect(b({ t: 'extract', playerId: 2, x: 0, y: 0 })!.text).toBe('KESTREL EXTRACTED');
    expect(b({ t: 'partyWiped', team: 0 })).toMatchObject({ text: 'PARTY WIPED', priority: 5 });
  });

  it('instability, boss intro / phases, floor start; render-only events raise nothing', () => {
    expect(b({ t: 'instability', sec: 420 })!.text).toBe('RIFT UNSTABLE — HUNTERS INBOUND');
    expect(riftBannerFor({ t: 'instability', sec: 445 }, ctx(), true)!.text).toBe('HUNTERS INBOUND');
    expect(b({ t: 'bossIntro', id: 9, kind: 'matriarch', x: 0, y: 0 })).toMatchObject({ text: 'THE HIVE MATRIARCH AWAKENS', kind: 'boss' });
    expect(b({ t: 'bossPhase', id: 9, kind: 'matriarch', phase: 2, x: 0, y: 0 })!.text).toBe('BROOD BURST');
    expect(b({ t: 'bossPhase', id: 9, kind: 'matriarch', phase: 3, x: 0, y: 0 })!.text).toBe('FRENZY');
    expect(b({ t: 'floorStart', floor: 4 }, ctx({ layout: layout({ floor: 4, biome: 'prism' }) }))!.text).toBe('FLOOR 4 · PRISM VAULTS');
    expect(floorBanner(3, 'hive', true).text).toBe('FLOOR 3 · HIVE WARRENS · BOSS FLOOR');
    expect(b({ t: 'spawnWarn', x: 0, y: 0, radius: 90, sec: 0.8 })).toBeNull();
    expect(b({ t: 'telegraph', shape: 'line', x: 0, y: 0, x2: 1, y2: 1, r: 40, sec: 0.8 })).toBeNull();
    expect(b({ t: 'riftEnd', outcome: 'cleared' })).toBeNull();
  });
});

describe('announcer: once each', () => {
  it('the floor banner once, whether from the client floorStart or the event', () => {
    const a = new RiftAnnouncer();
    expect(a.onFloor(2, layout({ floor: 2 })).map((x) => x.text)).toEqual(['FLOOR 2 · HIVE WARRENS']);
    expect(a.onEvents([{ t: 'floorStart', floor: 2 }], ctx(), 0)).toEqual([]);
    expect(a.onEvents([{ t: 'floorStart', floor: 3 }], ctx({ layout: layout({ floor: 3, bossFloor: true }) }), 0).map((x) => x.text)).toEqual(['FLOOR 3 · HIVE WARRENS · BOSS FLOOR']);
    // no (or a stale) layout: the §4.1 rule names the biome and boss floors
    expect(a.onFloor(4, null).map((x) => x.text)).toEqual(['FLOOR 4 · PRISM VAULTS']);
    expect(a.onFloor(6, layout({ floor: 5 })).map((x) => x.text)).toEqual(['FLOOR 6 · PRISM VAULTS · BOSS FLOOR']);
  });

  it('the one-minute instability warning once per floor from the floor clock; pulses throttle to a short repeat', () => {
    const a = new RiftAnnouncer();
    expect(a.observe(view({ floorSec: 300 }))).toEqual([]);
    expect(a.observe(view({ floorSec: 361 })).map((x) => x.text)).toEqual(['RIFT DESTABILIZING — HUNTERS IN 1:00']);
    expect(a.observe(view({ floorSec: 380 }))).toEqual([]);
    const c = ctx({ view: view({ floor: 1 }) });
    const ev: GameEvent[] = [{ t: 'instability', sec: 420 }];
    expect(a.onEvents(ev, c, 1000).map((x) => x.text)).toEqual(['RIFT UNSTABLE — HUNTERS INBOUND']);
    expect(a.onEvents(ev, c, 1000 + INSTABILITY_REPEAT_MS - 1)).toEqual([]);
    expect(a.onEvents(ev, c, 1000 + INSTABILITY_REPEAT_MS).map((x) => x.text)).toEqual(['HUNTERS INBOUND']);
    // next floor: the warning and the full banner again
    expect(a.observe(view({ floor: 2, floorSec: 365 }))).toHaveLength(1);
    const c2 = ctx({ view: view({ floor: 2 }) });
    expect(a.onEvents(ev, c2, 2000).map((x) => x.text)).toEqual(['RIFT UNSTABLE — HUNTERS INBOUND']);
    // an instability that arrives first makes the warning moot
    const b = new RiftAnnouncer();
    b.onEvents(ev, c, 0);
    expect(b.observe(view({ floorSec: 370 }))).toEqual([]);
    // non-rift events are ignored; reset forgets everything
    expect(b.onEvents([{ t: 'waveStart', wave: 3, boss: false }], c, 0)).toEqual([]);
    b.reset();
    expect(b.observe(view({ floorSec: 370 }))).toHaveLength(1);
  });
});

describe('waiting overlay, spectate lines, respawn line, extract ring', () => {
  const rift = (p: Partial<RiftYou> = {}): RiftYou => ({ party: 0, lives: 0, waiting: false, extracted: false, extract: 0, followId: 0, ...p });

  it('out of lives follows a teammate; extracted says the caches are banked', () => {
    expect(waitingModel(undefined, 'x')).toBeNull();
    expect(waitingModel(rift(), 'x')).toBeNull();
    expect(waitingModel(rift({ waiting: true }), 'Kestrel')).toEqual({ big: 'OUT OF LIVES', small: 'Watching Kestrel · you rejoin at the next floor' });
    expect(waitingModel(rift({ waiting: true }), '')!.small).toMatch(/^Watching the party/);
    expect(waitingModel(rift({ extracted: true }), 'Kestrel')!.big).toBe('EXTRACTED');
  });

  it('spectating: a pending drop-in and an extracted pilot get their own line; others the default', () => {
    expect(riftSpectateModel({ dropIn: true, extracted: false }, 'Kestrel')!.big).toBe('JOINING AT THE NEXT FLOOR');
    expect(riftSpectateModel({ dropIn: false, extracted: true }, '')!.small).toMatch(/banked/);
    expect(riftSpectateModel({ dropIn: false, extracted: false }, 'Kestrel')).toBeNull();
    expect(riftRespawnLine(4.23, 6)).toBe('Respawning in 4.2s · 6 lives left');
    expect(riftRespawnLine(Number.NaN, 1)).toBe('Respawning in 0.0s · 1 life left');
  });

  it('the extract ring shows only while alive and channelling', () => {
    expect(extractRingModel({ alive: true, rift: rift({ extract: 0 }) }, false)).toBeNull();
    expect(extractRingModel({ alive: true, rift: rift({ extract: 0.645 }) }, false)).toEqual({ frac: 0.645, pct: '64%', label: 'EXTRACTING' });
    expect(extractRingModel({ alive: true, rift: rift({ extract: 0.5 }) }, true)!.label).toBe('EXITING');
    expect(extractRingModel({ alive: false, rift: rift({ extract: 0.5 }) }, false)).toBeNull();
    expect(extractRingModel({ alive: true, rift: rift({ extract: 1, extracted: true }) }, false)).toBeNull();
    expect(extractRingModel(null, false)).toBeNull();
  });
});

describe('portal arrows', () => {
  it('targets: Descend while open / departing, Extract (Exit on the final floor); floor-checked', () => {
    const L = layout({ floor: 3, bossFloor: true, extractX: 3352, extractY: 3200 });
    expect(portalTargets(view({ floor: 3 }), L)).toEqual([]);
    expect(portalTargets(view({ floor: 3, portal: 1, extractOpen: true }), L).map((t) => `${t.kind}:${t.label}`)).toEqual(['descend:DESCEND', 'extract:EXTRACT']);
    expect(portalTargets(view({ floor: 3, portal: 2 }), L)[0].label).toBe('DESCENDING');
    expect(portalTargets(view({ floor: 3, floorsTotal: 3, extractOpen: true }), L).map((t) => t.kind)).toEqual(['exit']);
    expect(portalTargets(view({ floor: 4, portal: 1 }), L)).toEqual([]); // stale layout
    expect(portalTargets(view({ floor: 1, extractOpen: true }), layout())).toEqual([]); // no extract spot on the layout
  });

  it('edge pointer: none on screen, clamped to the uncovered rect otherwise, angle toward the target', () => {
    const ins = { top: 60, bottom: 120, side: 30 };
    expect(edgeArrow(500, 400, 1000, 800, ins)).toBeNull();
    const right = edgeArrow(3000, 400, 1000, 800, ins)!;
    expect(right.x).toBeCloseTo(970);
    expect(right.y).toBeCloseTo(400);
    expect(right.angle).toBeCloseTo(0);
    const up = edgeArrow(500, -5000, 1000, 800, ins)!;
    expect(up.x).toBeCloseTo(500);
    expect(up.y).toBeCloseTo(60);
    expect(up.angle).toBeCloseTo(-Math.PI / 2);
    const down = edgeArrow(500, 5000, 1000, 800, ins)!;
    expect(down.y).toBeCloseTo(680);
    const corner = edgeArrow(-4000, -4000, 1000, 800, ins)!;
    expect(corner.x).toBeGreaterThanOrEqual(30 - 1e-6);
    expect(corner.y).toBeGreaterThanOrEqual(60 - 1e-6);
    expect(Math.abs(corner.x - 30) < 1e-6 || Math.abs(corner.y - 60) < 1e-6).toBe(true);
    // a target under the HUD's bottom block counts as off-screen
    expect(edgeArrow(500, 750, 1000, 800, ins)).not.toBeNull();
    expect(edgeArrow(Number.NaN, 0, 1000, 800, ins)).toBeNull();
    expect(edgeArrow(0, 0, 0, 0, ins)).toBeNull();
  });

  it('pointers that would overlap merge into one (Descend + Extract side by side)', () => {
    const a = { x: 272, y: 670, angle: 1, kind: 'descend' as const, label: 'DESCEND', dist: 5100 };
    const b = { x: 253, y: 670, angle: 1.1, kind: 'extract' as const, label: 'EXTRACT', dist: 5000 };
    const far = { x: 30, y: 300, angle: 3, kind: 'extract' as const, label: 'EXTRACT', dist: 900 };
    expect(mergeArrows([a, b])).toEqual([{ ...a, label: 'DESCEND · EXTRACT', dist: 5000 }]);
    expect(mergeArrows([a, far])).toHaveLength(2);
    expect(a.label).toBe('DESCEND'); // inputs untouched
  });

  it('projects world → view px through the renderer camera (offset + zoom)', () => {
    const cam = { x: 1000, y: 2000, zoom: 0.5 }; // view px = (world - cam) * zoom
    const p = projectorFrom((sx, sy) => ({ x: sx / cam.zoom + cam.x, y: sy / cam.zoom + cam.y }))!;
    expect(p(1200, 2100)).toEqual({ x: 100, y: 50 });
    expect(projectorFrom(() => ({ x: 0, y: 0 }))).toBeNull();
  });
});

describe('party roster', () => {
  it('alive / down / waiting / out, me first, bots last', () => {
    const members = [
      { playerId: 3, name: 'Bot Vex', isBot: true }, { playerId: 2, name: 'Kestrel', isBot: false },
      { playerId: 1, name: 'Me', isBot: false }, { playerId: 4, name: 'Ash', isBot: false }, { playerId: 5, name: 'Zed', isBot: false },
    ];
    const ships = [{ playerId: 1, alive: true }, { playerId: 2, alive: false }, { playerId: 3, alive: true }, { playerId: 4, alive: false }];
    const rows = rosterModel(members, ships, { waiting: [4] }, new Set([5]), 1);
    expect(rows.map((r) => `${r.name}:${r.state}`)).toEqual(['Me:alive', 'Ash:waiting', 'Kestrel:dead', 'Zed:out', 'Bot Vex:alive']);
    expect(rows[0].me).toBe(true);
    expect(shipPilotName([{ id: 7, playerId: 2 }], 7, (pid) => (pid === 2 ? 'Kestrel' : ''))).toBe('Kestrel');
    expect(shipPilotName([], 0, () => 'x')).toBe('');
  });
});

describe('results', () => {
  const res = (p: Partial<RiftResult> = {}): RiftResult => ({
    outcome: 'cleared', floorsTotal: 6, floorReached: 6, roomsCleared: 38, bossesKilled: 2, timeSec: 1840,
    players: [{ playerId: 1, status: 'survived', floor: 6, deaths: 2 }, { playerId: 2, status: 'extracted', floor: 3, deaths: 0 }], ...p,
  });

  it('RIFT CONQUERED / EXTRACTED — F3 / PARTY WIPED — F5 / ABANDONED', () => {
    const c = riftResultModel(res(), 1);
    expect(c).toMatchObject({ sub: 'VICTORY', title: 'RIFT CONQUERED', good: true, you: 'You made it out — caches banked.' });
    expect(c.line).toBe('All 6 floors cleared · Floor 6/6 · 38 rooms · 2 bosses · 30:40');
    const e = riftResultModel(res({ outcome: 'extracted', floorReached: 3 }), 2);
    expect(e).toMatchObject({ title: 'EXTRACTED — F3', good: true, you: 'You extracted on floor 3 — caches banked.' });
    const w = riftResultModel(res({ outcome: 'wiped', floorReached: 5, bossesKilled: 1, players: [{ playerId: 1, status: 'lost', floor: 5, deaths: 4 }] }), 1);
    expect(w).toMatchObject({ title: 'PARTY WIPED — F5', good: false, you: 'Your unsecured caches were lost.' });
    expect(w.line).toMatch(/unsecured loot lost$/);
    const a = riftResultModel(res({ outcome: 'abandoned', floorReached: 2, bossesKilled: 0, roomsCleared: 1, timeSec: 0 }), 9);
    expect(a).toMatchObject({ title: 'ABANDONED', you: '' });
    expect(a.line).toBe('Run abandoned on floor 2 · Floor 2/6 · 1 room');
  });

  it('status column labels', () => {
    expect(riftStatusLabel({ playerId: 1, status: 'extracted', floor: 3, deaths: 0 })).toBe('Extracted F3');
    expect(riftStatusLabel({ playerId: 1, status: 'lost', floor: 5, deaths: 0 })).toBe('Lost F5');
    expect(riftStatusLabel({ playerId: 1, status: 'survived', floor: 6, deaths: 0 })).toBe('Survived');
    expect(riftStatusLabel({ playerId: 1, status: 'left', floor: 2, deaths: 0 })).toBe('Left');
    expect(riftStatusLabel(undefined)).toBe('—');
    expect([...riftStatusMap(res()).entries()]).toEqual([[1, 'Survived'], [2, 'Extracted F3']]);
    expect(riftStatusMap(undefined).size).toBe(0);
  });
});

describe('lobby rules line', () => {
  it('names the boss floors of the run', () => {
    expect(bossFloors(6)).toEqual([3, 6]);
    expect(bossFloors(3)).toEqual([3]);
    expect(riftRulesLine(6)).toMatch(/6 floors · the Matriarch waits on floors 3 and 6 · extract after a boss/);
    expect(riftRulesLine(3)).toMatch(/3 floors · the Matriarch waits on floor 3 ·/);
  });
});
