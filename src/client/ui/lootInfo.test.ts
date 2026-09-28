// Pure loot presentation (lootInfo.ts), the shared banner queue, and the Hangar hull geometry bounds.
import { describe, expect, it } from 'vitest';
import { COSMETIC_LIST, COSMETICS, starterId } from '../../shared/data/cosmetics';
import { PITY_EPIC, PITY_LEGENDARY, SALVAGE_VALUE } from '../../shared/data/loot';
import { applyGrant } from '../../shared/profile/rolls';
import type { LootGrant, MatchResult, Profile } from '../../shared/protocol';
import type { GameEvent, LootView } from '../../shared/types';
import { BANNER_QUEUE_MAX, BANNER_STALE_MS, BannerQueue } from './bannerQueue';
import { baseHull, HULL_EXTENT_MAX, hullExtent, hullPoints, shotSize } from './cosmeticIcons';
import {
  asDeviceGrant, cacheInReach, cacheLabel, carriedByPlayer, collection, debriefRows, drawsProgressLine, dropsInText, dropSourceLines,
  epicWithin, equippedId, freshIds, grantSummary, hangarButtonText, hangarItems, killiconGlyph, legendaryWithin, localLook,
  lootBannerFor, othersHighlights, pityLine, revealCount, setTotal, tileState, trayHint, trayModel, wonMatch,
} from './lootInfo';

function profile(extra: Partial<Profile> = {}): Profile {
  return {
    v: 1, owned: {}, shards: 0, loadout: { shared: {}, byClass: {} }, fresh: [], pity: {}, pityLegendary: 0,
    stats: { matches: 0, wins: 0, cachesSecured: 0, cachesLost: 0, byType: {} }, recent: [], updatedAt: 0, ...extra,
  };
}
const own = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, { at: 1, src: 'warzone' as const }]));

describe('collection counts + pity (Command draws strip, Hangar header)', () => {
  it('counts owned items per set out of 13', () => {
    expect(setTotal('swarm')).toBe(13);
    const p = profile({ owned: own('swarm.hull.tech', 'swarm.title.hivebreaker', 'rift.hull.brute', 'bogus.id') });
    expect(collection(p, 'swarm')).toEqual({ have: 2, total: 13 });
    expect(collection(p, 'rift')).toEqual({ have: 1, total: 13 });
    expect(collection(null, 'common')).toEqual({ have: 0, total: 13 });
  });

  it('"Epic within n crates" counts down from PITY_EPIC and never below 1', () => {
    expect(epicWithin(profile(), 'warzone')).toBe(PITY_EPIC);
    expect(epicWithin(profile({ pity: { warzone: 5 } }), 'warzone')).toBe(PITY_EPIC - 5);
    expect(epicWithin(profile({ pity: { warzone: 99 } }), 'warzone')).toBe(1);
    expect(epicWithin(profile({ pity: { arena: 5 } }), 'warzone')).toBe(PITY_EPIC);
    expect(legendaryWithin(profile({ pityLegendary: 10 }))).toBe(PITY_LEGENDARY - 10);
  });

  it('the card line only appears once a profile is loaded', () => {
    expect(drawsProgressLine(null, 'warzone')).toBe('');
    const p = profile({ owned: own('swarm.hull.tech'), pity: { warzone: 11 } });
    expect(drawsProgressLine(p, 'warzone')).toBe('Collected 1/13 · Epic within 1 crate');
    expect(drawsProgressLine(p, 'arena')).toBe(`Collected 0/13 · Epic within ${PITY_EPIC} crates`);
    expect(drawsProgressLine(p, 'warzone', false)).toBe('Collected 1/13'); // online guest: no pity promise
  });

  it('Hangar button shows shards and the NEW count (only real, owned fresh ids)', () => {
    expect(hangarButtonText(null)).toBe('Hangar');
    const p = profile({ shards: 120, owned: own('swarm.hull.tech', 'rift.hull.brute'), fresh: ['swarm.hull.tech', 'rift.hull.brute', 'nope', 'glad.hull.brute'] });
    expect(freshIds(p)).toEqual(['swarm.hull.tech', 'rift.hull.brute']);
    expect(hangarButtonText(p)).toBe('Hangar ◆120 •2 NEW');
    expect(hangarButtonText(profile({ shards: 3 }))).toBe('Hangar ◆3');
  });
});

