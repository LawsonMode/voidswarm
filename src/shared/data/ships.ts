// v0.2 class catalog — 3 Diablo-style classes × 3 build paths × 4 talents, plus turret kits.
// FROZEN SHAPE (ids, slots, talent ids, knob keys). Numbers are tuning and may be adjusted by SIM/PVE
// owners for balance — keep descriptions in sync when you do.
//
// Effect ownership: `impl: 'stats'` → computeStats (PVE agent, sim/pve/upgrades.ts).
//                   `impl: 'sim'`   → skill/turret/deployable behavior (SIM agent, sim/skills*.ts).
//                   `impl: 'both'`  → stat part in computeStats, behavior part in sim.
// A ship "has" a path/talent when ship.upgrades['path:<id>'] / ship.upgrades['<talentId>'] ≥ 1.
import type { PathDef, PathId, ShipClassDef, ShipClassId, ShipStats, TalentDef, UpgradeId } from '../types';

// ---------------------------------------------------------------------------------------------
// Skill knobs (ShipStats.skill keys) per class, with meaning. Base values below.
// ---------------------------------------------------------------------------------------------
export const SKILL_KNOBS = {
  brute: {
    rocketCount: 'rockets per Rocket Salvo',
    rocketDamage: 'damage per rocket (before secondaryPower/damageMult)',
    rocketSplash: 'rocket splash radius px',
    rocketSpeed: 'px/s',
    ramDamage: 'Ram Charge hit damage (× mobilityPower)',
    chargeSpeed: 'px/s during Ram Charge',
    chargeTime: 'seconds a charge lasts',
    chargeDamageTaken: 'fraction of damage taken while charging',
    hideAbsorb: 'Iron Hide damage absorbed fraction',
    hideTime: 'Iron Hide duration s',
  },
  tech: {
    arcHops: 'targets hit by Arc Lightning',
    arcDamage: 'first-hop damage (× secondaryPower); later hops × 0.85 each',
    arcRange: 'max distance to first target px',
    arcHopRange: 'max distance between hops px',
    blinkRange: 'max teleport distance px',
    wellRadius: 'Singularity pull radius px',
    wellDuration: 'Singularity lifetime s',
    wellDps: 'damage/s inside the core (× utilityPower)',
    wellPull: 'pull acceleration px/s²',
  },
  engineer: {
    sentryMax: 'max active sentries (oldest replaced)',
    sentryHp: 'sentry hp (× secondaryPower)',
    sentryLife: 'sentry lifetime s',
    sentryFireCd: 'seconds between sentry volleys',
    sentryDamage: 'damage per sentry seeker (× secondaryPower)',
    sentryRange: 'sentry targeting range px',
    healFrac: 'Repair Pulse heal as fraction of target maxEnergy (× mobilityPower × healMult)',
    healRadius: 'Repair Pulse radius px',
    wallLength: 'Shield Wall length px',
    wallHp: 'Shield Wall hp (× utilityPower)',
    wallLife: 'Shield Wall lifetime s',
  },
} as const;

/** Turret-kit knobs live in ShipStats.skill too (all classes carry their own kit's keys). */
export const TURRET_KNOBS = {
  flak: { flakPellets: 'pellets per burst', flakDamage: 'dmg per pellet', flakCd: 's between bursts', flakHostCost: 'HOST energy per burst', braceAbsorb: 'host damage reduction while Brace held', braceCostPerSec: 'own energy/s' },
  laser: { laserDps: 'beam dps before resonance', laserRange: 'beam length px', laserHostCostPerSec: 'HOST energy/s before resonance', deflectRadius: 'point-defense radius around host px', deflectCostPerShot: 'own energy per projectile destroyed' },
  seekerpod: { podCd: 's between pod volleys', podCount: 'seekers per volley', podDamage: 'dmg per seeker', podHostCost: 'HOST energy per volley', weldPerSec: 'host energy restored per s while held', weldCostPerSec: 'own energy/s (transfer ratio ~1:1)' },
} as const;

