// OWNER: PVE agent. Frozen signatures.
import { PATHS, SHIP_CLASSES, pathKey } from '../../data/ships';
import type { PathId, ShipClassId, ShipStats, UpgradeId } from '../../types';

export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  icon: string;
  category: 'weapon' | 'auto' | 'passive';
  maxLevel: number;
  /** Description for the level being gained (1-based). */
  describe(level: number): string;
  /** Optional class restriction. */
  classes?: readonly ShipClassId[];
}

// ---------------------------------------------------------------------------------------------
// Tuning (shared with autoweapons.ts so descriptions and behaviour agree)
// ---------------------------------------------------------------------------------------------

/** Auto-weapon tuning per level (1..5). */
export const AUTO = {
  orbit: {
    blades: (lv: number) => lv + 1,
    damage: (lv: number) => 45 + 20 * lv,
    bladeRadius: 12,
    hitCooldownSec: 0.4,
  },
  seeker: {
    cooldown: (lv: number) => 2.4 - 0.25 * lv,
    count: (lv: number) => 1 + Math.floor(lv / 2),
    damage: (lv: number) => 90 + 30 * lv,
    speed: 440,
    range: 650,
    splash: 40,
  },
  nova: {
    cooldown: (lv: number) => 4.2 - 0.35 * lv,
    radius: (lv: number) => 140 + 22 * lv,
    damage: (lv: number) => 130 + 55 * lv,
  },
  arc: {
    cooldown: (lv: number) => 1.9 - 0.2 * lv,
    hops: (lv: number) => 2 + lv,
    damage: (lv: number) => 80 + 28 * lv,
    hopRange: 250,
  },
  minetrail: {
    cooldown: (lv: number) => 1.5 - 0.17 * lv,
    damage: (lv: number) => 180 + 60 * lv,
    splash: (lv: number) => 70 + 6 * lv,
    lifeSec: 7,
    minSpeed: 120,
  },
} as const;

const defs: UpgradeDef[] = [
  // --- primary weapon tweaks ---
  { id: 'heavy', name: 'Heavy Rounds', icon: '🔩', category: 'weapon', maxLevel: 5,
    describe: () => `Primary damage +15%.` },
  { id: 'rapid', name: 'Rapid Cycler', icon: '⚡', category: 'weapon', maxLevel: 5,
    describe: () => `Primary cooldown -10%.` },
  { id: 'multi', name: 'Multi-fire', icon: '🔱', category: 'weapon', maxLevel: 3,
    describe: (lv) => `+1 primary barrel (${lv} extra), wider spread.` },
  { id: 'velocity', name: 'Hypervelocity', icon: '➶', category: 'weapon', maxLevel: 4,
    describe: () => `Primary projectile speed +12%, range +8%.` },
  // --- passives ---
  { id: 'amplifier', name: 'Amplifier', icon: '📡', category: 'passive', maxLevel: 5,
    describe: () => `Secondary and utility skill power +12%.` },
  { id: 'fluxcore', name: 'Flux Core', icon: '⏳', category: 'passive', maxLevel: 4,
    describe: () => `Secondary, mobility and utility cooldowns -10%.` },
  { id: 'efficiency', name: 'Efficient Coils', icon: '♻', category: 'passive', maxLevel: 4,
    describe: () => `All skill energy costs -10%.` },
  { id: 'capacitor', name: 'Capacitor', icon: '🔋', category: 'passive', maxLevel: 5,
    describe: () => `Max energy +12%.` },
  { id: 'reactor', name: 'Reactor', icon: '☢', category: 'passive', maxLevel: 5,
    describe: () => `Energy recharge +12%.` },
  { id: 'thrusters', name: 'Thrusters', icon: '🚀', category: 'passive', maxLevel: 5,
    describe: () => `Thrust +8%, top speed +6%.` },
  { id: 'magnet', name: 'Magnet', icon: '🧲', category: 'passive', maxLevel: 5,
    describe: () => `Gem pickup radius +35%.` },
  { id: 'plating', name: 'Plating', icon: '🛡', category: 'passive', maxLevel: 5,
    describe: () => `Armor +7% (max 60%).` },
  { id: 'scholar', name: 'Scholar', icon: '📜', category: 'passive', maxLevel: 5,
    describe: () => `XP gain +12%.` },
  { id: 'overclock', name: 'Overclock', icon: '🔥', category: 'passive', maxLevel: 5,
    describe: () => `All damage +8%.` },
  { id: 'turretmount', name: 'Turret Mount', icon: '⊕', category: 'passive', maxLevel: 2,
    describe: () => `+1 turret slot for teammates.` },
  { id: 'medkit', name: 'Field Medkit', icon: '💉', category: 'passive', maxLevel: 5, classes: ['engineer'],
    describe: () => `Healing +15%.` },
  // --- auto-weapons ---
  { id: 'orbit', name: 'Orbit Blades', icon: '🌀', category: 'auto', maxLevel: 5,
    describe: (lv) => `${AUTO.orbit.blades(lv)} blades circle you, ${AUTO.orbit.damage(lv)} dmg per touch.` },
  { id: 'seeker', name: 'Seeker Swarm', icon: '🎯', category: 'auto', maxLevel: 5,
    describe: (lv) => `Fires ${AUTO.seeker.count(lv)} homing missile(s) every ${AUTO.seeker.cooldown(lv).toFixed(2)} s.` },
  { id: 'nova', name: 'Pulse Nova', icon: '💥', category: 'auto', maxLevel: 5,
    describe: (lv) => `Shockwave (${AUTO.nova.radius(lv)} px, ${AUTO.nova.damage(lv)} dmg) every ${AUTO.nova.cooldown(lv).toFixed(2)} s.` },
  { id: 'arc', name: 'Arc Lightning', icon: '🌩', category: 'auto', maxLevel: 5,
    describe: (lv) => `Lightning chains ${AUTO.arc.hops(lv)} targets for ${AUTO.arc.damage(lv)} dmg.` },
  { id: 'minetrail', name: 'Mine Trail', icon: '⁂', category: 'auto', maxLevel: 5,
    describe: (lv) => `Drop a mine (${AUTO.minetrail.damage(lv)} dmg) every ${AUTO.minetrail.cooldown(lv).toFixed(2)} s while moving.` },
];

