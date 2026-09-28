import { describe, expect, it } from 'vitest';
import { CAM_SWAY, floorMarginFor } from './backdrop';
import { Director, DEFAULT_TIMING, type SceneEvent } from './director';
import { featureLines, unlockableCosmetics } from './features';
import { QualityGovernor, QUALITY_MAX } from './quality';
import {
  beatPhase, beatPulse, beatsSince, floorDepthAt, floorXAt, gridRowDepths, mulberry32, projectFloor, ridgeHeights,
  TITLE_BPM, type FloorCam,
} from './sceneMath';

describe('title scene math', () => {
  it('mulberry32 is deterministic and in [0, 1)', () => {
    const a = mulberry32(42), b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it('projectFloor and its inverses agree', () => {
    const cam: FloorCam = { cx: 720, horizonY: 400, floorH: 500, f: 720, camX: 0.05 };
    const p = { x: 0, y: 0 };
    projectFloor(cam, 0.3, 2, p);
    expect(p.y).toBeCloseTo(650, 6); // horizon + floorH / z
    expect(floorDepthAt(cam, p.y)).toBeCloseTo(2, 6);
    expect(floorXAt(cam, p.x, 2)).toBeCloseTo(0.3, 6);
    projectFloor(cam, 0, 1, p);
    expect(p.y).toBeCloseTo(900, 6); // z = 1 is the bottom edge
    expect(floorDepthAt(cam, cam.horizonY - 5)).toBe(Infinity);
  });

  it('grid rows are sorted near → far, bounded, and scroll toward the viewer', () => {
    const rows: number[] = [];
    const n = gridRowDepths(0, 0.25, 14, rows);
    expect(n).toBe(rows.length);
    expect(rows[0]).toBeCloseTo(1, 6);
    for (let i = 1; i < n; i++) expect(rows[i]).toBeGreaterThan(rows[i - 1]);
    expect(rows[n - 1]).toBeLessThanOrEqual(14);
    // half a row later every row has moved half a spacing closer (the one past the bottom edge is culled)
    const later: number[] = [];
    gridRowDepths(0.5, 0.25, 14, later);
    expect(later[0]).toBeCloseTo(rows[1] - 0.125, 9);
    expect(later[5]).toBeCloseTo(rows[6] - 0.125, 9);
    // a whole row later the pattern repeats
    const again: number[] = [];
    gridRowDepths(1, 0.25, 14, again);
    expect(again).toEqual(rows);
  });

  it('beat clock: 122 bpm, phase in [0, 1), the downbeat hits hardest', () => {
    const ms = 60000 / TITLE_BPM;
    expect(beatsSince(1000 + ms * 3, 1000, TITLE_BPM)).toBeCloseTo(3, 9);
    expect(beatPhase(1000 + ms * 2.25, 1000, TITLE_BPM)).toBeCloseTo(0.25, 9);
    expect(beatPhase(1000 - ms * 0.25, 1000, TITLE_BPM)).toBeCloseTo(0.75, 9);
    expect(beatPulse(0, true)).toBeCloseTo(1, 9);
    expect(beatPulse(0, false)).toBeLessThan(beatPulse(0, true));
    expect(beatPulse(0.5, true)).toBeLessThan(beatPulse(0.1, true));
    expect(beatPulse(0.99, true)).toBeLessThan(0.01);
  });

  it('the floor layer is wide enough for the sway and an off-centre vanishing point', () => {
    for (const [W, H] of [[1920, 1080], [1440, 900], [390, 844], [2880, 1200], [5120, 1440]] as const) {
      const f = 0.5 * Math.max(W, H);
      for (const cx of [W / 2, W / 2 + 83, W / 2 - 120]) {
        const m = floorMarginFor(W, cx, f);
        const Wc = W + 2 * m;
        for (const camX of [-CAM_SWAY, 0, CAM_SWAY]) {
          const shift = -camX * f; // the bottom row's shear
          const left = cx - Wc / 2;
          for (const s of [0, shift]) {
            expect(left + s).toBeLessThanOrEqual(0);
            expect(left + Wc + s).toBeGreaterThanOrEqual(W);
          }
        }
      }
    }
  });

  it('ridge heights are normalized and tile seamlessly', () => {
    const h = ridgeHeights(400, mulberry32(7), 5, 0.5);
    let lo = Infinity, hi = -Infinity;
    for (const v of h) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    expect(lo).toBeCloseTo(0, 6);
    expect(hi).toBeCloseTo(1, 6);
    expect(Math.abs(h[0] - h[h.length - 1])).toBeLessThan(0.08); // periodic: the ends meet
  });
});

describe('title director', () => {
  function run(seconds: number, dt = 1 / 60): { t: number; e: SceneEvent }[] {
    const d = new Director(mulberry32(3));
    const out: { t: number; e: SceneEvent }[] = [];
    const buf: SceneEvent[] = [];
    for (let s = 0; s < seconds / dt; s++) {
      buf.length = 0;
      d.step(dt, buf);
      for (const e of buf) out.push({ t: d.t, e });
    }
    return out;
  }

  it('runs the set-piece every 20 s', () => {
    const sp = run(130).filter((x) => x.e === 'setpiece').map((x) => x.t);
    expect(sp.length).toBe(7);
    expect(sp[0]).toBeCloseTo(DEFAULT_TIMING.setpieceFirst, 1);
    for (let i = 1; i < sp.length; i++) expect(sp[i] - sp[i - 1]).toBeCloseTo(20, 1);
  });

  it('majors alternate and never overlap the set-piece crossing', () => {
    const ev = run(200);
    const majors = ev.filter((x) => x.e === 'dogfight' || x.e === 'swarm');
    expect(majors[0].e).toBe('dogfight');
    expect(majors[0].t).toBeLessThan(1); // something happens right away
    for (let i = 1; i < majors.length; i++) expect(majors[i].e).not.toBe(majors[i - 1].e);
    const sp = ev.filter((x) => x.e === 'setpiece').map((x) => x.t);
    for (const m of majors.slice(1)) {
      for (const s of sp) expect(m.t < s || m.t >= s + DEFAULT_TIMING.setpieceLength).toBe(true);
      // and finishes (≈ 7 s) before the next set-piece starts
      const next = sp.find((s) => s > m.t);
      if (next !== undefined) expect(next - m.t).toBeGreaterThanOrEqual(7);
    }
  });

  it('keeps ambient flybys and shooting stars coming', () => {
    const ev = run(60);
    expect(ev.filter((x) => x.e === 'flyby').length).toBeGreaterThanOrEqual(15);
    expect(ev.filter((x) => x.e === 'shooting').length).toBeGreaterThanOrEqual(8);
  });
});

describe('title quality governor', () => {
  it('steps down when over budget, not during warm-up', () => {
    const g = new QualityGovernor(QUALITY_MAX, { warmupFrames: 10 });
    for (let i = 0; i < 10; i++) expect(g.sample(9, 16.7)).toBe(false);
    let changed = false;
    for (let i = 0; i < 120 && !changed; i++) changed = g.sample(4, 16.7);
    expect(changed).toBe(true);
    expect(g.level).toBe(QUALITY_MAX - 1);
  });

  it('steps down on dropped frames even when the draw itself is cheap', () => {
    const g = new QualityGovernor(QUALITY_MAX, { warmupFrames: 0 });
    for (let i = 0; i < 200; i++) g.sample(0.5, 40);
    expect(g.level).toBe(0);
  });

  it('catches a GPU-bound page: a steady 48 fps with a cheap draw steps down', () => {
    const g = new QualityGovernor(QUALITY_MAX, { warmupFrames: 0 });
    let changed = false;
    for (let i = 0; i < 120 && !changed; i++) changed = g.sample(0.5, 1000 / 48);
    expect(changed).toBe(true);
    expect(g.level).toBe(QUALITY_MAX - 1);
    // …while a clean 60 Hz (or faster) display never does
    const ok = new QualityGovernor(QUALITY_MAX, { warmupFrames: 0 });
    for (let i = 0; i < 600; i++) ok.sample(0.5, i % 2 ? 16.4 : 17);
    expect(ok.level).toBe(QUALITY_MAX);
  });

  it('never goes below 0 and ignores hiccups', () => {
    const g = new QualityGovernor(0, { warmupFrames: 0 });
    for (let i = 0; i < 200; i++) g.sample(10, 30);
    expect(g.level).toBe(0);
    expect(g.sample(1, 5000)).toBe(false);
  });

  it('steps back up slowly when there is room, with backoff after a drop', () => {
    const g = new QualityGovernor(QUALITY_MAX, { warmupFrames: 0, upAfterSec: 2, downAfterSec: 0.5 });
    for (let i = 0; i < 600 && g.level === QUALITY_MAX; i++) g.sample(5, 16.7);
    expect(g.level).toBe(1);
    let frames = 0;
    while (g.level === 1 && frames < 10000) { g.sample(0.2, 16.7); frames++; }
    expect(g.level).toBe(2);
    // one drop doubles the wait: at least 2 s × 2 of cheap frames
    expect(frames * 16.7).toBeGreaterThanOrEqual(4000);
  });
});

describe('title feature ticker', () => {
  it('reads its numbers from the data', () => {
    const lines = featureLines();
    expect(lines).toHaveLength(4); // the CSS ticker animates exactly 4 lines (+ the first repeated)
    expect(lines[0]).toBe('3 CLASSES · 9 BUILD PATHS');
    expect(lines[1]).toBe('DUNGEON RUNNER · ARENA · WARZONE');
    expect(lines[2]).toBe('32 PILOTS · TURRET STACKING');
    expect(lines[3]).toBe(`${unlockableCosmetics()} COSMETICS TO UNLOCK`);
    expect(unlockableCosmetics()).toBeGreaterThan(0);
    for (const l of lines) expect(l).toBe(l.toUpperCase());
  });
});
