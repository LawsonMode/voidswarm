// The Title screen's rotating feature ticker. Numbers come from the data files so the lines stay true.
import { MAX_PLAYERS } from '../../shared/constants';
import { COSMETIC_LIST } from '../../shared/data/cosmetics';
import { GAME_TYPE_IDS, GAME_TYPES } from '../../shared/data/gameTypes';
import { PATHS, SHIP_CLASS_IDS } from '../../shared/data/ships';

/** Cosmetics that can drop (starters are owned from the start; retired items no longer drop). */
export function unlockableCosmetics(): number {
  return COSMETIC_LIST.filter((d) => d.set !== 'starter' && !d.retired).length;
}

export function featureLines(): string[] {
  return [
    `${SHIP_CLASS_IDS.length} classes · ${Object.keys(PATHS).length} build paths`,
    GAME_TYPE_IDS.map((t) => GAME_TYPES[t].name).join(' · '),
    `${MAX_PLAYERS} pilots · turret stacking`,
    `${unlockableCosmetics()} cosmetics to unlock`,
  ].map((s) => s.toUpperCase());
}
