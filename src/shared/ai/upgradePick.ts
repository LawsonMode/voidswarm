// OWNER: AI agent. Level-up card picking for bots (v0.2: paths, talents, general cards).
// Matches exact ids first (data/ships.ts paths/talents, sim/pve/upgrades.ts general cards), then
// keywords/category, so unknown or renamed ids still get a sensible score and never throw.
import { SHIP_CLASSES } from '../data/ships';
import type { BotSkill, GameMode, PathId, Ship, ShipClassId, UpgradeChoice } from '../types';
import type { Rng } from '../util/rng';

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/** Base path weights per class (sum ≈ 1). */
const PATH_WEIGHTS: Record<ShipClassId, Partial<Record<PathId, number>>> = {
  brute: { ram: 0.4, barrage: 0.35, bulwark: 0.25 },
  tech: { storm: 0.4, void: 0.3, lance: 0.3 },
  engineer: { summoner: 0.35, medic: 0.4, architect: 0.25 },
};

/** Paths whose value depends on teammates (turret stations, healing). Down-weighted in FFA. */
const TEAM_PATHS: ReadonlySet<string> = new Set(['bulwark', 'medic', 'architect']);

export function pathIdOf(choice: UpgradeChoice): string {
  const id = String(choice.id ?? '');
  return id.startsWith('path:') ? id.slice(5) : id;
}

