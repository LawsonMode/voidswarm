// FROZEN SHAPE — v0.3 cosmetic catalog. Ids are forever (append-only; retire with `retired: true`).
// Visual params are tuning: RENDER may adjust within the readability-test bounds (ARCHITECTURE.md §3c).
import type { CosmeticId, CosmeticSlot, LootSet, Rarity, ShipClassId, TurretKitId } from '../types';
import { SHIP_CLASSES } from './ships';

export type HullShape = 'std' | 'spiked' | 'swept' | 'crest';
export type HullPattern = 'none' | 'stripes' | 'hex' | 'rune';
/** Team colour always stays the outline; accent is secondary only (≤ 35% alpha fills, 1–1.4 px strokes). */
export interface HullParams { shape: HullShape; pattern: HullPattern; accent: number; /** 0..1 */ amount: number }

export type WeaponShape = 'std' | 'shard' | 'needle' | 'orb' | 'droplet';
export type MuzzleStyle = 'std' | 'ring' | 'sparks';
/** Main projectile colour is always projColor (team). lengthMul 0.8..1.6 is visual only. */
export interface WeaponParams { shape: WeaponShape; lengthMul: number; core: 'white' | 'dark' | 'accent'; accent: number; muzzle: MuzzleStyle }

export type TurretMount = 'std' | 'jaw' | 'crown' | 'hive' | 'lens';
export type TetherStyle = 'line' | 'dashed' | 'lightning';
/** Beam width/alpha keep resonance scaling; style changes the fringe only ('split' fringes = resonance). */
export type BeamStyle = 'std' | 'jagged' | 'rays' | 'split';
export type TurretShot = 'std' | 'shard' | 'spark' | 'mote';
export interface TurretParams { mount: TurretMount; tether: TetherStyle; beam: BeamStyle; shot: TurretShot; accent: number }

export type FlameStyle = 'std' | 'twin' | 'wide';
export type EngineParticle = 'spark' | 'smoke' | 'ember' | 'spore' | 'prism';
export interface EngineParams {
  flame: FlameStyle; particle: EngineParticle; tint: number | 'team';
  /** 0..0.5 share of accent-coloured particles */ mix: number;
  /** ≤ 1.5 */ rateMul: number; /** 0.6..2 */ lifeMul: number;
}

export type DeathPreset = 'std' | 'shatter' | 'implode' | 'triumph' | 'hatch';
/** The team-coloured core burst always plays; the preset replaces the rest (≤ 70 particles, ≤ 1.5 s linger). */
export interface DeathParams { preset: DeathPreset; accent: number; particles: number; rings: number; linger: number }

export type TitleFrame = 'none' | 'bracket' | 'chevron' | 'laurel';
export interface TitleParams { /** ≤ 14 chars [A-Za-z' ] */ text: string; frame: TitleFrame; color: number }

export interface KillIconParams { /** exactly one code point */ glyph: string }

interface CosmeticBase {
  id: CosmeticId;
  name: string;
  flavor: string;
  set: LootSet | 'starter';
  rarity: Rarity;
  retired?: boolean;
}
export type CosmeticDef =
  | (CosmeticBase & { slot: 'hull'; shipClass: ShipClassId; p: HullParams })
  | (CosmeticBase & { slot: 'weapon'; shipClass: ShipClassId; p: WeaponParams })
  | (CosmeticBase & { slot: 'turret'; kit: TurretKitId; p: TurretParams })
  | (CosmeticBase & { slot: 'engine'; p: EngineParams })
  | (CosmeticBase & { slot: 'death'; p: DeathParams })
  | (CosmeticBase & { slot: 'title'; p: TitleParams })
  | (CosmeticBase & { slot: 'killicon'; p: KillIconParams });

type SetOf = LootSet | 'starter';
const C: Rarity = 0, U: Rarity = 1, R: Rarity = 2, E: Rarity = 3, L: Rarity = 4;