// ---------------------------------------------------------------------------------------------
// Base stats
// ---------------------------------------------------------------------------------------------
const common: Omit<ShipStats, 'skill'> = {
  radius: 18,
  maxEnergy: 1300,
  rechargePerSec: 240,
  thrust: 900,
  maxSpeed: 470,
  afterburnerSpeed: 700,
  afterburnerCostPerSec: 260,
  turnRate: 14,

  gunDamage: 100,
  gunCost: 28,
  gunSpeed: 950,
  gunCooldown: 0.15,
  gunLife: 1.1,
  gunCount: 1,
  gunSpread: 0,
  gunPierce: 0,

  secondaryCooldown: 1.2,
  secondaryCost: 150,
  secondaryPower: 1,
  mobilityCooldown: 6,
  mobilityCost: 100,
  mobilityPower: 1,
  utilityCooldown: 12,
  utilityCost: 150,
  utilityPower: 1,
  healMult: 1,

  magnetRadius: 120,
  armor: 0,
  maxTurrets: 2,
  xpMult: 1,
  damageMult: 1,
};

const turretKnobs = {
  // flak (brute)
  flakPellets: 7, flakDamage: 55, flakCd: 0.45, flakHostCost: 40, braceAbsorb: 0.5, braceCostPerSec: 220,
  // laser (tech)
  laserDps: 260, laserRange: 620, laserHostCostPerSec: 90, deflectRadius: 170, deflectCostPerShot: 35,
  // seeker pod (engineer)
  podCd: 1.0, podCount: 2, podDamage: 85, podHostCost: 45, weldPerSec: 220, weldCostPerSec: 240,
};

// ---------------------------------------------------------------------------------------------
// Paths & talents
// ---------------------------------------------------------------------------------------------
const T = (path: PathId, id: UpgradeId, name: string, icon: string, impl: TalentDef['impl'], description: string): TalentDef =>
  ({ id, path, name, icon, impl, description });

const BRUTE_PATHS: PathDef[] = [
  {
    id: 'ram', classId: 'brute', name: 'Ram', tagline: 'Be the battering ram.', icon: '🐏', accent: 0xff7a2b, impl: 'both',
    description: 'Ram Charge cooldown -40% and damage +50%. Spiked Prow: small swarmers that touch you die, and you take 70% less contact damage.',
    talents: [
      T('ram', 'ram_quake', 'Shockwave', '💢', 'sim', 'Ram Charge ends in a 220 px shockwave: 300 damage and knockback.'),
      T('ram', 'ram_momentum', 'Momentum', '🌪', 'sim', 'Ram damage +100%; primary damage +15% while above 80% of max speed.'),
      T('ram', 'ram_unstoppable', 'Unstoppable', '🛡', 'sim', 'Ram Charge travels 60% farther and you are immune to damage while charging.'),
      T('ram', 'ram_plating', 'Reactive Plating', '🧱', 'both', 'Armor +15%. 25% of contact damage you take is reflected to the attacker.'),
    ],
  },
  {
    id: 'barrage', classId: 'brute', name: 'Barrage', tagline: 'Fill the sky with fire.', icon: '🚀', accent: 0xffc62b, impl: 'stats',
    description: 'Rocket Salvo fires +2 rockets and its cooldown is 20% shorter.',
    talents: [
      T('barrage', 'bar_cluster', 'Cluster Rockets', '🎆', 'sim', 'Each rocket splits into 3 bomblets (40% damage) when it detonates.'),
      T('barrage', 'bar_autolauncher', 'Auto-Launcher', '🔁', 'sim', 'Every 2 s, automatically fire 2 mini-rockets (50% damage) at the nearest hostile.'),
      T('barrage', 'bar_napalm', 'Napalm', '🔥', 'sim', 'Rocket explosions leave burning ground for 2 s (80 damage/s, 60 px).'),
      T('barrage', 'bar_heavy', 'Heavy Warheads', '💣', 'stats', 'Rocket damage +40% and splash radius +30%.'),
    ],
  },
  {
    id: 'bulwark', classId: 'brute', name: 'Bulwark', tagline: 'A fortress others ride into battle.', icon: '🏰', accent: 0x9aa7ff, impl: 'both',
    description: '+3 turret slots and +35% max energy. Turrets attached to you deal +25% damage.',
    talents: [
      T('bulwark', 'bul_fortress', 'Fortress', '🏯', 'sim', 'Iron Hide also shields your turrets and allies within 250 px.'),
      T('bulwark', 'bul_clamp', 'Magnetic Clamp', '🧲', 'sim', 'Teammates attach to you with no energy minimum or cooldown. Turrets on you recharge 50% faster.'),
      T('bulwark', 'bul_reflect', 'Reflector', '🔰', 'sim', 'While Iron Hide is active, 40% of absorbed damage is reflected to the attacker.'),
      T('bulwark', 'bul_titan', 'Titan', '🗿', 'stats', 'Size +15%, max energy +25%, recharge +20%.'),
    ],
  },
];