/** General level-up cards (paths/talents live in data/ships.ts). */
export const UPGRADES: Record<UpgradeId, UpgradeDef> = Object.fromEntries(defs.map((d) => [d.id, d]));

/** Fallback card offered when nothing else is available. Not stored in ship.upgrades; repeatable. */
export const OVERCHARGE: UpgradeDef = {
  id: 'overcharge', name: 'Overcharge', icon: '✚', category: 'passive', maxLevel: 1,
  describe: () => `Instantly refill energy and gain 5 score.`,
};

/** General cards each path leans toward (weighted up in offers). */
export const PATH_AFFINITY: Record<PathId, readonly UpgradeId[]> = {
  ram: ['thrusters', 'plating', 'capacitor', 'orbit', 'fluxcore'],
  barrage: ['amplifier', 'fluxcore', 'overclock', 'seeker', 'efficiency'],
  bulwark: ['capacitor', 'reactor', 'plating', 'turretmount'],
  storm: ['heavy', 'rapid', 'velocity', 'overclock', 'amplifier', 'arc'],
  void: ['amplifier', 'fluxcore', 'overclock', 'nova', 'efficiency'],
  lance: ['heavy', 'rapid', 'velocity', 'overclock', 'multi'],
  summoner: ['amplifier', 'fluxcore', 'seeker', 'efficiency'],
  medic: ['medkit', 'reactor', 'fluxcore', 'capacitor'],
  architect: ['amplifier', 'fluxcore', 'turretmount', 'plating'],
};

/**
 * The ship's path for its CURRENT class, derived from upgrades (a ship that changed class keeps its old
 * class's path key but it does nothing until it switches back). null = no path yet.
 */
export function resolvePath(shipClass: ShipClassId, upgrades: Record<UpgradeId, number>): PathId | null {
  for (const p of SHIP_CLASSES[shipClass].paths) if ((upgrades[pathKey(p.id)] ?? 0) > 0) return p.id;
  return null;
}

