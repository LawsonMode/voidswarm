// RENDER v0.3 M2: loot SFX + UI blips run on a stub WebAudio graph (no browser needed).
// v0.3 M3: objective SFX (every kind, ours / theirs variants, never silent) and the hot point armed pulse.
// v0.3 M4: rift SFX (every rift event, global vs positional, slam vs klaxon, boss roar) and the portal hum loop.
// v0.5: capital SFX (Broadside / Overcharge / Repair Bay), the mass-driver thump by fire style, the transform cues.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GameEvent, ObjectiveEventKind, Rarity } from '../../shared/types';
import { CUE_CAP_DOWN, CUE_CAP_UP, CUE_RING, beamBus, publishCue, publishPortal } from '../render/beamBus';
import { FIRE_CODE } from '../render/capital';
import { AudioFx, CUE_FRESH_MS, LOOT_PITCH, OBJECTIVE_SFX, PORTAL_HEAR, RIFT_SFX } from './AudioFx';

/** Minimal WebAudio stub: every node method chains, every AudioParam accepts automation; counts oscillators + freqs. */
const stats = { osc: 0, freqs: [] as number[] };
function param(onSet?: (v: number) => void) {
  const p = {
    _v: 0,
    get value() { return p._v; },
    set value(v: number) { p._v = v; onSet?.(v); },
    setValueAtTime: (v: number) => { onSet?.(v); return p; },
    linearRampToValueAtTime: () => p, exponentialRampToValueAtTime: () => p, setTargetAtTime: () => p,
  };
  return p;
}
function node(extra: Record<string, unknown> = {}) {
  const n: Record<string, unknown> = { connect: (x: unknown) => x, disconnect: () => {}, start: () => {}, stop: () => {}, ...extra };
  return n;
}
class FakeCtx {
  state = 'running';
  currentTime = 0;
  sampleRate = 8000;
  destination = node();
  resume() { return Promise.resolve(); }
  createGain() { return node({ gain: param() }); }
  createStereoPanner() { return node({ pan: param() }); }
  createBiquadFilter() { return node({ frequency: param(), Q: param(), type: 'lowpass' }); }
  createDynamicsCompressor() { return node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }); }
  createOscillator() { stats.osc++; return node({ frequency: param((v) => stats.freqs.push(v)), type: 'sine' }); }
  createBufferSource() { return node({ buffer: null }); }
  createBuffer(_c: number, len: number) { const d = new Float32Array(len); return { getChannelData: () => d }; }
}

const g = globalThis as unknown as { window?: unknown };
let hadWindow = false;
beforeAll(() => {
  hadWindow = 'window' in g;
  g.window = { AudioContext: FakeCtx, setInterval: () => 0 };
});
afterAll(() => { if (!hadWindow) delete g.window; });

function fresh(): AudioFx {
  const a = new AudioFx();
  a.unlock();
  return a;
}
const oscFor = (fn: (a: AudioFx) => void): { osc: number; freqs: number[] } => {
  const a = fresh();
  stats.osc = 0; stats.freqs = [];
  fn(a);
  return { osc: stats.osc, freqs: [...stats.freqs] };
};
const drop = (rarity: Rarity): GameEvent => ({ t: 'lootDrop', id: 1, x: 0, y: 0, rarity, set: 'common', source: 'elite' });

describe('loot audio', () => {
  it('lootDrop is pitched by rarity and grows richer toward legendary', () => {
    expect([...LOOT_PITCH]).toEqual([...LOOT_PITCH].sort((a, b) => a - b));
    const per = ([0, 1, 2, 3, 4] as Rarity[]).map((r) => oscFor((a) => a.playEvents([drop(r)], 0, 0, 0)));
    for (let r = 0; r <= 4; r++) expect(per[r].freqs[0]).toBeCloseTo(LOOT_PITCH[r], 3);
    for (let r = 1; r <= 4; r++) expect(per[r].osc).toBeGreaterThanOrEqual(per[r - 1].osc);
    expect(per[4].osc).toBeGreaterThan(per[0].osc);
  });

  it('far-away drops are silent; pickup / spill / secured play for the local pilot', () => {
    expect(oscFor((a) => a.playEvents([drop(0)], 99_999, 0, 0)).osc).toBe(0);
    const mine = oscFor((a) => a.playEvents([
      { t: 'shipSpawn', shipId: 7, playerId: 3, x: 0, y: 0 },
      { t: 'lootPickup', playerId: 3, shipId: 7, x: 0, y: 0, rarity: 2, set: 'rift', carried: 1 },
    ], 0, 0, 7));
    expect(mine.osc).toBeGreaterThan(0);
    const spill = oscFor((a) => a.playEvents([{ t: 'lootSpill', playerId: 3, x: 0, y: 0, count: 4, best: 3 }], 0, 0, 0));
    expect(spill.osc).toBeGreaterThan(0);
    const secured = oscFor((a) => a.playEvents([
      { t: 'shipSpawn', shipId: 7, playerId: 3, x: 0, y: 0 },
      { t: 'lootSecured', playerId: 3, how: 'extract', tokens: [{ rarity: 4, set: 'rift', source: 'bossCache' }] },
    ], 0, 0, 7));
    expect(secured.osc).toBeGreaterThan(0);
    const othersSecured = oscFor((a) => a.playEvents([
      { t: 'lootSecured', playerId: 9, how: 'extract', tokens: [{ rarity: 4, set: 'rift', source: 'bossCache' }] },
    ], 0, 0, 7));
    expect(othersSecured.osc).toBe(0);
  });

  it('reveal / reveal-epic / reveal-legendary / equip UI blips exist and escalate', () => {
    const r = oscFor((a) => a.ui('reveal')).osc;
    const e = oscFor((a) => a.ui('reveal-epic')).osc;
    const l = oscFor((a) => a.ui('reveal-legendary')).osc;
    const q = oscFor((a) => a.ui('equip')).osc;
    expect(r).toBeGreaterThan(0);
    expect(q).toBeGreaterThan(0);
    expect(e).toBeGreaterThan(r);
    expect(l).toBeGreaterThan(e);
  });
});