describe('loadout reads (defensive against server JSON)', () => {
  it('equippedId falls back to the starter for unknown, wrong-slot, wrong-class or unowned ids', () => {
    const p = profile({
      owned: own('rift.hull.brute', 'swarm.hull.tech', 'com.engine.aurora'),
      loadout: {
        shared: { engine: 'com.engine.aurora', death: 'com.death.glass' /* not owned */, title: 'rift.hull.brute' /* wrong slot */ },
        byClass: { brute: { hull: 'rift.hull.brute', weapon: 'nope' }, tech: { hull: 'rift.hull.brute' /* wrong class */ } },
      },
    });
    expect(equippedId(p, 'hull', 'brute')).toBe('rift.hull.brute');
    expect(equippedId(p, 'weapon', 'brute')).toBe(starterId('weapon', 'brute'));
    expect(equippedId(p, 'hull', 'tech')).toBe('std.hull.tech');
    expect(equippedId(p, 'engine', 'tech')).toBe('com.engine.aurora');
    expect(equippedId(p, 'death', 'tech')).toBe('std.death');
    expect(equippedId(p, 'title', 'tech')).toBe('std.title');
    expect(equippedId(null, 'turret', 'engineer')).toBe('std.turret.seekerpod');
    // the look omits starters
    expect(localLook(p, 'brute')).toEqual({ hull: 'rift.hull.brute', engine: 'com.engine.aurora' });
  });
});

describe('Hangar grid', () => {
  it('lists the slot items for the class: starter first, then by set and rarity; filters work', () => {
    const all = hangarItems('hull', 'brute', 'all', null);
    expect(all[0].id).toBe('std.hull.brute');
    expect(all.every((d) => d.slot === 'hull' && d.shipClass === 'brute')).toBe(true);
    expect(all.map((d) => d.id)).toEqual(['std.hull.brute', 'com.hull.brute', 'rift.hull.brute', 'glad.hull.brute', 'swarm.hull.brute']);
    expect(hangarItems('turret', 'tech', 'all', null).every((d) => d.slot === 'turret' && d.kit === 'laser')).toBe(true);
    expect(hangarItems('engine', 'tech', 'rift', null).map((d) => d.id)).toEqual(['rift.engine.abyss']);
    const p = profile({ owned: own('swarm.hull.brute') });
    expect(hangarItems('hull', 'brute', 'owned', p).map((d) => d.id)).toEqual(['std.hull.brute', 'swarm.hull.brute']);
  });

  it('tile states: equipped / owned / locked / NEW', () => {
    const p = profile({ owned: own('swarm.hull.brute'), fresh: ['swarm.hull.brute'], loadout: { shared: {}, byClass: { brute: { hull: 'swarm.hull.brute' } } } });
    expect(tileState(p, COSMETICS['swarm.hull.brute'], 'hull', 'brute')).toEqual({ equipped: true, owned: true, locked: false, fresh: true });
    expect(tileState(p, COSMETICS['std.hull.brute'], 'hull', 'brute')).toEqual({ equipped: false, owned: true, locked: false, fresh: false });
    expect(tileState(p, COSMETICS['rift.hull.brute'], 'hull', 'brute').locked).toBe(true);
    expect(dropsInText(COSMETICS['rift.hull.brute'])).toBe('Drops in: Dungeon Runner');
    expect(dropsInText(COSMETICS['com.hull.brute'])).toBe('Drops in: any mode');
    expect(dropSourceLines(COSMETICS['rift.hull.brute']).join(' ')).toMatch(/Epic pity/);
    expect(dropSourceLines(COSMETICS['std.hull.brute'])[0]).toMatch(/Starter/);
  });
});

