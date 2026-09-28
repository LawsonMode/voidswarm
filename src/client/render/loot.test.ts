// RENDER v0.3 M2: loot layer rules — crate alpha (reserved / blink), carrier pips, beacons, root-alpha rule.
import { describe, expect, it } from 'vitest';
import type { RenderFrame } from '../contracts';
import { RARITY_COLORS } from '../../shared/data/loot';
import type { CarryView, LootView } from '../../shared/types';
import type { Atlas } from './textures';
import type { SpriteBatch } from './particles';
import { LOOT_BEAM_H, LootLayer, isBeacon, type LootHost, type ShipAnchor } from './loot';

type Call = { op: string; args: unknown[] };
function fakeGraphics() {
  const calls: Call[] = [];
  const g: Record<string, (...a: unknown[]) => unknown> = {};
  for (const op of ['circle', 'poly', 'moveTo', 'lineTo', 'arc', 'stroke', 'fill', 'rect']) g[op] = (...args: unknown[]) => { calls.push({ op, args }); return g; };
  return { g: g as never, calls };
}
function fakeBatch() {
  const puts: { tex: unknown; x: number; y: number; alpha: number; color: number; sy: number }[] = [];
  const b = {
    begin: () => { puts.length = 0; },
    put: (tex: unknown, x: number, y: number, _r: number, _sx: number, sy: number, color: number, alpha: number) => { puts.push({ tex, x, y, alpha, color, sy }); },
    end: () => {},
    pc: {},
  };
  return { b: b as unknown as SpriteBatch, puts };
}
const A = { soft: 'soft', beam: 'beam', ring: 'ring', hexCrate: 'hex', diamond: 'diamond' } as unknown as Atlas;

function host(ships: Record<number, ShipAnchor>): LootHost {
  return {
    inView: () => true,
    playerColor: (_f, pid) => (pid === 1 ? 0xff3b5c : 0x3b8bff),
    shipAnchor: (id) => ships[id] ?? null,
    shipOfPlayer: () => 0,
    ring: () => {}, burst: () => {}, flash: () => {}, impulse: () => {},
  };
}
const frame = (loot: LootView[], carry: CarryView[] = []): RenderFrame => ({
  time: 0, dt: 1 / 60, renderTick: 0, localPlayerId: 1, localShipId: 10, focusX: 0, focusY: 0, ships: [], enemies: [], projectiles: [],
  gems: [], deployables: [], events: [], you: null, match: null, players: new Map(), aimX: 0, aimY: 0, attachCandidateId: 0, loot, carry,
});
const cache = (o: Partial<LootView>): LootView => ({ id: 1, x: 100, y: 100, rarity: 0, set: 'common', reservedFor: 0, lifeFrac: 1, ...o });

describe('loot layer: crates', () => {
  it('beams only for rare / epic / legendary: 120 / 220 / 320 px', () => {
    expect(LOOT_BEAM_H).toEqual([0, 0, 120, 220, 320]);
    for (let r = 0; r <= 4; r++) {
      const { b, puts } = fakeBatch();
      new LootLayer(A, b).draw(frame([cache({ rarity: r as 0 })]), 0.123, fakeGraphics().g, host({}));
      const beam = puts.filter((p) => p.tex === 'beam');
      expect(beam.length).toBe(r >= 2 ? 1 : 0);
      if (beam.length) expect(beam[0].sy * 64).toBeCloseTo(LOOT_BEAM_H[r], 5);
      expect(puts.filter((p) => p.tex === 'ring').length).toBe(r >= 3 ? 1 : 0); // ring pulse epic+
      const crate = puts.find((p) => p.tex === 'hex')!;
      expect(crate).toBeTruthy();
    }
  });

  it('glow uses the rarity colour; someone else’s reserved cache draws at 50% with a dashed ring in their colour', () => {
    const run = (reservedFor: number) => {
      const { b, puts } = fakeBatch();
      const gr = fakeGraphics();
      new LootLayer(A, b).draw(frame([cache({ rarity: 3, reservedFor })]), 0.25, gr.g, host({}));
      return { puts, calls: gr.calls };
    };
    const free = run(0), mine = run(1), theirs = run(2);
    const crateA = (r: typeof free) => r.puts.find((p) => p.tex === 'hex')!.alpha;
    expect(free.puts.find((p) => p.tex === 'soft')!.color).toBe(RARITY_COLORS[3]);
    expect(crateA(mine)).toBeCloseTo(crateA(free), 6);
    expect(crateA(theirs)).toBeCloseTo(crateA(free) * 0.5, 6);
    expect(free.calls.filter((c) => c.op === 'stroke').length).toBe(0);
    const ringStroke = theirs.calls.find((c) => c.op === 'stroke')!;
    expect((ringStroke.args[0] as { color: number }).color).toBe(0x3b8bff);
    expect((mine.calls.find((c) => c.op === 'stroke')!.args[0] as { color: number }).color).toBe(0xff3b5c);
  });

  it('blinks during the last 10% of its life', () => {
    const alphaAt = (t: number, lifeFrac: number) => {
      const { b, puts } = fakeBatch();
      new LootLayer(A, b).draw(frame([cache({ lifeFrac })]), t, fakeGraphics().g, host({}));
      return puts.find((p) => p.tex === 'hex')!.alpha;
    };
    expect(alphaAt(0.13, 0.5)).toBe(1);
    const a = [0.01, 0.13, 0.26, 0.38].map((t) => alphaAt(t, 0.05));
    expect(Math.min(...a)).toBeLessThan(0.5);
    expect(Math.max(...a)).toBe(1);
  });
});