describe('objective audio', () => {
  beforeEach(() => { beamBus.localTeam = 0; beamBus.localPid = 1; beamBus.hotArmSeq = 0; beamBus.hotArmAt = 0; });
  const obj = (kind: ObjectiveEventKind, o: Partial<Extract<GameEvent, { t: 'objective' }>> = {}): GameEvent =>
    ({ t: 'objective', kind, team: 1, playerId: 7, index: 2, x: 0, y: 0, value: 0, ...o });
  const KINDS = Object.keys(OBJECTIVE_SFX) as ObjectiveEventKind[];

  it('every objective event kind plays, even far from the listener (they are global)', () => {
    expect(KINDS.sort()).toEqual(['flagCaptured', 'flagDropped', 'flagReturned', 'flagTaken', 'hotMoved', 'hotWarn', 'overtime',
      'suddenDeath', 'zoneCaptured', 'zoneNeutralized']);
    for (const k of KINDS) {
      expect(oscFor((a) => a.playEvents([obj(k)], 0, 0, 0)).osc, k).toBeGreaterThan(0);
      expect(oscFor((a) => a.playEvents([obj(k, { x: 99_999, y: 99_999 })], 0, 0, 0)).osc, `${k} far`).toBeGreaterThan(0);
    }
  });

  it('ours vs theirs: your flag stolen sounds the siren; your capture a fanfare; losing your flag a minor fall', () => {
    const stolenMine = oscFor((a) => a.playEvents([obj('flagTaken', { index: 0, team: 1 })], 0, 0, 0)).freqs;
    const weStole = oscFor((a) => a.playEvents([obj('flagTaken', { index: 1, team: 0 })], 0, 0, 0)).freqs;
    expect(stolenMine).toContain(739.99);
    expect(weStole).not.toContain(739.99);
    const weCapped = oscFor((a) => a.playEvents([obj('flagCaptured', { index: 1, team: 0 })], 0, 0, 0)).freqs;
    const theyCapped = oscFor((a) => a.playEvents([obj('flagCaptured', { index: 0, team: 1 })], 0, 0, 0)).freqs;
    expect(weCapped).toContain(1318.5);
    expect(theyCapped).toContain(293.66);
    expect(theyCapped).not.toContain(1318.5);
    const zoneOurs = oscFor((a) => a.playEvents([obj('zoneCaptured', { team: 0 })], 0, 0, 0)).freqs;
    const zoneTheirs = oscFor((a) => a.playEvents([obj('zoneCaptured', { team: 3 })], 0, 0, 0)).freqs;
    expect(zoneOurs).toContain(880);
    expect(zoneTheirs).not.toContain(880);
    // FFA: "ours" is the local player
    beamBus.localTeam = -1;
    expect(oscFor((a) => a.playEvents([obj('zoneCaptured', { team: -1, playerId: 1 })], 0, 0, 0)).freqs).toContain(880);
    expect(oscFor((a) => a.playEvents([obj('zoneCaptured', { team: -1, playerId: 5 })], 0, 0, 0)).freqs).not.toContain(880);
  });

  it('the hot point armed pulse plays once per bump; pulses from before the session (or stale) never play', () => {
    const a = fresh();
    beamBus.hotArmSeq = 4; beamBus.hotArmAt = performance.now(); // already bumped before this AudioFx synced
    stats.osc = 0;
    a.playEvents([], 0, 0, 0);
    expect(stats.osc).toBe(0);
    beamBus.hotArmSeq++; beamBus.hotArmAt = performance.now();
    a.playEvents([], 0, 0, 0);
    expect(stats.osc).toBeGreaterThan(0);
    stats.osc = 0;
    a.playEvents([], 0, 0, 0);
    expect(stats.osc).toBe(0);
    const b = fresh();
    b.playEvents([], 0, 0, 0);
    beamBus.hotArmSeq++; beamBus.hotArmAt = performance.now() - 5000; // stale
    stats.osc = 0;
    b.playEvents([], 0, 0, 0);
    expect(stats.osc).toBe(0);
  });
});

