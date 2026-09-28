// Economy + drop tables. Shape frozen; numbers are tuning (LOOT agent).
import type { CosmeticId, CosmeticSlot, GameType, LootSet, LootSource, PveIntensity, Rarity } from '../types';

export const RARITY_NAMES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'] as const;
/** UI + cache-glow colours (not ship accents). Used by Command chips, Hangar, Debrief, loot layer. */
export const RARITY_COLORS: readonly number[] = [0xc8d2e0, 0x6bffa8, 0x4fb8ff, 0xc77dff, 0xffc53d];

export const SET_FOR_TYPE: Readonly<Record<GameType, Exclude<LootSet, 'common'>>> = {
  dungeon: 'rift', arena: 'gladiator', warzone: 'swarm',
};
export const SET_INFO: Readonly<Record<LootSet, { name: string; cacheName: string; mode: GameType | null; tagline: string; featured: CosmeticId[] }>> = {
  common: { name: 'Salvage Line', cacheName: 'Salvage Cache', mode: null, tagline: 'Drops in every mode.', featured: ['com.engine.aurora', 'com.death.glass', 'com.turret.laser'] },
  rift: { name: 'Rift Set', cacheName: 'Rift Cache', mode: 'dungeon', tagline: 'Torn from the deep floors. Dungeon Runner only.', featured: ['rift.death.collapse', 'rift.hull.brute', 'rift.turret.laser'] },
  gladiator: { name: 'Gladiator Set', cacheName: 'Gladiator Cache', mode: 'arena', tagline: 'Won in the pit. Arena only.', featured: ['glad.hull.brute', 'glad.hull.tech', 'glad.turret.laser'] },
  swarm: { name: 'Swarm Set', cacheName: 'Swarm Cache', mode: 'warzone', tagline: 'Cut from the hive. Warzone only.', featured: ['swarm.turret.laser', 'swarm.hull.tech', 'swarm.hull.engineer'] },
};

export const CACHE_RARITY_W: readonly number[] = [60, 25, 10, 4, 1];
export const CRATE_RARITY_W: readonly number[] = [55, 28, 12, 4.5, 0.5];
/** Share of caches/crates that roll the game type's exclusive set (rest: Salvage Line). */
export const MODE_SET_SHARE = 0.4;

export interface DropRule {
  /** Chance per trigger per game type (missing = never). Multiplied by SimConfig.lootMult. */
  chance: Partial<Record<GameType, number>>;
  /** One cache per entry (per recipient when personal), each with this rarity floor. */
  floors: readonly Rarity[];
  /** Priority window (s) for the priority player; ignored when personal. */
  reserveSec: number;
  /** One set of caches per human of the party, reserved for that human until the floor ends. */
  personal: boolean;
}
export const DROP_RULES: Readonly<Record<LootSource, DropRule>> = {
  // warzone 0.03 → 0.05 (M2 soak: Warzone Classic, 4 humans + 12 bots, Normal swarm, 3 seeds × 10 min gave 1.75
  // caches per human at 0.03 and 2.25 at 0.05, against §6.7's 2–3).
  elite:         { chance: { dungeon: 0.06, warzone: 0.05 }, floors: [0], reserveSec: 3, personal: false },
  boss:          { chance: { warzone: 1 }, floors: [2], reserveSec: 3, personal: false },
  shutdown:      { chance: { arena: 0.3, warzone: 0.15 }, floors: [0], reserveSec: 3, personal: false },
  roomChest:     { chance: { dungeon: 0.25 }, floors: [0], reserveSec: 0, personal: true },
  treasureChest: { chance: { dungeon: 0.25 }, floors: [1], reserveSec: 0, personal: true },
  keyChest:      { chance: { dungeon: 1 }, floors: [1], reserveSec: 0, personal: true },
  bossCache:     { chance: { dungeon: 1 }, floors: [2, 0], reserveSec: 0, personal: true },
  flagCapture:   { chance: { arena: 1, warzone: 1 }, floors: [1], reserveSec: 3, personal: false },
  carrierKill:   { chance: { arena: 0.25, warzone: 0.25 }, floors: [0], reserveSec: 3, personal: false },
  zoneCapture:   { chance: { arena: 0.25, warzone: 0.25 }, floors: [0], reserveSec: 3, personal: false },
  zoneHold:      { chance: { arena: 0.5, warzone: 0.5 }, floors: [0], reserveSec: 3, personal: false },
  hotHold:       { chance: { arena: 1 }, floors: [1], reserveSec: 3, personal: false },
  hotFirstCap:   { chance: { arena: 0.35 }, floors: [0], reserveSec: 3, personal: false },
};
export const SHUTDOWN_MIN_STREAK = 3;
/** Seconds of continuous hold per zoneHold roll. */
export const ZONE_HOLD_ROLL_SEC = 60;
/** Non-personal cache cap: arena/warzone per match min(MAX, BASE + PER_HUMAN·humans); dungeon per floor. */
export const LOOT_MATCH_CAP_BASE = 8;
export const LOOT_MATCH_CAP_PER_HUMAN = 4;
export const LOOT_MATCH_CAP_MAX = 72;
export const LOOT_FLOOR_CAP_BASE = 4;
export const LOOT_FLOOR_CAP_PER_HUMAN = 2;
/** lootMult with exactly one human in the match (≥ 2 humans or offline: 1.0). */
export const LOOT_MULT_SOLO: Readonly<Record<GameType, number>> = { dungeon: 1, arena: 0.35, warzone: 0.5 };
/** Dungeon rarity boost on rare+ weights: (1 + 0.15·(floor − 1)) × (Nightmare ? 1.5 : 1). */
export function riftRarityBoost(floor: number, pve: PveIntensity): number {
  return (1 + 0.15 * Math.max(0, floor - 1)) * (pve >= 3 ? 1.5 : 1);
}

/** Shards granted for a duplicate of each rarity. */
export const SALVAGE_VALUE: readonly number[] = [5, 15, 40, 100, 250];
export const OWNED_REROLLS = 1;
export const PITY_EPIC = 12;
export const PITY_LEGENDARY = 60;
export const CRATE_MIN_PLAYED_SEC = 120;
export const CRATE_MIN_MATCH_SEC = 180;
export const CRATE_WIN_BONUS = 1;
export const CRATE_FLOOR_BONUS_MAX = 3;
export const CRATE_FULL_CLEAR_BONUS = 1;
export const SHARDS_BASE = 5;
export const SHARDS_PER_MIN = 1;
export const SHARDS_TIME_CAP = 25;
export const SHARDS_WIN = 10;
export const SHARDS_MVP = 10;
export const SHARDS_MAX = 999_999;
export const FRESH_MAX = 64;
export const RECENT_MAX = 20;
/** Profile ops (equip / seenItems) per window per user. */
export const PROFILE_OPS_BURST = 20;
export const PROFILE_OPS_WINDOW_MS = 10_000;
/** Bots wear seeded looks from the mode set + Salvage (≤ rare): "window shopping" for the mode's draws. */
export const BOT_MAX_RARITY: Rarity = 2;
export const BOT_SLOT_CHANCE: Readonly<Record<CosmeticSlot, number>> = {
  hull: 0.5, weapon: 0.3, turret: 0.3, engine: 0.4, death: 0.2, title: 0.15, killicon: 0.15,
};
