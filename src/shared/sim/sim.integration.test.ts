// Real PVE (no mocks): 32 bots across all classes, spamming every skill, attaching/detaching and
// picking upgrades (paths + talents come from PVE's offers), for 90 s per mode.
import { expect, it } from 'vitest';
import { emptyInput } from '../types';
import type { ShipClassId } from '../types';
import { Sim } from './Sim';

it('real pve integration (v0.2 classes, paths, talents, turret kits)', () => {
  for (const mode of ['teams', 'ffa'] as const) {
    const sim = new Sim({ mapSeed: 77, mode, teamCount: 4, pveIntensity: 3, matchSeconds: 90, scoreLimit: 0, friendlyFire: false });
    const cls: ShipClassId[] = ['brute', 'tech', 'engineer'];
    for (let i = 1; i <= 32; i++) sim.addPlayer({ playerId: i, name: 'p' + i, team: i % 4, shipClass: cls[i % 3], isBot: true });
    let total = 0, worst = 0, deaths = 0, ek = 0, heals = 0, beams = 0, deployDeaths = 0;
    for (let k = 0; k < 60 * 90; k++) {
      for (let i = 1; i <= 32; i++) {
        const a = (k * 0.013 + i * 1.7) % 6.283;
        sim.setInput(i, {
          ...emptyInput(), seq: k, moveX: Math.cos(a), moveY: Math.sin(a), aim: a + Math.sin(k * 0.05), aimDist: 200 + (k % 400),
          primary: true, secondary: k % 20 < 10, mobility: k % 200 === i, utility: k % 250 === i,
          afterburner: k % 90 < 15, attach: k % 300 === i, detach: k % 300 === i + 150,
        });
        if (k % 30 === 0) sim.chooseUpgrade(i, i % 3);
      }
      const t0 = performance.now(); sim.step(); const dt = performance.now() - t0;
      total += dt; worst = Math.max(worst, dt);
      for (const e of sim.drainEvents()) {
        if (e.t === 'shipDeath') deaths++;
        else if (e.t === 'enemyDeath') ek++;
        else if (e.t === 'heal') heals++;
        else if (e.t === 'beam') beams++;
        else if (e.t === 'deployDeath') deployDeaths++;
      }
    }
    const w = sim.world;
    const ships = [...w.ships.values()];
    const paths = ships.filter((s) => s.path).length;
    console.log(`${mode}: avg ${(total / 5400).toFixed(3)}ms worst ${worst.toFixed(2)} deaths ${deaths} enemyDeaths ${ek} ` +
      `heals ${heals} beams ${beams} deployDeaths ${deployDeaths} enemies ${w.enemies.size} proj ${w.projectiles.size} ` +
      `deps ${w.deployables.size} withPath ${paths} maxLvl ${Math.max(...ships.map((s) => s.level))} phase ${w.match.phase}`);
    expect(w.match.phase).toBe('ended');
    for (const s of ships) {
      expect(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.energy)).toBe(true);
    }
    expect(total / 5400).toBeLessThan(4);
  }
}, 20000); // ≈ 2.6 s alone; a full parallel run can take longer than vitest's 5 s default