const TECH_PATHS: PathDef[] = [
  {
    id: 'storm', classId: 'tech', name: 'Storm', tagline: 'Ride the lightning.', icon: '⚡', accent: 0x6ae4ff, impl: 'stats',
    description: 'Arc Lightning hits +2 more targets and its cooldown is 25% shorter.',
    talents: [
      T('storm', 'sto_static', 'Static Field', '🌐', 'sim', 'Every 0.8 s, shock up to 3 hostiles within 220 px for 60 damage.'),
      T('storm', 'sto_forked', 'Forked Bolts', '🔱', 'sim', 'Plasma Bolts chain to 1 extra target within 140 px on hit (60% damage).'),
      T('storm', 'sto_thunder', 'Thunderclap', '🌩', 'sim', 'Blink releases a 200 px nova (260 damage) where you arrive.'),
      T('storm', 'sto_overload', 'Overload', '🔋', 'stats', 'Arc Lightning damage +45%.'),
    ],
  },
  {
    id: 'void', classId: 'tech', name: 'Void', tagline: 'Bend space until it breaks.', icon: '🕳', accent: 0xb45bff, impl: 'stats',
    description: 'Singularity cooldown -35% and pull radius +30%.',
    talents: [
      T('void', 'voi_collapse', 'Collapse', '💥', 'sim', 'Singularities explode when they expire: 500 damage in 200 px.'),
      T('void', 'voi_riftstep', 'Rift Step', '🌀', 'sim', 'Blink leaves a small singularity (50% size, 1.5 s) where you left.'),
      T('void', 'voi_entropy', 'Entropy', '☄', 'sim', 'Hostiles inside your singularities take +30% damage from all sources.'),
      T('void', 'voi_horizon', 'Event Horizon', '🌑', 'stats', 'Singularities last 2 s longer and pull 50% harder.'),
    ],
  },
  {
    id: 'lance', classId: 'tech', name: 'Lance', tagline: 'One shot. Straight through.', icon: '🎯', accent: 0xff5bd6, impl: 'stats',
    description: 'Plasma Bolts pierce +2 targets, fly 25% faster and 30% farther.',
    talents: [
      T('lance', 'lan_rail', 'Railshot', '➶', 'sim', 'Every 5th primary shot is a rail bolt: 4× damage, pierces everything.'),
      T('lance', 'lan_focus', 'Focus', '🧘', 'sim', 'Primary damage +30% while you are not thrusting.'),
      T('lance', 'lan_sniper', 'Sniper', '🔭', 'sim', 'Primary damage +1% per 20 px the bolt has travelled (max +60%).'),
      T('lance', 'lan_coils', 'Capacitor Coils', '♻', 'stats', 'Primary energy cost -35% and energy recharge +15%.'),
    ],
  },
];

const ENGINEER_PATHS: PathDef[] = [
  {
    id: 'summoner', classId: 'engineer', name: 'Summoner', tagline: 'An army in your cargo hold.', icon: '🛰', accent: 0x3bff9a, impl: 'stats',
    description: '+2 max sentries and sentries fire 30% faster.',
    talents: [
      T('summoner', 'sum_drones', 'Drone Wing', '🛸', 'sim', 'Two combat drones follow you and shoot hostiles (60 damage, 0.5 s).'),
      T('summoner', 'sum_overclock', 'Overclocked Sentries', '⏩', 'sim', 'Sentries fire 2 seekers per volley.'),
      T('summoner', 'sum_hardened', 'Hardened Frames', '🔩', 'stats', 'Sentry hp +100% and lifetime +10 s.'),
      T('summoner', 'sum_salvage', 'Salvage', '♻', 'sim', 'Sentries explode when destroyed or expired (300 damage, 160 px) and refund 30% of their energy cost.'),
    ],
  },
  {
    id: 'medic', classId: 'engineer', name: 'Medic', tagline: 'Nobody dies on your watch.', icon: '✚', accent: 0x7dff5b, impl: 'stats',
    description: 'Repair Pulse heals 40% more and its cooldown is 30% shorter.',
    talents: [
      T('medic', 'med_beam', 'Repair Beam', '💚', 'sim', 'Continuously heal the lowest-energy ally within 320 px for 120 energy/s.'),
      T('medic', 'med_revive', 'Field Revive', '🪽', 'sim', 'Dead teammates within 500 px respawn at your position immediately (20 s cooldown per teammate).'),
      T('medic', 'med_nanites', 'Nanite Cloud', '☁', 'sim', 'Repair Pulse leaves a 4 s healing cloud (80 energy/s to allies, 180 px).'),
      T('medic', 'med_triage', 'Triage', '🚑', 'sim', 'Your heals are 50% stronger on allies below 30% energy.'),
    ],
  },
  {
    id: 'architect', classId: 'engineer', name: 'Architect', tagline: 'Build the battlefield.', icon: '🧱', accent: 0x5bd0ff, impl: 'stats',
    description: 'Shield Wall hp +60%, length +40%, cooldown -25%.',
    talents: [
      T('architect', 'arc_tesla', 'Tesla Wall', '🔌', 'sim', 'Your walls shock hostiles within 60 px for 100 damage/s.'),
      T('architect', 'arc_minefield', 'Minefield', '✴', 'sim', 'Placing a wall also drops 4 mines along it.'),
      T('architect', 'arc_reinforced', 'Reinforced', '🪞', 'sim', 'Walls reflect hostile projectiles back instead of absorbing them.'),
      T('architect', 'arc_turretbay', 'Turret Bay', '⊕', 'both', '+2 turret slots; turrets on you deal +30% damage.'),
    ],
  },
];

