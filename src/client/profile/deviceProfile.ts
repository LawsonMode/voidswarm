// The device profile as the CLIENT drives it (docs/v0.3-proposal.md §7.3 step 7): online guests never get a
// server profile, so the client applies their lootGrants (applyGrant, deduplicated by the device ledger),
// Hangar equips and NEW-badge clears to the LocalProfileStore itself. Offline, the in-page Zone owns the
// same store; the client only reads it as a fallback until the Zone's `profile` message arrives.
// Never throws: LOOT's pure ops are wrapped (a failure is reported, the profile is left as it was).
import type { LootGrant, Profile } from '../../shared/protocol';
import { equip as equipOp, markSeen as markSeenOp, normalizeProfile } from '../../shared/profile/profile';
import { applyGrant as applyGrantOp } from '../../shared/profile/rolls';
import type { ProfileStore } from '../../shared/profile/store';
import type { CosmeticId, CosmeticSlot, ShipClassId } from '../../shared/types';
import { LOCAL_PROFILE_KEY } from './LocalProfileStore';

export type DeviceGrantResult = 'applied' | 'duplicate' | 'failed';
export type DeviceOpResult = { ok: true; profile: Profile } | { ok: false; error: string };

export class DeviceProfile {
  private cached: Profile | null = null;
  /** false when the stored profile is from a newer version (read-only for the session). */
  writable = true;
  private warned = false;

  constructor(readonly store: ProfileStore, readonly key: string = LOCAL_PROFILE_KEY) {}

  get profile(): Profile | null { return this.cached; }

  /** Fresh read from the store (another tab or the offline Zone may have written). */
  load(now = Date.now()): Profile | null {
    try {
      const r = normalizeProfile(this.store.load(this.key), now);
      this.cached = r.profile;
      this.writable = r.writable;
    } catch (e) {
      this.warn('load', e);
    }
    return this.cached;
  }

  /** Apply an already-rolled grant once (the device ledger drops a grantKey it has seen). `won` feeds the stats. */
  applyGrant(grant: LootGrant, now = Date.now(), won = false): DeviceGrantResult {
    if (!grant || typeof grant.grantKey !== 'string' || !grant.grantKey) return 'failed';
    const p = this.load(now);
    if (!p) return 'failed';
    if (!this.writable) return 'failed';
    try {
      const next = applyGrantOp(p, grant, now, won);
      const [recorded] = this.store.commitGrants([{ key: this.key, grantKey: grant.grantKey, grant, profile: next }]);
      if (!recorded) { this.load(now); return 'duplicate'; }
      this.cached = next;
      return 'applied';
    } catch (e) {
      this.warn('applyGrant', e);
      return 'failed';
    }
  }

  /** Hangar equip (itemId '' = starter). */
  equip(slot: CosmeticSlot, itemId: CosmeticId, shipClass: ShipClassId | undefined, now = Date.now()): DeviceOpResult {
    const p = this.load(now);
    if (!p) return { ok: false, error: 'Device profile unavailable' };
    if (!this.writable) return { ok: false, error: 'This device profile is from a newer version (read-only)' };
    try {
      const r = equipOp(p, slot, itemId, shipClass);
      if (!r.ok) return r;
      this.store.save(this.key, r.profile);
      this.cached = r.profile;
      return r;
    } catch (e) {
      this.warn('equip', e);
      return { ok: false, error: 'Could not equip that item' };
    }
  }

  /** Clear NEW badges. Returns the profile after (unchanged on failure). */
  markSeen(ids: readonly CosmeticId[], now = Date.now()): Profile | null {
    const p = this.load(now);
    if (!p || !this.writable || !ids.length) return p;
    try {
      const next = markSeenOp(p, ids);
      if (next !== p) this.store.save(this.key, next);
      this.cached = next;
    } catch (e) {
      this.warn('markSeen', e);
    }
    return this.cached;
  }

  private warn(what: string, e: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[voidswarm] device profile ${what} failed`, e);
  }
}