// Accent palette. Readability rule (render test): CIE76 ΔE ≥ 20 from every TEAM_COLORS / ENEMY_COLORS /
// ENEMY_COLOR entry, OR HSV saturation ≤ 0.30. Checked against the v0.2 palettes (lowest ΔE: BRASS 28.6).
const WHITE = 0xf0f6ff, STEEL = 0xa8b8d0, FROST = 0xdff6ff, HAZARD = 0xf2e6a8; // Salvage Line
const ABYSS = 0x2bf0c8, DEEPTEAL = 0x19a58f, LAVENDER = 0xd6ccff;             // Rift
const BRASS = 0xd8b35a, BRONZE = 0xc98a4b, IVORY = 0xfff1d0;                  // Gladiator
const LIME = 0xc6ff3b, MOSS = 0x8fb83a, BONE = 0xe6f0c0;                      // Swarm

const hull = (id: string, name: string, set: SetOf, rarity: Rarity, shipClass: ShipClassId, p: Partial<HullParams>, flavor = ''): CosmeticDef =>
  ({ id, name, flavor, set, rarity, slot: 'hull', shipClass, p: { shape: 'std', pattern: 'none', accent: WHITE, amount: 0, ...p } });
const weapon = (id: string, name: string, set: SetOf, rarity: Rarity, shipClass: ShipClassId, p: Partial<WeaponParams>, flavor = ''): CosmeticDef =>
  ({ id, name, flavor, set, rarity, slot: 'weapon', shipClass, p: { shape: 'std', lengthMul: 1, core: 'white', accent: WHITE, muzzle: 'std', ...p } });
const turret = (id: string, name: string, set: SetOf, rarity: Rarity, kit: TurretKitId, p: Partial<TurretParams>, flavor = ''): CosmeticDef =>
  ({ id, name, flavor, set, rarity, slot: 'turret', kit, p: { mount: 'std', tether: 'line', beam: 'std', shot: 'std', accent: WHITE, ...p } });
const engine = (id: string, name: string, set: SetOf, rarity: Rarity, p: Partial<EngineParams>, flavor = ''): CosmeticDef =>
  ({ id, name, flavor, set, rarity, slot: 'engine', p: { flame: 'std', particle: 'spark', tint: 'team', mix: 0, rateMul: 1, lifeMul: 1, ...p } });
const death = (id: string, name: string, set: SetOf, rarity: Rarity, p: Partial<DeathParams>, flavor = ''): CosmeticDef =>
  ({ id, name, flavor, set, rarity, slot: 'death', p: { preset: 'std', accent: WHITE, particles: 69, rings: 2, linger: 0.9, ...p } });
const title = (id: string, name: string, set: SetOf, rarity: Rarity, p: Partial<TitleParams>, flavor = ''): CosmeticDef =>
  ({ id, name, flavor, set, rarity, slot: 'title', p: { text: '', frame: 'none', color: WHITE, ...p } });
const killicon = (id: string, name: string, set: SetOf, rarity: Rarity, p: Partial<KillIconParams>, flavor = ''): CosmeticDef =>
  ({ id, name, flavor, set, rarity, slot: 'killicon', p: { glyph: '✦', ...p } });