describe('HUD tray, banners, kill icon', () => {
  it('tray: hidden when empty, pips highest first, full at the cap, per-mode hint', () => {
    expect(trayModel(null, 'warzone')).toBeNull();
    expect(trayModel({ carried: [], carryCap: 8 }, 'warzone')).toBeNull();
    const t = trayModel({ carried: [{ rarity: 0, set: 'common' }, { rarity: 3, set: 'swarm' }, { rarity: 1, set: 'common' }], carryCap: 3 }, 'warzone')!;
    expect(t.pips).toEqual([3, 1, 0]);
    expect(t.full).toBe(true);
    expect(t.best).toBe(3);
    expect(t.hint).toBe('Survive to the end');
    expect(trayHint('dungeon')).toBe('Extract to bank');
    expect(trayModel({ carried: [{ rarity: 2, set: 'rift' }], carryCap: 24 }, 'dungeon')!.full).toBe(false);
  });

  it('kill icon: the killer\'s equipped glyph, else the starter ✦', () => {
    expect(killiconGlyph(undefined)).toBe('✦');
    expect(killiconGlyph({ killicon: 'glad.killicon.gladius' })).toBe('†');
    expect(killiconGlyph({ killicon: 'swarm.hull.tech' })).toBe('✦'); // not a killicon
    expect(killiconGlyph({ killicon: 'missing' })).toBe('✦');
  });

  it('loot banners only for the local pilot (epic+ drops for anyone nearby)', () => {
    const me = 7;
    const pickup: GameEvent = { t: 'lootPickup', playerId: me, shipId: 1, x: 0, y: 0, rarity: 2, set: 'swarm', carried: 3 };
    expect(lootBannerFor(pickup, me)!.text).toBe('+ RARE SWARM CACHE');
    expect(lootBannerFor({ ...pickup, playerId: 8 }, me)).toBeNull();
    expect(lootBannerFor({ t: 'lootSpill', playerId: me, x: 0, y: 0, count: 3, best: 1 }, me)!.text).toBe('3 CACHES SPILLED');
    expect(lootBannerFor({ t: 'lootSpill', playerId: me, x: 0, y: 0, count: 0, best: 0 }, me)).toBeNull();
    expect(lootBannerFor({ t: 'lootSecured', playerId: me, how: 'extract', tokens: [{ rarity: 4, set: 'rift', source: 'bossCache' }] }, me))
      .toMatchObject({ text: '1 CACHE SECURED', rarity: 4 });
    expect(lootBannerFor({ t: 'lootDrop', id: 1, x: 0, y: 0, rarity: 2, set: 'common', source: 'elite' }, me)).toBeNull();
    expect(lootBannerFor({ t: 'lootDrop', id: 1, x: 0, y: 0, rarity: 3, set: 'common', source: 'boss' }, me)!.text).toBe('EPIC CACHE DROPPED');
    expect(cacheLabel(4, 'rift')).toBe('Legendary Rift Cache');
  });

  it('HOLD FULL proximity ignores caches reserved for someone else', () => {
    const l = (x: number, reservedFor = 0): LootView => ({ id: x, x, y: 0, rarity: 0, set: 'common', reservedFor, lifeFrac: 1 });
    expect(cacheInReach([l(100)], 0, 0, 50, 7)).toBe(false);
    expect(cacheInReach([l(30)], 0, 0, 50, 7)).toBe(true);
    expect(cacheInReach([l(30, 9)], 0, 0, 50, 7)).toBe(false);
    expect(cacheInReach([l(30, 7)], 0, 0, 50, 7)).toBe(true);
    expect(cacheInReach(undefined, 0, 0, 50, 7)).toBe(false);
  });

  it('carried column maps carrier ship ids to players', () => {
    const m = carriedByPlayer([{ id: 11, playerId: 1 }, { id: 12, playerId: 2 }], [{ shipId: 12, n: 4, best: 3 }, { shipId: 99, n: 1, best: 0 }]);
    expect([...m]).toEqual([[2, { n: 4, best: 3 }]]);
    expect(carriedByPlayer(undefined, undefined).size).toBe(0);
  });
});