// ---------------------------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------------------------
export const SHIP_CLASSES: Record<ShipClassId, ShipClassDef> = {
  brute: {
    id: 'brute', name: 'Juggernaut', archetype: 'Brute', role: 'Physical / melee',
    description: 'A heavily armored bruiser. Smashes through swarms, shrugs off hits, carries turrets.',
    canTurret: true, turretDamageMult: 1.0,
    skills: {
      primary: { id: 'autocannon', slot: 'primary', name: 'Autocannon', icon: '🔫', description: 'Heavy slugs. Short range, hard hitting.' },
      secondary: { id: 'rockets', slot: 'secondary', name: 'Rocket Salvo', icon: '🚀', description: 'Fan of splash rockets with slight homing.' },
      mobility: { id: 'ram', slot: 'mobility', name: 'Ram Charge', icon: '🐏', description: 'Dash forward, smashing and knocking back everything you hit. Take 60% less damage while charging.' },
      utility: { id: 'ironhide', slot: 'utility', name: 'Iron Hide', icon: '🛡', description: 'Absorb 60% of incoming damage for 3 s.' },
    },
    turret: {
      id: 'flak', name: 'Flak Mount',
      offense: { name: 'Flak Cannon', icon: '💥', description: 'Short-range shotgun bursts. Draws host energy.' },
      defense: { name: 'Brace', icon: '🧱', description: 'Hold: your host takes 50% less damage. Drains your energy.' },
    },
    paths: BRUTE_PATHS,
    base: {
      ...common,
      radius: 22, maxEnergy: 1800, rechargePerSec: 230, thrust: 850, maxSpeed: 430, afterburnerSpeed: 640, turnRate: 10,
      gunDamage: 140, gunCost: 32, gunSpeed: 850, gunCooldown: 0.18, gunLife: 0.9,
      secondaryCooldown: 1.4, secondaryCost: 160,
      mobilityCooldown: 6, mobilityCost: 100,
      utilityCooldown: 12, utilityCost: 0,
      armor: 0.1, maxTurrets: 2,
      skill: {
        ...turretKnobs,
        rocketCount: 3, rocketDamage: 180, rocketSplash: 70, rocketSpeed: 700,
        ramDamage: 400, chargeSpeed: 1500, chargeTime: 0.35, chargeDamageTaken: 0.4,
        hideAbsorb: 0.6, hideTime: 3,
      },
    },
  },
  tech: {
    id: 'tech', name: 'Arcanist', archetype: 'Tech', role: 'Caster / energy',
    description: 'A fragile caster that bends lightning and gravity. Huge burst, blinks out of trouble.',
    canTurret: true, turretDamageMult: 1.0,
    skills: {
      primary: { id: 'plasma', slot: 'primary', name: 'Plasma Bolt', icon: '✦', description: 'Fast energy bolts.' },
      secondary: { id: 'arc', slot: 'secondary', name: 'Arc Lightning', icon: '⚡', description: 'Instant lightning that chains between hostiles near your aim.' },
      mobility: { id: 'blink', slot: 'mobility', name: 'Blink', icon: '✧', description: 'Teleport toward your aim (stops at walls).' },
      utility: { id: 'singularity', slot: 'utility', name: 'Singularity', icon: '🕳', description: 'Hurl a gravity well that pulls hostiles in and crushes them.' },
    },
    turret: {
      id: 'laser', name: 'Laser Mount',
      offense: { name: 'Laser Lance', icon: '🔆', description: 'Continuous beam. Each other laser on the same host multiplies it ×1.5 — and its host-energy draw.' },
      defense: { name: 'Deflector', icon: '🔰', description: 'Hold: shoot down hostile projectiles near your host. Costs your energy per shot.' },
    },
    paths: TECH_PATHS,
    base: {
      ...common,
      radius: 16, maxEnergy: 1100, rechargePerSec: 290, thrust: 950, maxSpeed: 500, afterburnerSpeed: 760,
      gunDamage: 115, gunCost: 28, gunSpeed: 1000, gunCooldown: 0.15, gunLife: 1.2,
      secondaryCooldown: 1.1, secondaryCost: 140,
      mobilityCooldown: 5, mobilityCost: 120,
      utilityCooldown: 10, utilityCost: 200,
      skill: {
        ...turretKnobs,
        arcHops: 4, arcDamage: 220, arcRange: 600, arcHopRange: 260,
        blinkRange: 480,
        wellRadius: 280, wellDuration: 3, wellDps: 120, wellPull: 900,
      },
    },
  },
  engineer: {
    id: 'engineer', name: 'Artificer', archetype: 'Engineer', role: 'Support / summoner',
    description: 'Builds sentries and walls, heals the team, and makes every turret stack better.',
    canTurret: true, turretDamageMult: 1.0,
    skills: {
      primary: { id: 'rivet', slot: 'primary', name: 'Rivet Gun', icon: '🔩', description: 'Rapid, light shots.' },
      secondary: { id: 'sentry', slot: 'secondary', name: 'Deploy Sentry', icon: '🛰', description: 'Drop a sentry that fires homing seekers at hostiles.' },
      mobility: { id: 'repair', slot: 'mobility', name: 'Repair Pulse', icon: '✚', description: 'Heal yourself and nearby allies (turrets included) and get a short speed boost.' },
      utility: { id: 'wall', slot: 'utility', name: 'Shield Wall', icon: '🧱', description: 'Raise a barrier that blocks hostile projectiles and swarms.' },
    },
    turret: {
      id: 'seekerpod', name: 'Seeker Pod',
      offense: { name: 'Seeker Volley', icon: '🎯', description: 'Homing missile volleys. Draws host energy.' },
      defense: { name: 'Hull Weld', icon: '🔧', description: 'Hold: transfer your energy into your host to repair it.' },
    },
    paths: ENGINEER_PATHS,
    base: {
      ...common,
      radius: 18, maxEnergy: 1300, rechargePerSec: 260, thrust: 900, maxSpeed: 470,
      gunDamage: 70, gunCost: 18, gunSpeed: 1100, gunCooldown: 0.1, gunLife: 0.9,
      secondaryCooldown: 3, secondaryCost: 220,
      mobilityCooldown: 9, mobilityCost: 0,
      utilityCooldown: 14, utilityCost: 150,
      maxTurrets: 3,
      skill: {
        ...turretKnobs,
        sentryMax: 2, sentryHp: 600, sentryLife: 15, sentryFireCd: 1.2, sentryDamage: 90, sentryRange: 550,
        healFrac: 0.25, healRadius: 380,
        wallLength: 220, wallHp: 1500, wallLife: 6,
      },
    },
  },
};

export const SHIP_CLASS_IDS = Object.keys(SHIP_CLASSES) as ShipClassId[];

export const PATHS: Record<PathId, PathDef> = Object.fromEntries(
  SHIP_CLASS_IDS.flatMap((c) => SHIP_CLASSES[c].paths.map((p) => [p.id, p])),
) as Record<PathId, PathDef>;

export const TALENTS: Record<UpgradeId, TalentDef> = Object.fromEntries(
  Object.values(PATHS).flatMap((p) => p.talents.map((t) => [t.id, t])),
);

/** upgrades-record key for a path. */
export const pathKey = (p: PathId): UpgradeId => `path:${p}`;

/** Index (0..2) of a path within its class, -1 if null. */
export function pathIndex(shipClass: ShipClassId, path: PathId | null): number {
  return path ? SHIP_CLASSES[shipClass].paths.findIndex((p) => p.id === path) : -1;
}

export function hasUpgrade(upgrades: Record<UpgradeId, number>, id: UpgradeId): boolean {
  return (upgrades[id] ?? 0) > 0;
}