const CATALOG: CosmeticDef[] = [
  // ---- Starters (13): owned by everyone, never drop ----
  hull('std.hull.brute', 'Juggernaut Mk I', 'starter', C, 'brute', {}),
  hull('std.hull.tech', 'Arcanist Mk I', 'starter', C, 'tech', {}),
  hull('std.hull.engineer', 'Artificer Mk I', 'starter', C, 'engineer', {}),
  weapon('std.weapon.brute', 'Standard Slugs', 'starter', C, 'brute', {}),
  weapon('std.weapon.tech', 'Standard Plasma', 'starter', C, 'tech', {}),
  weapon('std.weapon.engineer', 'Standard Rivets', 'starter', C, 'engineer', {}),
  turret('std.turret.flak', 'Flak Mount', 'starter', C, 'flak', {}),
  turret('std.turret.laser', 'Laser Mount', 'starter', C, 'laser', {}),
  turret('std.turret.seekerpod', 'Seeker Pod', 'starter', C, 'seekerpod', {}),
  engine('std.engine', 'Ion Drive', 'starter', C, {}),
  death('std.death', 'Detonation', 'starter', C, {}),
  title('std.title', 'No Title', 'starter', C, {}),
  killicon('std.killicon', 'Star', 'starter', C, { glyph: '✦' }),

  // ---- Salvage Line: set 'common', drops in every game type (13) ----
  killicon('com.killicon.crosshair', 'Crosshair', 'common', C, { glyph: '⌖' }),
  title('com.title.wingman', 'Wingman', 'common', C, { text: 'Wingman', color: STEEL }),
  weapon('com.weapon.engineer', 'Flechette Rivets', 'common', C, 'engineer', { shape: 'needle', lengthMul: 1.2, accent: STEEL }),
  turret('com.turret.flak', 'Scrap Flak', 'common', C, 'flak', { tether: 'dashed', shot: 'shard', accent: STEEL }),
  hull('com.hull.engineer', 'Hazard Stripe', 'common', U, 'engineer', { pattern: 'stripes', accent: HAZARD, amount: 0.6 }),
  hull('com.hull.tech', 'Filigree', 'common', U, 'tech', { shape: 'swept', pattern: 'stripes', accent: WHITE, amount: 0.5 }),
  weapon('com.weapon.brute', 'Tungsten Slugs', 'common', U, 'brute', { shape: 'needle', lengthMul: 1.3, core: 'dark', accent: STEEL }),
  turret('com.turret.seekerpod', 'Tinker Pod', 'common', U, 'seekerpod', { tether: 'dashed', shot: 'mote', accent: HAZARD }),
  hull('com.hull.brute', 'Riveted Bulwark', 'common', R, 'brute', { shape: 'spiked', pattern: 'stripes', accent: STEEL, amount: 0.5 }),
  weapon('com.weapon.tech', 'Frost Orb', 'common', R, 'tech', { shape: 'orb', accent: FROST, muzzle: 'ring' }),
  turret('com.turret.laser', 'Arc Welder', 'common', R, 'laser', { tether: 'lightning', beam: 'jagged', accent: FROST }),
  death('com.death.glass', 'Glass Cannon', 'common', E, { preset: 'shatter', accent: FROST, particles: 60, rings: 2, linger: 0.8 }),
  engine('com.engine.aurora', 'Aurora Drive', 'common', L, { flame: 'wide', particle: 'prism', mix: 0.5, rateMul: 1.4, lifeMul: 1.6 }, 'The sky, bottled.'),

  // ---- Rift set: Dungeon Runner only (13) ----
  killicon('rift.killicon.tear', 'Tear', 'rift', C, { glyph: '⟡' }),
  title('rift.title.riftwalker', 'Riftwalker', 'rift', C, { text: 'Riftwalker', frame: 'bracket', color: LAVENDER }),
  engine('rift.engine.abyss', 'Abyss Wake', 'rift', C, { particle: 'smoke', tint: DEEPTEAL, mix: 0.4, lifeMul: 1.5 }),
  weapon('rift.weapon.engineer', 'Runenail', 'rift', C, 'engineer', { shape: 'needle', core: 'accent', accent: ABYSS }),
  weapon('rift.weapon.brute', 'Shardcaster', 'rift', U, 'brute', { shape: 'shard', lengthMul: 1.1, accent: LAVENDER, muzzle: 'sparks' }),
  hull('rift.hull.engineer', 'Deepforge', 'rift', U, 'engineer', { shape: 'crest', pattern: 'rune', accent: ABYSS, amount: 0.5 }),
  turret('rift.turret.flak', 'Maw Mount', 'rift', U, 'flak', { mount: 'jaw', tether: 'dashed', shot: 'shard', accent: LAVENDER }),
  turret('rift.turret.seekerpod', 'Wisp Pod', 'rift', U, 'seekerpod', { mount: 'lens', tether: 'dashed', shot: 'mote', accent: ABYSS }),
  hull('rift.hull.tech', 'Veilwright', 'rift', R, 'tech', { shape: 'swept', pattern: 'rune', accent: LAVENDER, amount: 0.7 }),
  weapon('rift.weapon.tech', 'Voidbolt', 'rift', R, 'tech', { shape: 'orb', core: 'dark', accent: ABYSS, muzzle: 'ring' }),
  turret('rift.turret.laser', 'Riftlance', 'rift', R, 'laser', { mount: 'jaw', tether: 'lightning', beam: 'jagged', accent: ABYSS }),
  hull('rift.hull.brute', 'Gravemaw', 'rift', E, 'brute', { shape: 'spiked', pattern: 'rune', accent: ABYSS, amount: 1 }, 'It came back up with teeth.'),
  death('rift.death.collapse', 'Riftborn Collapse', 'rift', L, { preset: 'implode', accent: ABYSS, particles: 70, rings: 2, linger: 1.5 }, 'You do not explode. You leave.'),

  // ---- Gladiator set: Arena only (13) ----
  killicon('glad.killicon.gladius', 'Gladius', 'gladiator', C, { glyph: '†' }),
  title('glad.title.champion', 'Champion', 'gladiator', C, { text: 'Champion', frame: 'laurel', color: BRASS }),
  engine('glad.engine.torch', 'Torchbearer', 'gladiator', C, { flame: 'twin', particle: 'ember', tint: BRONZE, mix: 0.4 }),
  weapon('glad.weapon.engineer', 'Caltrop Rivets', 'gladiator', C, 'engineer', { shape: 'shard', lengthMul: 0.9, accent: BRONZE }),
  weapon('glad.weapon.brute', 'Pilum Slugs', 'gladiator', U, 'brute', { shape: 'needle', lengthMul: 1.4, accent: BRASS, muzzle: 'sparks' }),
  hull('glad.hull.engineer', 'Ballista', 'gladiator', U, 'engineer', { shape: 'crest', pattern: 'stripes', accent: BRONZE, amount: 0.6 }),
  turret('glad.turret.seekerpod', 'Hornet Nest', 'gladiator', U, 'seekerpod', { mount: 'hive', tether: 'dashed', shot: 'spark', accent: BRASS }),
  death('glad.death.triumph', 'Triumph', 'gladiator', U, { preset: 'triumph', accent: BRASS, particles: 60, rings: 2, linger: 0.9 }),
  weapon('glad.weapon.tech', 'Sunlance Bolt', 'gladiator', R, 'tech', { shape: 'needle', lengthMul: 1.5, accent: IVORY, muzzle: 'sparks' }),
  turret('glad.turret.flak', 'Scatter Crown', 'gladiator', R, 'flak', { mount: 'crown', shot: 'spark', accent: BRASS }),
  turret('glad.turret.laser', 'Heliolance', 'gladiator', R, 'laser', { mount: 'lens', beam: 'rays', accent: IVORY }),
  hull('glad.hull.tech', 'Aquila', 'gladiator', E, 'tech', { shape: 'swept', pattern: 'stripes', accent: IVORY, amount: 1 }),
  hull('glad.hull.brute', 'Colossus', 'gladiator', L, 'brute', { shape: 'crest', pattern: 'stripes', accent: BRASS, amount: 1 }, 'The crowd only chants one name.'),

  // ---- Swarm set: Warzone only (13) ----
  killicon('swarm.killicon.hive', 'Hive', 'swarm', C, { glyph: '⬢' }),
  title('swarm.title.hivebreaker', 'Hivebreaker', 'swarm', C, { text: 'Hivebreaker', frame: 'bracket', color: LIME }),
  engine('swarm.engine.spore', 'Spore Wake', 'swarm', C, { particle: 'spore', tint: LIME, mix: 0.4, rateMul: 1.1, lifeMul: 1.3 }),
  weapon('swarm.weapon.engineer', 'Larva Rivets', 'swarm', C, 'engineer', { shape: 'droplet', lengthMul: 0.9, core: 'accent', accent: LIME }),
  weapon('swarm.weapon.tech', 'Stinger Bolt', 'swarm', U, 'tech', { shape: 'needle', lengthMul: 1.2, core: 'accent', accent: LIME, muzzle: 'sparks' }),
  hull('swarm.hull.brute', 'Carapace', 'swarm', U, 'brute', { shape: 'crest', pattern: 'hex', accent: MOSS, amount: 0.6 }),
  turret('swarm.turret.flak', 'Brood Flak', 'swarm', U, 'flak', { mount: 'hive', tether: 'dashed', shot: 'mote', accent: LIME }),
  death('swarm.death.hatch', 'Hatch', 'swarm', U, { preset: 'hatch', accent: LIME, particles: 60, rings: 1, linger: 1.4 }),
  hull('swarm.hull.engineer', 'Broodmother', 'swarm', R, 'engineer', { shape: 'spiked', pattern: 'hex', accent: LIME, amount: 0.7 }),
  weapon('swarm.weapon.brute', 'Acid Slugs', 'swarm', R, 'brute', { shape: 'droplet', lengthMul: 1.2, core: 'accent', accent: LIME, muzzle: 'sparks' }),
  turret('swarm.turret.seekerpod', 'Hive Pod', 'swarm', R, 'seekerpod', { mount: 'hive', tether: 'dashed', shot: 'mote', accent: BONE }),
  hull('swarm.hull.tech', 'Mantis', 'swarm', E, 'tech', { shape: 'swept', pattern: 'hex', accent: LIME, amount: 1 }),
  turret('swarm.turret.laser', "Queen's Gaze", 'swarm', L, 'laser', { mount: 'lens', tether: 'lightning', beam: 'split', accent: LIME }, 'Every eye on the host sees you.'),
];

