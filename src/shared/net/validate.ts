// OWNER: ROOM agent. Shape-check untrusted JSON from the wire into a ClientMsg (or null = drop).
// Field values are further sanitized/clamped inside Zone/Room; this only rejects garbage.
import { isGameType, isSubMode } from '../data/gameTypes';
import type { ClientMsg, JoinIntent } from '../protocol';
import type { CosmeticSlot } from '../types';

const KNOWN = new Set<ClientMsg['type']>([
  'hello', 'listRooms', 'createRoom', 'joinRoom', 'quickPlay', 'leaveRoom', 'chat', 'setName', 'setTeam', 'setShip',
  'ready', 'updateSettings', 'startMatch', 'joinMatch', 'input', 'spectate', 'chooseUpgrade', 'ping',
  'equip', 'seenItems',
]);

/**
 * v0.3 join intents a client may send. Quick Play's 'quick' intent is server-internal and never accepted
 * from the wire (docs/v0.3-proposal.md §3.5, fix #20).
 */
const WIRE_INTENTS: ReadonlySet<string> = new Set<JoinIntent>(['lobby', 'play', 'watch']);
const COSMETIC_SLOTS: ReadonlySet<string> = new Set<CosmeticSlot>(['hull', 'weapon', 'turret', 'engine', 'death', 'title', 'killicon']);
/** Catalog ids are short ('rift.hull.brute'); §7.4: ≤ 40 chars (profile MAX_ID_LEN). Anything longer is garbage. */
const MAX_ITEM_ID_LEN = 40;
/** seenItems carries at most this many ids (Profile.fresh ≤ 64). */
const MAX_SEEN_IDS = 64;

/** Entity ids are allocated from 1 upward; anything outside a non-negative int32 is garbage. */
const isEntityId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0x7fffffff;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isItemId = (v: unknown): v is string => isStr(v) && v.length <= MAX_ITEM_ID_LEN;

export function validateClientMsg(raw: unknown): ClientMsg | null {
  if (!isObj(raw) || !isStr(raw.type) || !KNOWN.has(raw.type as ClientMsg['type'])) return null;
  const m = raw;
  switch (m.type as ClientMsg['type']) {
    case 'hello':
      return isStr(m.name) && isNum(m.protocol) && (m.token === undefined || m.token === null || isStr(m.token))
        ? (m as unknown as ClientMsg) : null;
    case 'createRoom': case 'updateSettings': return isObj(m.settings) ? (m as unknown as ClientMsg) : null;
    // v0.3: optional intent, whitelisted (absent = 'lobby'). Only known fields pass.
    case 'joinRoom': {
      if (!isStr(m.roomId)) return null;
      if (m.intent === undefined || m.intent === null) return { type: 'joinRoom', roomId: m.roomId };
      return isStr(m.intent) && WIRE_INTENTS.has(m.intent)
        ? { type: 'joinRoom', roomId: m.roomId, intent: m.intent as JoinIntent } : null;
    }
    // v0.3 Quick Play: a known game type and (optionally) a known sub-mode; the Zone checks the combination.
    case 'quickPlay': {
      if (!isGameType(m.gameType)) return null;
      if (m.subMode === undefined || m.subMode === null) return { type: 'quickPlay', gameType: m.gameType };
      return isSubMode(m.subMode) ? { type: 'quickPlay', gameType: m.gameType, subMode: m.subMode } : null;
    }
    case 'chat': return isStr(m.text) ? (m as unknown as ClientMsg) : null;
    case 'setName': return isStr(m.name) ? (m as unknown as ClientMsg) : null;
    case 'setTeam': return isNum(m.team) ? (m as unknown as ClientMsg) : null;
    case 'setShip': return isStr(m.shipClass) ? (m as unknown as ClientMsg) : null;
    case 'ready': return typeof m.ready === 'boolean' ? (m as unknown as ClientMsg) : null;
    case 'input': return isObj(m.input) ? (m as unknown as ClientMsg) : null;
    // Spectator camera target (0 = server default). Only the id travels on: stray fields are dropped.
    case 'spectate': return isEntityId(m.shipId) ? { type: 'spectate', shipId: m.shipId } : null;
    // offerId = YouState.offerId being answered (an integer serial); required since protocol v0.2 fix.
    case 'chooseUpgrade': return isNum(m.index) && Number.isInteger(m.offerId) ? (m as unknown as ClientMsg) : null;
    case 'ping': return isNum(m.t) ? (m as unknown as ClientMsg) : null;
    // v0.3 Hangar: a known slot, a short item id ('' = starter), an optional class id (checked by the profile layer).
    case 'equip': {
      if (!isStr(m.slot) || !COSMETIC_SLOTS.has(m.slot) || !isItemId(m.itemId)) return null;
      if (m.shipClass !== undefined && m.shipClass !== null && !isStr(m.shipClass)) return null;
      const out: Extract<ClientMsg, { type: 'equip' }> = { type: 'equip', slot: m.slot as CosmeticSlot, itemId: m.itemId };
      if (isStr(m.shipClass)) out.shipClass = m.shipClass as Extract<ClientMsg, { type: 'equip' }>['shipClass'];
      return out;
    }
    case 'seenItems': {
      const ids = m.ids;
      if (!Array.isArray(ids) || ids.length > MAX_SEEN_IDS || !ids.every(isItemId)) return null;
      return { type: 'seenItems', ids: ids.slice() };
    }
    default: return m as unknown as ClientMsg; // no payload
  }
}