/** Base class stats + upgrade effects -> effective stats. Pure. */
export function computeStats(shipClass: ShipClassId, upgrades: Record<UpgradeId, number>): ShipStats {
  const base = SHIP_CLASSES[shipClass].base;
  const s: ShipStats = { ...base, skill: { ...base.skill } };
  const k = s.skill;
  const lv = (id: string) => Math.max(0, Math.min(UPGRADES[id]?.maxLevel ?? 0, upgrades[id] ?? 0));
  const has = (id: string) => (upgrades[id] ?? 0) > 0;
  // Only the current class's path & talents apply.
  const path = resolvePath(shipClass, upgrades);
  const talent = (id: string) => path !== null && has(id) && PATHS[path].talents.some((t) => t.id === id);

  // --- path bonuses (stat parts) ---
  switch (path) {
    case 'ram': s.mobilityCooldown *= 0.6; k.ramDamage *= 1.5; break;
    case 'barrage': k.rocketCount += 2; s.secondaryCooldown *= 0.8; break;
    case 'bulwark': s.maxTurrets += 3; s.maxEnergy *= 1.35; break;
    case 'storm': k.arcHops += 2; s.secondaryCooldown *= 0.75; break;
    case 'void': s.utilityCooldown *= 0.65; k.wellRadius *= 1.3; break;
    case 'lance': s.gunPierce += 2; s.gunSpeed *= 1.25; s.gunLife *= 1.3; break;
    case 'summoner': k.sentryMax += 2; k.sentryFireCd /= 1.3; break;
    case 'medic': s.healMult *= 1.4; s.mobilityCooldown *= 0.7; break;
    case 'architect': k.wallHp *= 1.6; k.wallLength *= 1.4; s.utilityCooldown *= 0.75; break;
    default: break;
  }

  // --- talents (stat parts) ---
  if (talent('ram_plating')) s.armor += 0.15;
  if (talent('bar_heavy')) { k.rocketDamage *= 1.4; k.rocketSplash *= 1.3; }
  if (talent('bul_titan')) { s.radius *= 1.15; s.maxEnergy *= 1.25; s.rechargePerSec *= 1.2; }
  if (talent('sto_overload')) k.arcDamage *= 1.45;
  if (talent('voi_horizon')) { k.wellDuration += 2; k.wellPull *= 1.5; }
  if (talent('lan_coils')) { s.gunCost *= 0.65; s.rechargePerSec *= 1.15; }
  if (talent('sum_hardened')) { k.sentryHp *= 2; k.sentryLife += 10; }
  if (talent('arc_turretbay')) s.maxTurrets += 2;

  // --- general cards ---
  let l: number;
  if ((l = lv('heavy'))) s.gunDamage *= 1 + 0.15 * l;
  if ((l = lv('rapid'))) s.gunCooldown *= Math.pow(0.9, l);
  if ((l = lv('multi'))) { s.gunCount += l; s.gunSpread += 0.12 * l; }
  if ((l = lv('velocity'))) { s.gunSpeed *= 1 + 0.12 * l; s.gunLife *= 1 + 0.08 * l; }
  if ((l = lv('amplifier'))) { s.secondaryPower *= 1 + 0.12 * l; s.utilityPower *= 1 + 0.12 * l; }
  if ((l = lv('fluxcore'))) {
    const m = Math.pow(0.9, l);
    s.secondaryCooldown *= m; s.mobilityCooldown *= m; s.utilityCooldown *= m;
  }
  if ((l = lv('efficiency'))) {
    const m = Math.pow(0.9, l);
    s.gunCost *= m; s.secondaryCost *= m; s.mobilityCost *= m; s.utilityCost *= m;
  }
  if ((l = lv('capacitor'))) s.maxEnergy *= 1 + 0.12 * l;
  if ((l = lv('reactor'))) s.rechargePerSec *= 1 + 0.12 * l;
  if ((l = lv('thrusters'))) {
    s.thrust *= 1 + 0.08 * l; s.maxSpeed *= 1 + 0.06 * l; s.afterburnerSpeed *= 1 + 0.06 * l;
  }
  if ((l = lv('magnet'))) s.magnetRadius *= 1 + 0.35 * l;
  if ((l = lv('plating'))) s.armor += 0.07 * l;
  if ((l = lv('scholar'))) s.xpMult *= 1 + 0.12 * l;
  if ((l = lv('overclock'))) s.damageMult *= 1 + 0.08 * l;
  if ((l = lv('turretmount'))) s.maxTurrets += l;
  if ((l = lv('medkit')) && shipClass === 'engineer') s.healMult *= 1 + 0.15 * l;

  s.armor = Math.min(0.6, Math.max(0, s.armor));
  s.maxEnergy = Math.round(s.maxEnergy);
  return s;
}