// ---- Flavor text (LOOT content; Hangar detail drawer). Fills only entries whose builder call left flavor empty,
// so RENDER can keep tuning the visual params above without touching these lines. ≤ 60 chars each (test-enforced).
const FLAVOR: Readonly<Record<CosmeticId, string>> = {
  'std.hull.brute': 'The factory Juggernaut frame.',
  'std.hull.tech': 'The factory Arcanist frame.',
  'std.hull.engineer': 'The factory Artificer frame.',
  'std.weapon.brute': 'Standard autocannon rounds.',
  'std.weapon.tech': 'Standard plasma bolts.',
  'std.weapon.engineer': 'Standard-issue rivets.',
  'std.turret.flak': 'The standard flak mount.',
  'std.turret.laser': 'The standard laser mount.',
  'std.turret.seekerpod': 'The standard seeker pod.',
  'std.engine': 'A plain, dependable ion drive.',
  'std.death': 'The usual fireball.',
  'std.title': 'No title shown.',
  'std.killicon': 'The classic star.',
  // Salvage Line
  'com.killicon.crosshair': 'Old reliable. Mark it and move on.',
  'com.title.wingman': 'For the pilot who always has your six.',
  'com.weapon.engineer': 'Thinner rivets, meaner holes.',
  'com.turret.flak': 'Welded from three wrecks and a prayer.',
  'com.hull.engineer': 'Caution: pilot at work.',
  'com.hull.tech': 'Etched by hand during a very long patrol.',
  'com.weapon.brute': 'Dense enough to argue with armor.',
  'com.turret.seekerpod': 'Mostly spare parts. Mostly works.',
  'com.hull.brute': 'More rivets than ship.',
  'com.weapon.tech': 'Cold light that hits like winter.',
  'com.turret.laser': 'Pulled off a shipyard gantry. Still welds.',
  'com.death.glass': 'Built to hit hard. Breaks beautifully.',
  // Rift
  'rift.killicon.tear': 'A small wound in the world.',
  'rift.title.riftwalker': 'Walked in. Walked back out.',
  'rift.engine.abyss': 'The dark follows you home.',
  'rift.weapon.engineer': 'Every rivet carries a word of binding.',
  'rift.weapon.brute': 'Crystal pried from the rift walls.',
  'rift.hull.engineer': 'Hammered on an anvil below the last floor.',
  'rift.turret.flak': 'It bites back.',
  'rift.turret.seekerpod': 'Little lights that know the way down.',
  'rift.hull.tech': 'Stitched from the thin places.',
  'rift.weapon.tech': 'Where it lands, something goes missing.',
  'rift.turret.laser': 'A line drawn straight through the dark.',
  // Gladiator
  'glad.killicon.gladius': 'Short blade, long memory.',
  'glad.title.champion': 'Earned in the pit, never given.',
  'glad.engine.torch': 'Light the way into the arena.',
  'glad.weapon.engineer': 'Scatter them and watch them dance.',
  'glad.weapon.brute': 'Thrown first. Questions later.',
  'glad.hull.engineer': 'Siege engine, parade finish.',
  'glad.turret.seekerpod': 'Kick it and find out.',
  'glad.death.triumph': 'Go out to applause.',
  'glad.weapon.tech': 'High noon, delivered.',
  'glad.turret.flak': 'Heavy is the head.',
  'glad.turret.laser': 'A spear of pure daylight.',
  'glad.hull.tech': 'Wings of the old legions.',
  // Swarm
  'swarm.killicon.hive': 'One more cell in the comb.',
  'swarm.title.hivebreaker': 'The queen knows your name.',
  'swarm.engine.spore': 'Leaves something growing behind you.',
  'swarm.weapon.engineer': 'They wriggle on the way in.',
  'swarm.weapon.tech': 'Barbed. Very barbed.',
  'swarm.hull.brute': 'Shed by something much larger.',
  'swarm.turret.flak': 'Every burst hatches another.',
  'swarm.death.hatch': 'Something was waiting inside.',
  'swarm.hull.engineer': 'She builds. They follow.',
  'swarm.weapon.brute': 'Eats straight through the problem.',
  'swarm.turret.seekerpod': 'The swarm, on your side for once.',
  'swarm.hull.tech': 'Patient. Then very fast.',
};
for (const d of CATALOG) if (!d.flavor && Object.prototype.hasOwnProperty.call(FLAVOR, d.id)) d.flavor = FLAVOR[d.id];

