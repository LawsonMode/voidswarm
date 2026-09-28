// SCRATCH: the three v1.0 ability-kit proposals as data (numbers transcribed from each spec). NOT project code.
// hero = "Hero Kits: the Overwatch-faithful ability layer"; arcade = "Arcade Kit: Five Buttons, Three Ultimates";
// sortie = "Sortie Loadout (build diversity and progression)".

export const KIT_IDS = ['hero', 'arcade', 'sortie'];
export const KIT_NAME = { hero: 'Hero Kits', arcade: 'Arcade Kit', sortie: 'Sortie Loadout' };

/** Per-kit class-stat overrides on top of CR (lib.CLASSES). */
export const CLASS_OVERRIDE = {
  hero: { tech: { I: 420 } },            // Hero keeps the unfixed 420 Arcanist integrity (its checks quote "/420")
  arcade: {},                            // uses the judge's 500
  sortie: { tech: { brake: 1100 } },     // Sortie drops the Arcanist coast brake 1800 -> 1100 (FULL STOP owns the quick stop)
};

// ------------------------------------------------------------------ Space: FULL STOP
export const STOP = {
  hero: { brute: { k: 700, draw: 60 }, tech: { k: 3200, draw: 30 }, engineer: { k: 1500, draw: 45 }, brownout: 'full, no draw', drawAbove: 5 },
  arcade: { brute: { k: 380, draw: 90 }, tech: { k: 2600, draw: 30 }, engineer: { k: 1100, draw: 50 }, brownout: 'x0.5 strength', drawAbove: 1 },
  sortie: { brute: { k: 620, draw: 90 }, tech: { k: 3400, draw: 50 }, engineer: { k: 1350, draw: 60 }, brownout: 'full, no draw', drawAbove: 0 },
};

// ------------------------------------------------------------------ Ultimates (charge models + roster)
export const CHARGE = {
  hero: { model: 'points', passive: 20, bucketRate: 40, bucketMax: 80, kShip: 0.2, kHealAlly: 0.25, kHealSelf: 0.08, kMit: 0.1, mitCapPerSec: 10,
    kDE: 8, takedown: 150, assist: 75, objPerSec: 12, capture: 300, flagReturn: 100, room: 150, elite: 0, bossPhase: 0, hive: 0, gainWhileActive: false,
    deField: 'deH' },
  arcade: { model: 'frac', passive: 1 / 120, bankCap: 0.15, actRate: 0.0085, kShip: 0.28 /* per victim EHP */, kHeal: 0.18, selfMult: 0.5, kPve: 0.009,
    takedown: 0.06, assist: 0.03, elite: 0.03, room: 0.06, bossPhase: 0.10, hive: 0.06, capture: 0.20, flagReturn: 0.08, zoneCapture: 0.08, hotPerSec: 0.005,
    gainWhileActive: false, deField: 'deA' },
  sortie: { model: 'pending', points: 1000, passive: 8.5, pendingCap: 400, rate: { arena: 12, warzone: 10, dungeon: 9 }, kShip: 0.15, kEnemy: 0.02, kEnemyElite: 0.04,
    kHealAlly: 0.10, kHealSelf: 0.03, kMit: 0.06, takedown: 120, assist: 60, elite: 40, bossPhase: 80, room: 60, capture: 200, flagReturn: 80, carryPerSec: 4, holdPerSec: 3,
    gainWhileActive: 'pending drains (spec silent)' },
};