// RENDER v0.3 M4: rift SFX — every rift event kind plays; the global ones even far away, the positional telegraph /
// spawnWarn fade out with distance; the seal slam is not the arming klaxon; the boss roar is low and layered; the
// portal hum loops only while an open portal is published near the listener.
describe('rift audio', () => {
  beforeEach(() => { beamBus.localTeam = 0; beamBus.localPid = 1; beamBus.portalCount = 0; beamBus.stamp = 0; });
  const EV: Record<keyof typeof RIFT_SFX, GameEvent> = {
    roomSeal: { t: 'roomSeal', room: 1, team: 0, sec: 0 },
    roomClear: { t: 'roomClear', room: 1, team: 0, x: 0, y: 0 },
    roomReset: { t: 'roomReset', room: 1, team: 0 },
    spawnWarn: { t: 'spawnWarn', x: 0, y: 0, radius: 90, sec: 0.8 },
    chestOpen: { t: 'chestOpen', room: 2, chest: 0, playerId: 1, team: 0, x: 0, y: 0 },
    bossIntro: { t: 'bossIntro', id: 9, kind: 'matriarch', x: 0, y: 0 },
    bossPhase: { t: 'bossPhase', id: 9, kind: 'matriarch', phase: 3, x: 0, y: 0 },
    telegraph: { t: 'telegraph', shape: 'line', x: 0, y: 0, x2: 500, y2: 0, r: 60, sec: 0.8 },
    portalOpen: { t: 'portalOpen', x: 0, y: 0, extract: true },
    departing: { t: 'departing', sec: 20, team: 0 },
    floorStart: { t: 'floorStart', floor: 2 },
    lifeLost: { t: 'lifeLost', team: 0, playerId: 3, lives: 4 },
    outOfLives: { t: 'outOfLives', playerId: 3, x: 0, y: 0 },
    extract: { t: 'extract', playerId: 1, x: 0, y: 0 },
    partyWiped: { t: 'partyWiped', team: 0 },
    instability: { t: 'instability', sec: 25 },
    riftEnd: { t: 'riftEnd', outcome: 'cleared' },
  };
  const far = (ev: GameEvent): GameEvent => ('x' in ev ? { ...ev, x: 99_999, y: 99_999 } as GameEvent : ev);

  it('every rift event plays; global ones are never silent, positional ones fade with distance', () => {
    expect(Object.keys(RIFT_SFX).sort()).toEqual(Object.keys(EV).sort());
    for (const [k, ev] of Object.entries(EV)) {
      expect(oscFor((a) => a.playEvents([ev], 0, 0, 0)).osc, k).toBeGreaterThan(0);
      const farOsc = oscFor((a) => a.playEvents([far(ev)], 0, 0, 0)).osc;
      if (k === 'telegraph' || k === 'spawnWarn') expect(farOsc, `${k} far`).toBe(0);
      else expect(farOsc, `${k} far`).toBeGreaterThan(0);
    }
  });

  it('the seal slam is not the arming klaxon; the boss intro roar is low and layered', () => {
    const slam = oscFor((a) => a.playEvents([{ t: 'roomSeal', room: 1, team: 0, sec: 0 }], 0, 0, 0)).freqs;
    const arm = oscFor((a) => a.playEvents([{ t: 'roomSeal', room: 1, team: 0, sec: 1.5 }], 0, 0, 0)).freqs;
    expect(slam).toContain(95);
    expect(arm).toContain(440);
    expect(arm).not.toContain(95);
    const roar = oscFor((a) => a.playEvents([EV.bossIntro], 0, 0, 0));
    expect(roar.osc).toBeGreaterThanOrEqual(3);
    expect(Math.min(...roar.freqs)).toBeLessThan(80);
    // another party's seal (v0.4 Rival) is not ours: silent
    expect(oscFor((a) => a.playEvents([{ t: 'roomSeal', room: 1, team: 1, sec: 0 }], 0, 0, 0)).osc).toBe(0);
  });

  it('portal hum: starts with an open portal near the listener, swells when departing, stops when none', () => {
    const a = fresh();
    const hum = () => (a as unknown as { updateHums(): void }).updateHums();
    beamBus.listenerX = 0; beamBus.listenerY = 0; beamBus.stamp = performance.now();
    hum();
    expect(a.portalHumOn).toBe(false);
    publishPortal(300, 0, 1, 0);
    beamBus.stamp = performance.now();
    hum();
    expect(a.portalHumOn).toBe(true);
    beamBus.portalCount = 0; publishPortal(300, 0, 2, 0); beamBus.stamp = performance.now();
    hum();
    expect(a.portalHumOn).toBe(true);
    beamBus.portalCount = 0; publishPortal(PORTAL_HEAR + 500, 0, 1, 1); beamBus.stamp = performance.now();
    hum();
    expect(a.portalHumOn).toBe(false); // out of earshot
    publishPortal(100, 0, 1, 1); beamBus.stamp = performance.now() - 5000;
    hum();
    expect(a.portalHumOn).toBe(false); // the renderer went quiet (stale stamp)
  });
});