function pickPath(skill: BotSkill, rng: Rng, ship: Ship, offer: UpgradeChoice[], mode: GameMode): number {
  if (skill === 'easy' && rng.chance(0.5)) return rng.int(0, offer.length - 1);
  const w = PATH_WEIGHTS[ship.shipClass] ?? {};
  const weights = offer.map((c) => {
    const p = pathIdOf(c);
    let v = (w as Record<string, number>)[p] ?? 0.2;
    if (mode === 'ffa' && TEAM_PATHS.has(p)) v *= p === 'medic' ? 0.35 : 0.25;
    return Math.max(0.01, v);
  });
  let total = 0;
  for (const v of weights) total += v;
  let r = rng.next() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

// ---------------------------------------------------------------------------------------------
// Talents
// ---------------------------------------------------------------------------------------------

/** Preferred talent order per path (first = most wanted). */
const TALENT_ORDER: Record<PathId, string[]> = {
  ram: ['ram_unstoppable', 'ram_momentum', 'ram_quake', 'ram_plating'],
  barrage: ['bar_heavy', 'bar_cluster', 'bar_autolauncher', 'bar_napalm'],
  bulwark: ['bul_titan', 'bul_clamp', 'bul_fortress', 'bul_reflect'],
  storm: ['sto_overload', 'sto_static', 'sto_forked', 'sto_thunder'],
  void: ['voi_horizon', 'voi_collapse', 'voi_entropy', 'voi_riftstep'],
  lance: ['lan_coils', 'lan_rail', 'lan_sniper', 'lan_focus'],
  summoner: ['sum_overclock', 'sum_drones', 'sum_hardened', 'sum_salvage'],
  medic: ['med_beam', 'med_triage', 'med_nanites', 'med_revive'],
  architect: ['arc_turretbay', 'arc_tesla', 'arc_reinforced', 'arc_minefield'],
};

function talentRank(ship: Ship, id: string): number {
  const path = ship.path;
  if (path && TALENT_ORDER[path]) {
    const i = TALENT_ORDER[path].indexOf(id);
    if (i >= 0) return i;
  }
  // unknown talent: fall back to its order in the class catalog, else last
  for (const p of SHIP_CLASSES[ship.shipClass]?.paths ?? []) {
    const i = p.talents.findIndex((t) => t.id === id);
    if (i >= 0) return 4 + i;
  }
  return 99;
}

function pickTalent(skill: BotSkill, rng: Rng, ship: Ship, offer: UpgradeChoice[]): number {
  if (skill === 'easy') return rng.int(0, offer.length - 1);
  if (skill === 'normal' && rng.chance(0.2)) return rng.int(0, offer.length - 1);
  let best = 0, bestR = Infinity;
  for (let i = 0; i < offer.length; i++) {
    const r = talentRank(ship, String(offer[i].id ?? ''));
    if (r < bestR) { bestR = r; best = i; }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// General cards
// ---------------------------------------------------------------------------------------------

type Tag = 'gun' | 'skill' | 'auto' | 'energy' | 'defense' | 'mobility' | 'utility' | 'turret' | 'damage' | 'cooldown' | 'heal';

const ID_TAGS: Record<string, Tag> = {
  heavy: 'gun', rapid: 'gun', multi: 'gun', velocity: 'gun',
  amplifier: 'skill', medkit: 'heal',
  capacitor: 'energy', reactor: 'energy', efficiency: 'energy', overcharge: 'energy',
  plating: 'defense', thrusters: 'mobility', magnet: 'utility', scholar: 'utility',
  overclock: 'damage', fluxcore: 'cooldown', turretmount: 'turret',
  orbit: 'auto', seeker: 'auto', nova: 'auto', arc: 'auto', minetrail: 'auto',
};

const KEYWORDS: [RegExp, Tag][] = [
  [/turret|mount|slot/, 'turret'],
  [/heal|medkit|repair|regen/, 'heal'],
  [/amplif|skill|power|payload|rocket|sentry/, 'skill'],
  [/flux|cooldown|haste/, 'cooldown'],
  [/gun|barrel|rapid|bullet|round|multi|velocity|pierce|spread|cycler/, 'gun'],
  [/orbit|seeker|nova|arc|lightning|trail|blade|swarm|mine/, 'auto'],
  [/capacitor|reactor|energy|recharge|coil|efficien|battery/, 'energy'],
  [/plating|armor|armour|shield|hull/, 'defense'],
  [/thrust|speed|engine|boost/, 'mobility'],
  [/overclock|damage/, 'damage'],
];

const CLASS_PREFS: Record<ShipClassId, Partial<Record<Tag, number>>> = {
  brute: { gun: 1.2, defense: 1.3, energy: 1.2, damage: 1.2, auto: 1.0, mobility: 1.0, skill: 1.0, cooldown: 0.9, heal: 0.6, utility: 0.5, turret: 0.3 },
  tech: { damage: 1.3, energy: 1.3, skill: 1.3, cooldown: 1.2, gun: 1.0, auto: 1.0, mobility: 0.8, defense: 0.7, heal: 0.6, utility: 0.6, turret: 0.2 },
  engineer: { skill: 1.2, energy: 1.2, cooldown: 1.1, auto: 1.1, heal: 1.0, defense: 0.9, utility: 0.8, gun: 0.7, damage: 0.9, mobility: 0.7, turret: 0.5 },
};

/** Path overrides on top of class prefs. */
const PATH_PREFS: Partial<Record<PathId, Partial<Record<Tag, number>>>> = {
  ram: { mobility: 1.35, cooldown: 1.2, defense: 1.4 },
  barrage: { skill: 1.5, damage: 1.35 },
  bulwark: { turret: 1.6, energy: 1.4, defense: 1.4 },
  storm: { skill: 1.5, cooldown: 1.3 },
  void: { cooldown: 1.45, skill: 1.35 },
  lance: { gun: 1.5, damage: 1.4 },
  summoner: { skill: 1.5, cooldown: 1.3 },
  medic: { heal: 1.6, cooldown: 1.4, energy: 1.3 },
  architect: { turret: 1.4, skill: 1.3, defense: 1.2 },
};

export function tagOf(choice: UpgradeChoice): Tag {
  const id = String(choice.id ?? '').toLowerCase();
  if (ID_TAGS[id]) return ID_TAGS[id];
  const text = id + ' ' + String(choice.name ?? '').toLowerCase();
  for (const [re, tag] of KEYWORDS) if (re.test(text)) return tag;
  if (choice.category === 'auto') return 'auto';
  if (choice.category === 'weapon') return 'gun';
  return 'utility';
}

export function scoreUpgrade(ship: Ship, choice: UpgradeChoice): number {
  const tag = tagOf(choice);
  const pp = ship.path ? PATH_PREFS[ship.path] : undefined;
  let s = pp?.[tag] ?? CLASS_PREFS[ship.shipClass]?.[tag] ?? 0.6;
  const owned = ship.upgrades?.[choice.id] ?? 0;
  if (owned > 0) s += 0.25; // build focus: stack what we already have
  if (tag === 'auto') {
    let autos = 0;
    for (const k in ship.upgrades) if (ID_TAGS[k] === 'auto' && ship.upgrades[k] > 0) autos++;
    if (owned === 0) s += autos < 2 ? 0.3 : -0.3;
  }
  if (tag === 'turret' && ship.stats.maxTurrets <= 0) s -= 0.5;
  if (choice.id === 'overcharge') s = 0.3 + (1 - ship.energy / Math.max(1, ship.stats.maxEnergy));
  return s;
}

export function pickUpgrade(
  skill: BotSkill, rng: Rng, ship: Ship, offer: UpgradeChoice[], mode: GameMode = 'teams',
): number {
  if (!offer || offer.length === 0) return 0;
  const cat = offer[0]?.category;
  if (cat === 'path' || offer.every((c) => String(c.id ?? '').startsWith('path:'))) return pickPath(skill, rng, ship, offer, mode);
  if (cat === 'talent') return pickTalent(skill, rng, ship, offer);
  if (skill === 'easy' && rng.chance(0.6)) return rng.int(0, offer.length - 1);
  const noise = skill === 'easy' ? 0.8 : skill === 'normal' ? 0.3 : 0.05;
  let best = 0, bestS = -Infinity;
  for (let i = 0; i < offer.length; i++) {
    let s: number;
    try { s = scoreUpgrade(ship, offer[i]); } catch { s = 0.5; }
    if (mode === 'ffa' && tagOf(offer[i]) === 'turret') s -= 0.6;
    s += rng.range(-noise, noise);
    if (s > bestS) { bestS = s; best = i; }
  }
  return best;
}