/** Ult roster. dur = seconds the ult is "active" (no charge), tell = seconds before it bites; cost in the kit's own unit. */
export const ULTS = {
  hero: {
    brute: [{ id: 'wreckingrun', name: 'Wrecking Run', path: 'Ram', cost: 2100, dur: 3.4, tell: 0.4 }, { id: 'carpetbomb', name: 'Carpet Bomb', path: 'Barrage', cost: 2000, dur: 3.3, tell: 0.3 }, { id: 'emp', name: 'EMP Pulse', path: 'Bulwark', cost: 2200, dur: 0.35, tell: 0.35 }],
    tech: [{ id: 'ionstorm', name: 'Ion Storm', path: 'Storm', cost: 2100, dur: 6.5, tell: 0.5 }, { id: 'eventhorizon', name: 'Event Horizon', path: 'Void', cost: 2300, dur: 5.3, tell: 0.3 }, { id: 'hyperlance', name: 'Hyperlance', path: 'Lance', cost: 2100, dur: 4, tell: 0.45 }],
    engineer: [{ id: 'dronecarrier', name: 'Drone Carrier', path: 'Summoner', cost: 2000, dur: 10.3, tell: 0.3 }, { id: 'lifeline', name: 'Lifeline', path: 'Medic', cost: 2300, dur: 5, tell: 0 }, { id: 'citadel', name: 'Citadel', path: 'Architect', cost: 2100, dur: 8.4, tell: 0.4 }],
  },
  arcade: {
    brute: [{ id: 'eventhorizon', name: 'Event Horizon', path: 'all', cost: 1, dur: 5.3, durArena: 4.3, tell: 0.3 }],
    tech: [{ id: 'ionstorm', name: 'Ion Storm', path: 'all', cost: 1, dur: 6, tell: 0 }],
    engineer: [{ id: 'overload', name: 'Overload Pulse', path: 'all', cost: 1, dur: 0.35, tell: 0.35 }],
  },
  sortie: {
    brute: [{ id: 'eventhorizon', name: 'Event Horizon', cost: 1000, dur: 5, durArena: 4, tell: 0 }, { id: 'carpetbomb', name: 'Carpet Bomb', cost: 1000, dur: 3.2, tell: 0 }, { id: 'rampage', name: 'Rampage', cost: 1000, dur: 5, tell: 0 }],
    tech: [{ id: 'ionstorm', name: 'Ion Storm', cost: 1000, dur: 6, tell: 0 }, { id: 'hyperlance', name: 'Hyperlance', cost: 1000, dur: 1, tell: 1 }, { id: 'blackstar', name: 'Black Star', cost: 1000, dur: 5.8, tell: 0 }],
    engineer: [{ id: 'nanitesurge', name: 'Nanite Surge', cost: 1000, dur: 6, tell: 0 }, { id: 'emp', name: 'EMP Pulse', cost: 1000, dur: 0.35, tell: 0.35 }, { id: 'dronecarrier', name: 'Drone Carrier', cost: 1000, dur: 12, tell: 0 }],
  },
};

