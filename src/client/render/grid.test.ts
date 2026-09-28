import { describe, expect, it } from 'vitest';
import { SpringGrid } from './grid';

// RENDER-1: impulses outside the simulated window must not pile up velocity that jolts later.
describe('SpringGrid impulses', () => {
  const fields = (g: SpringGrid) => g as unknown as { vx: Float32Array; vy: Float32Array; dx: Float32Array };
  const maxSpeed = (g: SpringGrid) => {
    const { vx, vy } = fields(g);
    let m = 0;
    for (let i = 0; i < vx.length; i++) m = Math.max(m, Math.hypot(vx[i], vy[i]));
    return m;
  };

  it('ignores kicks outside the last simulated window, keeps kicks inside', () => {
    const g = new SpringGrid(4000, 4000, 50);
    g.step(1 / 60, 0, 0, 1000, 1000); // camera window around the top-left
    for (let i = 0; i < 600; i++) g.impulse(3000, 3000, 200, -150); // a black hole off-screen, every frame for 10 s
    expect(maxSpeed(g)).toBe(0);
    g.impulse(500, 500, 200, 300);
    expect(maxSpeed(g)).toBeGreaterThan(0);
  });

  it('the camera arriving later finds a calm grid', () => {
    const g = new SpringGrid(4000, 4000, 50);
    g.step(1 / 60, 0, 0, 1000, 1000);
    for (let i = 0; i < 600; i++) g.impulse(3000, 3000, 200, -150);
    for (let i = 0; i < 5; i++) g.step(1 / 60, 2500, 2500, 3500, 3500);
    let worst = 0;
    for (const d of fields(g).dx) worst = Math.max(worst, Math.abs(d));
    expect(worst).toBe(0);
  });
});
