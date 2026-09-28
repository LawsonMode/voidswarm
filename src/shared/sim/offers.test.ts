// Real sim + real PVE (no mocks): upgrade-offer serials, class swaps with queued offers, and
// Reactive Plating against a ship that takes no damage.
import { describe, expect, it } from 'vitest';
import type { Ship, ShipClassId, SimConfig } from '../types';
import { grantXp } from './pve/index';
import { spawnEnemy } from './pve/enemies';
import { computeStats } from './pve/upgrades';
import { Sim } from './Sim';

const cfg: SimConfig = {
  mapSeed: 4242, mode: 'teams', teamCount: 2, pveIntensity: 0, matchSeconds: 600, scoreLimit: 0, friendlyFire: false,
};

function setup(cls: ShipClassId): { sim: Sim; s: Ship } {
  const sim = new Sim(cfg);
  const id = sim.addPlayer({ playerId: 1, name: 'a', team: 0, shipClass: cls, isBot: false });
  return { sim, s: sim.world.ships.get(id)! };
}
function levelTo(sim: Sim, s: Ship, level: number): void {
  while (s.level < level) grantXp(sim.world, s, s.xpToNext - s.xp + 0.001);
}
const ids = (s: Ship, i: number) => s.offers[i].map((c) => c.id);

describe('offer serial (chooseUpgrade offerId)', () => {
  it('starts at 0, +1 per consumed offer; mismatched offerId ignored; double-press spends one offer', () => {
    const { sim, s } = setup('brute');
    expect(s.offerSerial).toBe(0);
    levelTo(sim, s, 4); // 3 queued offers (lv2, lv3 path, lv4)
    expect(s.offers.length).toBe(3);
    sim.chooseUpgrade(1, 0, 7); // wrong id
    expect(s.offers.length).toBe(3);
    expect(s.offerSerial).toBe(0);
    sim.chooseUpgrade(1, 0, 0);
    sim.chooseUpgrade(1, 0, 0); // the same click delivered twice
    expect(s.offers.length).toBe(2);
    expect(s.offerSerial).toBe(1);
    expect(s.path).toBe(null); // the lv3 path offer was not spent by the duplicate
    expect(ids(s, 0)).toEqual(['path:ram', 'path:barrage', 'path:bulwark']);
    sim.chooseUpgrade(1, 1, 1);
    expect(s.path).toBe('barrage');
    expect(s.offerSerial).toBe(2);
    sim.chooseUpgrade(1, 0); // bots: no offerId = current offer
    expect(s.offers.length).toBe(0);
    expect(s.offerSerial).toBe(3);
    sim.chooseUpgrade(1, 0); // nothing queued: no-op
    expect(s.offerSerial).toBe(3);
  });

  it('an invalid index consumes nothing', () => {
    const { sim, s } = setup('tech');
    levelTo(sim, s, 2);
    sim.chooseUpgrade(1, 5, 0);
    sim.chooseUpgrade(1, -1, 0);
    expect(s.offers.length).toBe(1);
    expect(s.offerSerial).toBe(0);
  });
});

describe('F3: setShipClass rebuilds queued offers', () => {
  it('a queued brute path offer becomes a tech path offer, and the level is not wasted', () => {
    const { sim, s } = setup('brute');
    levelTo(sim, s, 3);
    expect(ids(s, 1)).toEqual(['path:ram', 'path:barrage', 'path:bulwark']);
    sim.setShipClass(1, 'tech');
    expect(s.offers.length).toBe(2);
    expect(ids(s, 1)).toEqual(['path:storm', 'path:void', 'path:lance']);
    expect(s.offerSerial).toBe(1); // old-class cards on screen are now stale
    sim.chooseUpgrade(1, 0, 0); // a click on the old brute offer: ignored
    expect(s.offers.length).toBe(2);
    sim.chooseUpgrade(1, 0, 1); // lv2 general
    sim.chooseUpgrade(1, 2, 2); // lv3 path
    expect(s.path).toBe('lance');
    expect(s.upgrades['path:lance']).toBe(1);
    expect(s.offers.length).toBe(0);
  });

  it('class-only cards do not survive the swap; same-class respawn does not reroll offers', () => {
    const { sim, s } = setup('engineer');
    levelTo(sim, s, 2);
    s.offers[0] = [{ id: 'medkit', name: 'Medkit', description: '', level: 1, maxLevel: 3, category: 'passive', icon: '' }];
    sim.setShipClass(1, 'engineer');
    expect(ids(s, 0)).toEqual(['medkit']);
    expect(s.offerSerial).toBe(0);
    sim.setShipClass(1, 'brute');
    expect(ids(s, 0)).not.toContain('medkit');
    expect(s.offers[0].length).toBe(3);
  });

  it('a stale card that cannot be applied re-offers the level instead of eating it', () => {
    const { sim, s } = setup('tech');
    levelTo(sim, s, 3);
    sim.chooseUpgrade(1, 0); // lv2
    s.offers[0] = [{ id: 'path:ram', name: 'x', description: '', level: 1, maxLevel: 1, category: 'path', icon: '' }];
    const serial = s.offerSerial;
    sim.chooseUpgrade(1, 0); // brute path on a tech: rejected
    expect(s.path).toBe(null);
    expect(s.upgrades['path:ram']).toBeUndefined();
    expect(s.offerSerial).toBe(serial + 1);
    expect(s.offers.length).toBe(1);
    expect(ids(s, 0)).toEqual(['path:storm', 'path:void', 'path:lance']);
  });
});

describe('F11: Reactive Plating reflects only damage actually taken', () => {
  function plated(): { sim: Sim; s: Ship } {
    const r = setup('brute');
    r.s.upgrades['path:ram'] = 1; r.s.upgrades.ram_plating = 1;
    r.s.stats = computeStats('brute', r.s.upgrades);
    r.s.path = 'ram';
    return r;
  }

  it('spawn-invulnerable ship: no energy lost, nothing reflected', () => {
    const { sim, s } = plated();
    const w = sim.world;
    s.invulnUntilTick = w.tick + 1000;
    const e = spawnEnemy(w, 'brute', s.x + s.stats.radius + 10, s.y)!;
    const hp = e.hp, en = s.energy;
    sim.step();
    expect(s.energy).toBeCloseTo(en, 6);
    expect(e.hp).toBe(hp);
  });

  it('vulnerable ship: reflects 25% of the energy it lost', () => {
    const { sim, s } = plated();
    const w = sim.world;
    s.invulnUntilTick = 0;
    s.stats.rechargePerSec = 0;
    const e = spawnEnemy(w, 'brute', s.x + s.stats.radius + 10, s.y)!;
    const hp = e.hp, en = s.energy;
    sim.step();
    const lost = en - s.energy;
    expect(lost).toBeGreaterThan(0);
    expect(hp - e.hp).toBeCloseTo(lost * 0.25, 6);
  });
});