export const COSMETIC_LIST: readonly CosmeticDef[] = CATALOG;
export const COSMETICS: Readonly<Record<CosmeticId, CosmeticDef>> = Object.fromEntries(CATALOG.map((d) => [d.id, d]));
export const CLASS_SLOTS = ['hull', 'weapon', 'turret'] as const;
export const SHARED_SLOTS = ['engine', 'death', 'title', 'killicon'] as const;
export const COSMETIC_SLOTS: readonly CosmeticSlot[] = [...CLASS_SLOTS, ...SHARED_SLOTS];
export const TITLE_FRAMES: Readonly<Record<TitleFrame, readonly [string, string]>> = {
  none: ['', ''], bracket: ['[ ', ' ]'], chevron: ['« ', ' »'], laurel: ['❧ ', ' ☙'],
};

/** Starter item id for a slot on a ship of `shipClass`. */
export function starterId(slot: CosmeticSlot, shipClass: ShipClassId): CosmeticId {
  if (slot === 'hull' || slot === 'weapon') return `std.${slot}.${shipClass}`;
  if (slot === 'turret') return `std.turret.${SHIP_CLASSES[shipClass].turret.id}`;
  return `std.${slot}`;
}
export const isStarter = (id: CosmeticId): boolean => COSMETICS[id]?.set === 'starter';

/** Can `def` be equipped in `slot` on a ship of `shipClass`? (turret kit is 1:1 with class) */
export function fitsSlot(def: CosmeticDef, slot: CosmeticSlot, shipClass: ShipClassId): boolean {
  if (def.slot !== slot) return false;
  if (def.slot === 'hull' || def.slot === 'weapon') return def.shipClass === shipClass;
  if (def.slot === 'turret') return def.kit === SHIP_CLASSES[shipClass].turret.id;
  return true;
}

const pools = new Map<string, readonly CosmeticDef[]>();
/** Droppable items of a set at one rarity (starters and retired excluded). */
export function lootPool(set: LootSet, rarity: Rarity): readonly CosmeticDef[] {
  const k = `${set}|${rarity}`;
  let p = pools.get(k);
  if (!p) { p = CATALOG.filter((d) => d.set === set && d.rarity === rarity && !d.retired); pools.set(k, p); }
  return p;
}