// ------------------------------------------------------------------ E specials (+ RMB alt fire), for uptime + power
// kind: 'stance' (dur, cd from end, optional sustain/s), 'field' (instant cast, effect dur, cd from cast), 'summon' (life, max alive),
//       'hold' (channel cost/s), 'charges' (n charges, recharge each).
export const SPECIALS = {
  hero: {
    brute: [{ id: 'polarize', name: 'Polarize Shields', kind: 'stance', cost: 120, dur: 4, cd: 11, cdFromEnd: true, sustain: 200, sustainLoad: 1 }],
    tech: [{ id: 'gwell', name: 'Gravity Well', kind: 'field', cost: 220, dur: 3, cd: 10, voidCd: 6.5 }],
    engineer: [{ id: 'sentry', name: 'Deploy Sentry', kind: 'summon', cost: 200, cd: 7, life: 15, max: 2, maxSummoner: 4 }, { id: 'wall', name: 'Shield Wall (Architect)', kind: 'field', cost: 150, dur: 6, cd: 10.5 }],
  },
  arcade: {
    brute: [{ id: 'polarize', name: 'Polarize Shields', kind: 'stance', cost: 120, dur: 4, cd: 11, cdFromEnd: true, sustain: 200, sustainLoad: 1 }],
    tech: [{ id: 'gwell', name: 'Gravity Well', kind: 'field', cost: 220, dur: 3, cd: 10, voidCd: 6.5 }],
    engineer: [{ id: 'repair', name: 'Repair (tap Pulse / hold Ray)', kind: 'field', cost: 80, dur: 1, cd: 9, medicCd: 6.3, hold: 170, holdLoad: 1 }],
  },
  sortie: {
    brute: [{ id: 'polarize', name: 'E1 Polarize', kind: 'stance', cost: 120, dur: 4, cd: 11, cdFromEnd: true, sustain: 200, sustainLoad: 1 },
      { id: 'siege', name: 'E2 Siege Mode', kind: 'stance', cost: 100, dur: 5, cd: 8, cdFromEnd: true, drainPerSec: 50, sustainLoad: 0 },
      { id: 'mortar', name: 'E3 Mortar Volley', kind: 'field', cost: 180, dur: 1.25, cd: 11 }],
    tech: [{ id: 'gwell', name: 'E1 Gravity Well', kind: 'field', cost: 220, dur: 3, cd: 10, voidCd: 6.5 },
      { id: 'stasis', name: 'E2 Stasis Field', kind: 'field', cost: 200, dur: 2.5, cd: 11 },
      { id: 'lens', name: 'E3 Focus Lens', kind: 'stance', cost: 150, dur: 5, cd: 10, cdFromEnd: true }],
    engineer: [{ id: 'repair', name: 'E1 Repair Suite', kind: 'field', cost: 80, dur: 1, cd: 9, hold: 170, holdLoad: 1 },
      { id: 'siphon', name: 'E2 Siphon Suite', kind: 'field', cost: 90, dur: 2, cd: 10, hold: 170, holdLoad: 1 },
      { id: 'wall', name: 'E3 Shield Wall', kind: 'field', cost: 150, dur: 6, cd: 12 }],
  },
};
/** RMB alt fire: {cost, cd} (held auto-repeat) or {hold: cost/s}. */
export const ALTFIRE = {
  hero: { brute: { name: 'Rocket Salvo', cost: 170, cd: 1.4 }, tech: { name: 'Arc Lightning', cost: 150, cd: 1.1 }, engineer: { name: 'Repair Ray (held)', hold: 150 } },
  arcade: { brute: { name: 'Rocket Salvo', cost: 170, cd: 1.4 }, tech: { name: 'Arc Lightning', cost: 150, cd: 1.1 }, engineer: { name: 'Deploy Sentry', cost: 200, cd: 3 } },
  sortie: { brute: { name: 'Rocket Salvo', cost: 170, cd: 1.4 }, tech: { name: 'Arc Lightning', cost: 150, cd: 1.1 }, engineer: { name: 'Deploy Sentry', cost: 200, cd: 3 } },
};
/** Boost draw (power/s, regen halted) per class. Same for all three kits (CR afterburner). */
export const BOOST = { brute: 240, tech: 200, engineer: 200 };

