// OWNER: OBJECTIVES agent (numbers are tuning). Shared objective tuning read by SIM / AI / CLIENT / RENDER.
// ARCHITECT seed (v0.3 M1 contract): names and values from docs/v0.3-proposal.md §8.8; carrierSpeedMult is frozen.
import { SHIPFLAG_CARRIER } from '../../types';

// ---- Capture the Flag (§5.3) ----
export const CTF_CAPTURE_RADIUS = 90;
export const CTF_PICKUP_PAD = 26;
export const CTF_STAND_OFFSET_PX = 192;
export const CTF_RETURN_SEC = 20;
/** Carrier speed (§5.3): pass 1 movement and Ram Charge (skills.ts stepCharge) alike; ×0.82 with the gunner seat. */
export const CTF_CARRIER_SPEED_MULT = 0.88;
/** The gunner seat: a carrier keeps turret slot 0 only. */
export const CTF_CARRIER_MAX_TURRETS = 1;
export const CTF_CARRIER_BLINK_MULT = 0.5;
/** Flag Overload: after this many seconds of continuous carry, recharge × CTF_OVERLOAD_HALF_MULT ... */
export const CTF_OVERLOAD_SEC = 60;
export const CTF_OVERLOAD_HALF_MULT = 0.5;
/** ... and after this many, recharge × 0. */
export const CTF_OVERLOAD_FULL_SEC = 90;
/**
 * Sudden death (§5.3 "next capture wins"): +180 s after a time-out tie; the first capture that leaves ONE team on
 * top ends it (with 2 teams that is simply the next capture). In 3–4 team CTF a capture by a trailing team that
 * only joins the tie (1-1-0 → 1-1-1) does not end the match. A sudden-death time-out is a draw.
 */
export const CTF_SUDDEN_DEATH_SEC = 180;
export const CTF_SCORE = { capture: 100, assist: 30, steal: 15, returned: 20, carrierKill: 25, defendKill: 5 } as const;
export const CTF_ASSIST_RADIUS = 900;
export const CTF_DEFEND_RADIUS = 700;
/**
 * OBJECTIVES addition: after a forced drop while still alive (class / team swap), that ship can't take a flag again
 * for this long. The Flag Overload clock itself survives the hand-off: the releasing team re-taking that flag before
 * it goes home keeps the old carry clock (ctf.ts keepCarry), so neither a swap nor a teammate beside it resets it.
 */
export const CTF_REPICK_SEC = 2;
/** OBJECTIVES addition: stand carve radius (tiles) around each flagStand (§5.1 "a 4-tile disc"). */
export const CTF_STAND_CARVE_TILES = 4;

/** Flag Overload recharge multiplier after `heldSec` seconds of continuous carry (1 → 0.5 at 60 s → 0 at 90 s). */
export function flagOverloadMult(heldSec: number): number {
  if (heldSec >= CTF_OVERLOAD_FULL_SEC) return 0;
  if (heldSec >= CTF_OVERLOAD_SEC) return CTF_OVERLOAD_HALF_MULT;
  return 1;
}

// ---- Control Zones (§5.4) ----
export const ZONE_RADIUS = 200;
export const ZONE_RING_PX = 1300;
export const ZONE_CAP_SEC = 8;
/** Capture-rate multiplier by bodies inside (index = count, 3+ uses the last entry). */
export const ZONE_BODY_MULT: readonly number[] = [0, 1, 1.5, 2];
export const ZONE_DECAY_DELAY_SEC = 3;
export const ZONE_DECAY_PER_SEC = 0.125;
export const ZONE_POINT_SEC = 2;
export const ZONE_TIE_EXTEND_SEC = 60;
export const ZONE_TIE_EXTENSIONS = 3;
/** Warzone: at least this many enemies inside a zone block capture progress. */
export const ZONE_SWARM_BLOCK = 3;
export const ZONE_SCORE = { capture: 15, neutralize: 10, workTickSec: 2 } as const;
/** A flip credits every pilot of the flipping side who was inside within this many seconds (§5.4). */
export const ZONE_CONTRIB_SEC = 3;
/** Zones per map: clamp(teams + 1, ZONE_COUNT_MIN, ZONE_COUNT_MAX). Index 0 = Core, 1.. = A..D. */
export const ZONE_COUNT_MIN = 3;
export const ZONE_COUNT_MAX = 5;
/** HUD / render labels by zone index (feature.index). */
export const ZONE_LABELS: readonly string[] = ['Core', 'A', 'B', 'C', 'D'];
export function zoneCount(teams: number): number {
  return Math.max(ZONE_COUNT_MIN, Math.min(ZONE_COUNT_MAX, Math.floor(teams) + 1));
}
/** Extra carve (tiles) beyond the pad radius around zones and hot sites (§5.1 "radius + 2 tiles"). */
export const PAD_CARVE_EXTRA_TILES = 2;
/** Cover rocks around zone pads and hot sites (§5.1): count, radius (tiles), distance band from the centre (px). */
export const COVER_ROCKS = 3;
export const COVER_ROCK_TILES = 1.3;
export const COVER_MIN_PX = 110;
export const COVER_MAX_PX = 160;

// ---- Hot Point (§5.5) ----
export const HOT_RADIUS = 240;
export const HOT_SITES = 8;
export const HOT_CAP_SEC = 5;
export const HOT_MOVE_SEC = 60;
export const HOT_WARN_SEC = 10;
export const HOT_ARM_SEC = 3;
export const HOT_MIN_BASE_DIST = 900;
export const HOT_MIN_SITE_SPACING = 700;
export const HOT_MIN_MOVE_DIST = 1400;
export const HOT_FFA_SPAWN_AVOID = 800;
export const HOT_OT_GRACE_SEC = 1;
export const HOT_OT_CAP_SEC = 60;
/** Personal score (§5.5): capture +15; +1 per workTickSec inside while your side holds, caps or contests. */
export const HOT_SCORE = { capture: 15, workTickSec: 2 } as const;
/** Hot-site placement (§5.1): keep this far from the map edge; FFA sites stay within this of the centre. */
export const HOT_BORDER_PX = 400;
export const HOT_FFA_MAX_CENTRE_DIST = 2600;
/** Hot-site rejection sampling: spacing × HOT_SPACING_RELAX_MULT after every HOT_SPACING_RELAX_EVERY failures. */
export const HOT_SPACING_RELAX_EVERY = 400;
export const HOT_SPACING_RELAX_MULT = 0.85;

/** Speed multiplier from ShipView/Ship flags (client prediction and sim share it). FROZEN. */
export function carrierSpeedMult(flags: number): number {
  return (flags & SHIPFLAG_CARRIER) ? CTF_CARRIER_SPEED_MULT : 1;
}