// RENDER v0.5: capital ships — the three capital skills each have their own sound, a mass-driver turret swaps its
// class primary for a thump (beamBus.turretFire), and the renderer's transform cues play once, fresh, and in range.
describe('capital audio', () => {
  beforeEach(() => { beamBus.turretFire.clear(); });
  const ability = (skill: 'broadside' | 'overcharge' | 'repairbay', x = 0): GameEvent => ({ t: 'ability', shipId: 5, skill, x, y: 0 });

  it('Broadside, Resonance Overcharge and Repair Bay each play (and differ); far away they are silent', () => {
    const got = (['broadside', 'overcharge', 'repairbay'] as const).map((k) => oscFor((a) => a.playEvents([ability(k)], 0, 0, 0)));
    for (const g of got) expect(g.osc).toBeGreaterThan(2);
    expect(got[0].freqs).not.toEqual(got[1].freqs);
    expect(got[1].freqs).not.toEqual(got[2].freqs);
    expect(got[0].osc).toBeGreaterThanOrEqual(8); // a rolling volley: several thumps a side
    expect(got[2].freqs.some((f) => f > 1200)).toBe(true); // the bay chime rings high
    expect(oscFor((a) => a.playEvents([ability('broadside', 99_999)], 0, 0, 0)).osc).toBe(0);
  });

  it('a mass-driver turret thumps instead of its class primary; other styles keep the primary', () => {
    const fire: GameEvent = { t: 'fire', shipId: 42, skill: 'autocannon', x: 0, y: 0 };
    const plain = oscFor((a) => a.playEvents([fire], 0, 0, 0));
    beamBus.turretFire.set(42, FIRE_CODE.tracer);
    const tracer = oscFor((a) => a.playEvents([fire], 0, 0, 0));
    beamBus.turretFire.set(42, FIRE_CODE.massdriver);
    const md = oscFor((a) => a.playEvents([fire], 0, 0, 0));
    expect(tracer.freqs).toEqual(plain.freqs);
    expect(md.osc).toBeGreaterThan(0);
    expect(md.freqs).not.toEqual(plain.freqs);
    expect(md.freqs[0]).toBeLessThan(plain.freqs[0]); // deeper
  });

  it('transform cues: play once when fresh and in range; before sync, stale or far cues never play', () => {
    const a = fresh();
    publishCue(CUE_CAP_UP, 0, 0); // raised before this AudioFx synced
    stats.osc = 0;
    a.playEvents([], 0, 0, 0);
    expect(stats.osc).toBe(0);
    publishCue(CUE_CAP_UP, 100, 0);
    a.playEvents([], 0, 0, 0);
    const up = stats.osc;
    expect(up).toBeGreaterThan(0);
    stats.osc = 0;
    a.playEvents([], 0, 0, 0); // same cue again: nothing
    expect(stats.osc).toBe(0);
    const b = fresh();
    b.playEvents([], 0, 0, 0);
    publishCue(CUE_CAP_DOWN, 0, 0);
    beamBus.cues[beamBus.cueSeq % CUE_RING].at = performance.now() - CUE_FRESH_MS - 100; // stale
    stats.osc = 0;
    b.playEvents([], 0, 0, 0);
    expect(stats.osc).toBe(0);
    const c = fresh();
    c.playEvents([], 0, 0, 0);
    publishCue(CUE_CAP_DOWN, 99_999, 0); // out of hearing range
    stats.osc = 0;
    c.playEvents([], 0, 0, 0);
    expect(stats.osc).toBe(0);
    const d = fresh();
    d.playEvents([], 0, 0, 0);
    publishCue(CUE_CAP_DOWN, 0, 0);
    stats.osc = 0;
    d.playEvents([], 0, 0, 0);
    expect(stats.osc).toBeGreaterThan(0);
    expect(stats.osc).toBeLessThan(up + 1); // the fold-back is the lighter of the two
  });
});