describe('Debrief', () => {
  const grant: LootGrant = {
    grantKey: 'b:1#acc#0', gameType: 'warzone', shards: 55, cachesSecured: 2, cachesLost: 1, epicIn: 7, legendaryIn: 41,
    items: [
      { itemId: 'swarm.hull.tech', rarity: 3, from: 'crate', dupe: false, shards: 0 },
      { itemId: 'com.title.wingman', rarity: 0, from: 'cache', source: 'elite', dupe: true, shards: 5 },
    ],
  };

  it('reveals one item per 350 ms, the first after one step', () => {
    expect(revealCount(0, 3)).toBe(0);
    expect(revealCount(349, 3)).toBe(0);
    expect(revealCount(350, 3)).toBe(1);
    expect(revealCount(700, 3)).toBe(2);
    expect(revealCount(10_000, 3)).toBe(3);
    expect(revealCount(10_000, 0)).toBe(0);
  });

  it('rows: names, NEW vs DUPLICATE → +N shards', () => {
    const rows = debriefRows(grant);
    expect(rows.map((r) => r.name)).toEqual(['Mantis', 'Wingman']);
    expect(rows[0].tag).toBe('NEW');
    expect(rows[0].detail).toBe('Hull · Swarm Set');
    expect(rows[1].tag).toBe('DUPLICATE → +5 shards');
    expect(rows[1].fromLabel).toBe('Cache');
    expect(pityLine(grant)).toBe('Epic within 7 crates · Legendary within 41');
    expect(grantSummary(grant)).toBe('Loot banked: 2 items (1 new) · ◆ +55');
    expect(grantSummary({ ...grant, items: [], shards: 0 })).toBe('');
  });

  it('wonMatch mirrors the Room: team win, or top 3 in FFA', () => {
    const s = (playerId: number, score: number) => ({ playerId, score, kills: 0, deaths: 0, enemyKills: 0, bounty: 0, level: 1 });
    const r = { winnerTeam: 1, scores: [s(1, 50), s(2, 40), s(3, 30), s(4, 20)] };
    expect(wonMatch(r, 7, 1, false)).toBe(true);
    expect(wonMatch(r, 7, 0, false)).toBe(false);
    expect(wonMatch({ ...r, winnerTeam: -1 }, 3, -1, true)).toBe(true);
    expect(wonMatch({ ...r, winnerTeam: -1 }, 4, -1, true)).toBe(false);
    expect(wonMatch(null, 1, 0, false)).toBe(false);
  });

  it('highlights: other pilots\' epic+ reveals only, strongest first', () => {
    const r: Pick<MatchResult, 'lootHighlights'> = {
      lootHighlights: [
        { playerId: 7, itemId: 'swarm.hull.tech', rarity: 3 },
        { playerId: 8, itemId: 'swarm.hull.tech', rarity: 3 },
        { playerId: 9, itemId: 'swarm.turret.laser', rarity: 4 },
        { playerId: 10, itemId: 'com.hull.brute', rarity: 2 },
      ],
    };
    expect(othersHighlights(r, 7).map((x) => [x.playerId, x.itemName])).toEqual([[9, "Queen's Gaze"], [8, 'Mantis']]);
    expect(othersHighlights(null, 7)).toEqual([]);
  });
});

describe('BannerQueue (the HUD\'s one shared banner spot)', () => {
  it('shows at once when free, queues equal priority, lets higher priority interrupt', () => {
    const q = new BannerQueue();
    q.push({ text: 'A', kind: 'loot', priority: 1, ms: 1000 }, 0);
    expect(q.current(10)!.text).toBe('A');
    q.push({ text: 'B', kind: 'loot', priority: 1, ms: 1000 }, 20);
    expect(q.current(500)!.text).toBe('A');
    expect(q.current(1001)!.text).toBe('B');
    q.push({ text: 'BOSS', kind: 'boss', priority: 3, ms: 1000 }, 1100);
    expect(q.current(1100)!.text).toBe('BOSS');
    expect(q.current(2200)).toBeNull();
  });

  it('drops stale queued banners and caps the queue', () => {
    const q = new BannerQueue();
    q.push({ text: 'long', kind: 'wave', priority: 2, ms: BANNER_STALE_MS + 1000 }, 0);
    q.push({ text: 'late', kind: 'loot', priority: 1, ms: 500 }, 0);
    expect(q.current(BANNER_STALE_MS + 1500)).toBeNull();
    const q2 = new BannerQueue();
    q2.push({ text: 'cur', kind: 'wave', priority: 2, ms: 1000 }, 0);
    for (let i = 0; i < BANNER_QUEUE_MAX + 2; i++) q2.push({ text: `w${i}`, kind: 'loot', priority: 1, ms: 100 }, 1);
    const seen: string[] = [];
    let t = 1000;
    for (let i = 0; i < 10; i++) { const b = q2.current(t); if (b) seen.push(b.text); t += 200; }
    expect(seen.length).toBe(BANNER_QUEUE_MAX);
    expect(seen[seen.length - 1]).toBe(`w${BANNER_QUEUE_MAX + 1}`);
  });

  it('currentSeq changes whenever a new banner starts', () => {
    const q = new BannerQueue();
    expect(q.currentSeq).toBe(0);
    q.push({ text: 'A', kind: 'loot', priority: 1, ms: 100 }, 0);
    const a = q.currentSeq;
    q.push({ text: 'B', kind: 'loot', priority: 1, ms: 100 }, 0);
    q.current(250); // A shows ≥ 200 ms
    expect(q.currentSeq).not.toBe(a);
  });
});

