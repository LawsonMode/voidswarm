// Canonical version lives in the root package.json — never edit a version number here.
import pkg from '../../package.json';

export const GAME_VERSION: string = pkg.version;
/**
 * Bump when the wire protocol changes incompatibly (client/server must match).
 * v0.3: game types, quickPlay, join intents, floorStart, profile/loot, the §8.9 snapshot layout.
 * (docs/v0.3-proposal.md §8.4 says 3, but v0.2.1 had already taken 3, so v0.3 is 4. Likewise the
 * proposal's "codec v4" layout ships as codec VERSION 5, because v0.2.1 already used 4; see ARCHITECTURE.md §5.)
 */
export const PROTOCOL_VERSION = 5;