describe('loot layer: carriers, beacons, root-alpha rule', () => {
  const ship = (o: Partial<ShipAnchor>): ShipAnchor => ({ x: 0, y: 0, r: 20, alpha: 1, ally: false, cloaked: false, ...o });
  const pips = (calls: Call[]) => calls.filter((c) => c.op === 'circle' && (c.args[2] as number) <= 3.2).length;

  it('beacon rule: ≥ 4 caches or any epic+', () => {
    expect(isBeacon({ shipId: 1, n: 3, best: 2 })).toBe(false);
    expect(isBeacon({ shipId: 1, n: 4, best: 0 })).toBe(true);
    expect(isBeacon({ shipId: 1, n: 1, best: 3 })).toBe(true);
  });

  it('one pip per cache (max 12) at r + 16, the middle pip in the best rarity colour', () => {
    const gr = fakeGraphics();
    new LootLayer(A, fakeBatch().b).drawCarriers(frame([], [{ shipId: 5, n: 3, best: 2 }]), 0, gr.g, host({ 5: ship({}) }));
    const circles = gr.calls.filter((c) => c.op === 'circle');
    expect(circles.length).toBe(3);
    for (const c of circles) expect(Math.hypot(c.args[0] as number, c.args[1] as number)).toBeCloseTo(36, 5);
    const fills = gr.calls.filter((c) => c.op === 'fill').map((c) => (c.args[0] as { color: number }).color);
    expect(fills).toContain(RARITY_COLORS[2]);
    const many = fakeGraphics();
    new LootLayer(A, fakeBatch().b).drawCarriers(frame([], [{ shipId: 5, n: 20, best: 0 }]), 0, many.g, host({ 5: ship({}) }));
    expect(pips(many.calls)).toBe(13); // 12 pips + the overflow dot
  });

  it('nothing is drawn for a non-ally below 0.2 root alpha (cloak / invulnerability blink); allies still see theirs', () => {
    const c: CarryView[] = [{ shipId: 5, n: 6, best: 4 }];
    const hidden = fakeGraphics();
    new LootLayer(A, fakeBatch().b).drawCarriers(frame([], c), 0, hidden.g, host({ 5: ship({ alpha: 0.15 }) }));
    expect(hidden.calls.length).toBe(0);
    const ally = fakeGraphics();
    new LootLayer(A, fakeBatch().b).drawCarriers(frame([], c), 0, ally.g, host({ 5: ship({ alpha: 0.15, ally: true }) }));
    expect(ally.calls.length).toBeGreaterThan(0);
    for (const call of ally.calls.filter((x) => x.op === 'fill' || x.op === 'stroke')) expect((call.args[0] as { alpha: number }).alpha).toBeLessThanOrEqual(0.15 + 1e-9);
  });

  it('radar: rare+ caches only, beacon carriers ringed, cloaked non-allies never ringed', () => {
    const loot = [cache({ id: 1, rarity: 0 }), cache({ id: 2, rarity: 1 }), cache({ id: 3, rarity: 2 }), cache({ id: 4, rarity: 4 })];
    const carry: CarryView[] = [{ shipId: 5, n: 5, best: 1 }, { shipId: 6, n: 1, best: 0 }, { shipId: 7, n: 9, best: 3 }];
    const gr = fakeGraphics();
    new LootLayer(A, fakeBatch().b).drawRadar(frame(loot, carry), gr.g, 0, 0, 0.1, 0.1, false, 0, host({ 5: ship({}), 6: ship({}), 7: ship({ cloaked: true }) }));
    expect(gr.calls.filter((c) => c.op === 'poly').length).toBe(2);
    expect(gr.calls.filter((c) => c.op === 'circle').length).toBe(1); // ship 5 only (6 is no beacon, 7 is cloaked)
  });
});

describe('loot events: root-alpha rule', () => {
  it('a pickup by a hidden cloaker or a faint non-ally draws nothing; allies and visible ships do', () => {
    const fx = (anchor: ShipAnchor | null) => {
      let n = 0;
      const h: LootHost = { ...host(anchor ? { 9: anchor } : {}), ring: () => { n++; }, burst: () => { n++; }, flash: () => { n++; } };
      new LootLayer(A, fakeBatch().b).event({ t: 'lootPickup', playerId: 2, shipId: 9, x: 100, y: 100, rarity: 3 } as never, frame([]), h);
      return n;
    };
    const base: ShipAnchor = { x: 100, y: 100, r: 16, alpha: 1, ally: false, cloaked: false };
    expect(fx(base)).toBe(3); // burst + flash + follow ring
    expect(fx({ ...base, ally: true, cloaked: true, alpha: 0.5 })).toBe(3);
    expect(fx({ ...base, cloaked: true, alpha: 0.18 })).toBe(0);
    expect(fx({ ...base, alpha: 0.1 })).toBe(0); // invulnerability blink trough
    expect(fx(null)).toBe(0); // not drawn: a hidden cloaked opponent
  });
});