describe('Hangar hull preview geometry (readability bounds)', () => {
  it('every catalog hull stays within 1.12× the base silhouette, displacement ≤ 0.18', () => {
    for (const d of COSMETIC_LIST) {
      if (d.slot !== 'hull') continue;
      const base = hullExtent(baseHull(d.shipClass));
      const pts = hullPoints(d.shipClass, { ...d.p, amount: 1 });
      expect(hullExtent(pts)).toBeLessThanOrEqual(base * HULL_EXTENT_MAX + 1e-9);
      expect(pts.length).toBeGreaterThanOrEqual(baseHull(d.shipClass).length);
    }
    expect(hullPoints('tech')).toEqual(baseHull('tech'));
  });

  it('shot length scales with lengthMul (clamped 0.8–1.6); width does not', () => {
    const a = shotSize({ shape: 'needle', lengthMul: 1 });
    const b = shotSize({ shape: 'needle', lengthMul: 1.5 });
    expect(b.len / a.len).toBeCloseTo(1.5);
    expect(b.wid).toBe(a.wid);
    expect(shotSize({ shape: 'std', lengthMul: 5 }).len / shotSize({ shape: 'std', lengthMul: 1 }).len).toBeCloseTo(1.6);
  });
});

describe('asDeviceGrant (online guests: the Debrief matches what the device applies)', () => {
  const g: LootGrant = {
    grantKey: 'z:1#guest:4#0', gameType: 'warzone', shards: 12, cachesSecured: 1, cachesLost: 0, epicIn: 11, legendaryIn: 59,
    items: [
      { itemId: 'swarm.hull.tech', rarity: COSMETICS['swarm.hull.tech'].rarity, from: 'crate', dupe: false, shards: 0 },
      { itemId: 'com.engine.aurora', rarity: COSMETICS['com.engine.aurora'].rarity, from: 'cache', dupe: false, shards: 0 },
    ],
  };
  it('marks items the device already owns as duplicates worth their salvage value', () => {
    const p = profile({ owned: own('com.engine.aurora') });
    const d = asDeviceGrant(g, p);
    expect(d.items[0]).toBe(g.items[0]);
    expect(d.items[1]).toMatchObject({ itemId: 'com.engine.aurora', dupe: true, shards: SALVAGE_VALUE[COSMETICS['com.engine.aurora'].rarity] });
    expect(d.shards).toBe(12 + SALVAGE_VALUE[COSMETICS['com.engine.aurora'].rarity]);
    expect(debriefRows(d)[1].dupe).toBe(true);
    // applying either grant gives the same profile (applyGrant's own device-duplicate rule), so nothing is double-paid
    const a = applyGrant(p, g, 5), b = applyGrant(p, d, 5);
    expect(b.owned).toEqual(a.owned);
    expect(b.shards).toBe(a.shards);
    expect(b.pity).toEqual(a.pity);
  });
  it('returns the grant untouched when nothing is owned (or there is no profile)', () => {
    expect(asDeviceGrant(g, profile())).toBe(g);
    expect(asDeviceGrant(g, null)).toBe(g);
  });
});