// ------------------------------------------------------------------ Maneuver perks (movement numbers for the chase model)
// type: dash {speed, time, taken}, blink {range, invuln}, impulse {dv, time, taken|invuln}, surge {time, speedMult, thrustMult, free},
//       jump {spool, range, invuln}, flip, none.
export const PERKS = {
  hero: {
    ram: { name: 'Ram Charge', cls: 'brute', type: 'dash', speed: 1500, time: 0.35, taken: 0.4, cd: 6, cost: 120 },
    blink: { name: 'Warp', cls: 'tech', type: 'blink', range: 480, invuln: 0.3, shieldTrim: 1.0, cd: 5, cost: 120 },
    repair: { name: 'Pulse Boost', cls: 'engineer', type: 'surge', time: 1.0, speedMult: 1.3, thrustMult: 1.3, free: false, heal: [0.18, 0.12], cd: 9, cost: 80 },
    strafe: { name: 'Strafe Dodge', cls: null, type: 'impulse', dv: 650, time: 0.25, charges: 2, cd: 4, cost: 50 },
    flip: { name: 'Flip Burn', cls: null, type: 'flip', cd: 7, cost: 60 },
    overdrive: { name: 'Overdrive', cls: null, type: 'surge', time: 3, speedMult: 1.12, free: true, regen: true, lockAfter: 2, cd: 16, cdFromStart: true, cost: 0 },
    jump: { name: 'Hyperspace Jump', cls: null, type: 'jump', spool: 0.9, spoolSpeed: 0.6, range: 1300, invuln: 0.25, walls: 'over', cd: 22, cost: 150 },
  },
  arcade: {
    ram: { name: 'Ram Charge', cls: 'brute', type: 'dash', speed: 1500, time: 0.35, taken: 0.4, cd: 6, cost: 120 },
    blink: { name: 'Warp', cls: 'tech', type: 'blink', range: { brute: 380, tech: 480, engineer: 430 }, invuln: 0.3, shieldTrim: 1.0, cd: { brute: 6, tech: 5, engineer: 6 }, cost: 120 },
    dodge: { name: 'Strafe Dodge', cls: null, type: 'impulse', dv: { brute: 600, tech: 880, engineer: 760 }, time: 0.25, taken: 0.5, cd: 3, cost: 60 },
    overdrive: { name: 'Overdrive', cls: 'engineer', type: 'surge', time: 3, speedMult: 1.15, free: true, regen: true, noStrain: true, cd: 14, cost: 100 },
    hyperjump: { name: 'Hyperspace Jump', cls: null, type: 'jump', spool: 0.75, spoolSpeed: 0, range: 1400, invuln: 0.5, walls: 'stop', cd: 22, cost: 200 },
  },
  sortie: {
    blink: { name: 'Warp', cls: 'tech', type: 'blink', range: 480, reach: true, invuln: 0.3, shieldTrim: { brute: 1.0, tech: 0.6, engineer: 1.0 }, cd: 7, cost: 120 },
    jump: { name: 'Hyperspace Jump', cls: null, type: 'jump', spool: 0.8, spoolSpeed: 0, range: 1100, reach: true, invuln: 0, walls: 'over', cd: 15, cost: 180 },
    ram: { name: 'Ram Charge', cls: 'brute', type: 'dash', speed: 1500, time: 0.35, reach: true, taken: 0.4, cd: 8, cost: 120 },
    dodge: { name: 'Strafe Dodge', cls: null, type: 'dash', speed: 1150, time: 0.18, reach: true, invuln: 0.18, charges: 2, cd: 4, cost: 45 },
    grapple: { name: 'Grapple (tile reel)', cls: 'engineer', type: 'dash', speed: 1000, time: 0.56, reach: true, cd: 8, cost: 90, needsAnchor: true },
    overdrive: { name: 'Overdrive', cls: null, type: 'surge', time: 3, speedMult: 1.2, thrustMult: 1.8, free: true, regen: true, lockAfter: 2, cd: 14, cost: 60 },
    tractor: { name: 'Tractor', cls: null, type: 'none', cd: 14, cost: 60 },
  },
};
export const SORTIE_REACH = { brute: 0.75, tech: 1.0, engineer: 0.875 };
export const SIG_PERK = { hero: { brute: 'ram', tech: 'blink', engineer: 'repair' }, arcade: { brute: 'ram', tech: 'blink', engineer: 'overdrive' }, sortie: { brute: 'ram', tech: 'blink', engineer: 'grapple' } };

// ------------------------------------------------------------------ XP pip gravity
export const GRAV = {
  current: { model: 'snap', magnet: 120, magnetPerLv: 0.35 },
  hero: { model: 'hero', capture: 110, well: 275, accel: 1100, floor: 0.25, swirl: 0.6, swirlSec: 3, drag: 2.0, relMax: 1100, keep: 1.3,
    magnetLv: { capture: 0.12, well: 0.15, accel: 0.20 }, tractor: { capture: 1.5, well: 2.2, accel: 3, sec: 10 }, vacuum: { radius: 1500, accel: 2500, sec: 2.5 } },
  arcade: { model: 'arcade', well: 240, wellArena: 204, accel: 1500, accelArena: 1275, capturePad: 24, floor: 0.35, spin: 1.2, ease: 8, vin: 60, vmin: 650, vpad: 380,
    magnetLv: { well: 0.20, accel: 0.25, capturePx: 4 }, tractor: { well: 2.5, accel: 3, sec: 10 }, tractorArena: { well: 2, accel: 2, sec: 8 }, vacuum: { radius: 1600, speed: 1800 } },
  sortie: { model: 'sortie', capturePad: 60, collectPad: 10, pveBase: 320, arenaBase: 240, aCore: 1900, aEdge: 320, swirl: 1.1, swirlFade: 1.1, tDamp: 2, tDampGrow: 4, relMax: 700, maxRadius: 1200,
    magnetLv: { radius: 0.2, accel: 0.15, capture: 0.1 }, tractorField: { pull: 2.5, sec: 10 }, tractorPerk: { pull: 3, sec: 4 }, vacuum: { radius: 1600, speed: 1400, sec: 3 } },
};
