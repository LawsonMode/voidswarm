import type { LootGrant, Profile } from '../protocol';

export interface GrantCommit {
  /** Profile key: accountId | 'local'. (Online guests never reach a store.) */
  key: string;
  grantKey: string;
  grant: LootGrant;
  /** Profile AFTER applying the grant. */
  profile: Profile;
}

/** All implementations are SYNCHRONOUS (node:sqlite DatabaseSync, localStorage, memory). */
export interface ProfileStore {
  /** Raw stored profile (caller normalizes), or null if none yet / unreadable. */
  load(key: string): unknown | null;
  /** Persist the full profile. May throw (storage failure, ProfileConflict). */
  save(key: string, profile: Profile): void;
  /** One transaction: record each grantKey + save its profile. false = grantKey already recorded (no write). */
  commitGrants(batch: readonly GrantCommit[]): boolean[];
  close?(): void;
}

export class ProfileConflict extends Error {}

// ---------------------------------------------------------------------------------------------
// LOOT: MemoryProfileStore — for tests and the headless smoke run (implementation only; the interface above is frozen).
// Values are stored as JSON strings, so callers never share object identity with the store (like a real backend).
// ---------------------------------------------------------------------------------------------
export class MemoryProfileStore implements ProfileStore {
  private readonly data = new Map<string, string>();
  /** key → grantKey → grant JSON (the loot_ledger analogue). */
  private readonly ledger = new Map<string, Map<string, string>>();
  /** Test hook: the next `failNext` save / commitGrants calls throw (Infinity = every call). load is unaffected. */
  failNext = 0;
  /** Test hook: when true, load throws too. */
  failLoads = false;
  /** Writes performed (save + committed grants), for tests. */
  writes = 0;

  load(key: string): unknown | null {
    if (this.failLoads) throw new Error('MemoryProfileStore: simulated load failure');
    const s = this.data.get(key);
    if (s === undefined) return null;
    try { return JSON.parse(s) as unknown; } catch { return null; }
  }

  save(key: string, profile: Profile): void {
    this.maybeFail('save');
    this.data.set(key, JSON.stringify(profile));
    this.writes++;
  }

  commitGrants(batch: readonly GrantCommit[]): boolean[] {
    this.maybeFail('commitGrants');
    // Stage everything first so a throw (e.g. JSON.stringify) leaves the store untouched: one "transaction".
    const res: boolean[] = [];
    const staged: { key: string; grantKey: string; grant: string; profile: string }[] = [];
    const seen = new Set<string>();
    for (const c of batch) {
      const lk = `${c.key}\u0000${c.grantKey}`;
      if (this.ledger.get(c.key)?.has(c.grantKey) || seen.has(lk)) { res.push(false); continue; }
      seen.add(lk);
      staged.push({ key: c.key, grantKey: c.grantKey, grant: JSON.stringify(c.grant), profile: JSON.stringify(c.profile) });
      res.push(true);
    }
    for (const s of staged) {
      let m = this.ledger.get(s.key);
      if (!m) this.ledger.set(s.key, (m = new Map()));
      m.set(s.grantKey, s.grant);
      this.data.set(s.key, s.profile);
      this.writes++;
    }
    return res;
  }

  close(): void { /* nothing to release */ }

  // ---- test helpers (not part of ProfileStore) ----
  hasGrant(key: string, grantKey: string): boolean { return !!this.ledger.get(key)?.has(grantKey); }
  /** The recorded grant for a ledger key, or null. */
  recordedGrant(key: string, grantKey: string): LootGrant | null {
    const s = this.ledger.get(key)?.get(grantKey);
    return s === undefined ? null : (JSON.parse(s) as LootGrant);
  }
  /** Store raw text (simulate a corrupted / foreign profile_json). */
  setRaw(key: string, json: string): void { this.data.set(key, json); }
  keys(): string[] { return [...this.data.keys()]; }

  private maybeFail(op: string): void {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error(`MemoryProfileStore: simulated ${op} failure`);
    }
  }
}
