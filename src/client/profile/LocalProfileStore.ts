// Device-local ProfileStore (docs/v0.3-proposal.md §7.2): the offline Zone's store, and the device profile
// that online guests keep. localStorage key 'voidswarm.profile.device', blob
// { v: 1, profiles: { local }, ledger: string[≤100] }. Synchronous, like every ProfileStore.
//
// Every storage access is wrapped in try/catch. When storage is unavailable (private mode, blocked site data,
// quota) the store keeps working from an in-memory copy for the rest of the session and reports
// `persistent = false`, so the UI can say that loot won't survive a reload.
//
// Stale writes (two tabs on one device): like the SQLite store's rev check, a write of a key must build on what
// THIS store instance last loaded or wrote for it. If another tab wrote in between, save / commitGrants throw
// ProfileConflict and write nothing; ProfileService then re-reads the store and re-applies (a grant) or drops
// the op (an equip). A key never loaded here may only be written while nothing is stored for it yet.
import type { Profile } from '../../shared/protocol';
import { ProfileConflict, type GrantCommit, type ProfileStore } from '../../shared/profile/store';

export const DEVICE_PROFILE_KEY = 'voidswarm.profile.device';
export const DEVICE_BLOB_VERSION = 1;
/** Grant keys remembered (oldest dropped first). Guards a replayed lootGrant against double-applying. */
export const DEVICE_LEDGER_MAX = 100;
/** The one profile a device holds: the offline Zone and online-guest play share it. */
export const LOCAL_PROFILE_KEY = 'local';

export interface DeviceBlob {
  v: number;
  profiles: Record<string, unknown>;
  ledger: string[];
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

const emptyBlob = (): DeviceBlob => ({ v: DEVICE_BLOB_VERSION, profiles: {}, ledger: [] });

/** Deep copy through JSON (profiles are plain JSON; callers may mutate what they get). */
function copy<T>(v: T): T {
  return v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)) as T;
}

/** Revision stamp of a stored profile: its canonical JSON (undefined = nothing stored). */
function stampOf(v: unknown): string | undefined {
  return v === undefined ? undefined : JSON.stringify(v);
}

/** Parse a stored blob. Garbage → null (treated as empty). Never throws. */
export function parseDeviceBlob(raw: string | null): DeviceBlob | null {
  if (raw === null || raw === '') return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const ver = typeof o.v === 'number' && Number.isFinite(o.v) ? o.v : DEVICE_BLOB_VERSION;
  const profiles = o.profiles && typeof o.profiles === 'object' && !Array.isArray(o.profiles)
    ? { ...(o.profiles as Record<string, unknown>) } : {};
  const ledger = Array.isArray(o.ledger)
    ? o.ledger.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 256).slice(-DEVICE_LEDGER_MAX)
    : [];
  return { v: ver, profiles, ledger };
}

export class LocalProfileStore implements ProfileStore {
  /** false once a storage read or write failed: the profile lives in memory for this session only. */
  persistent = true;
  /** The stored blob is from a newer client (v > 1): it is read but never overwritten. */
  readOnly = false;
  private mem: DeviceBlob = emptyBlob();
  /** The in-memory copy holds writes that storage refused: it wins over what storage returns. */
  private memAhead = false;
  /** key → stamp of the profile this instance last loaded or wrote ('' = loaded while nothing was stored). */
  private seen = new Map<string, string>();

  constructor(
    private readonly storage: () => StorageLike | null | undefined = defaultStorage,
    private readonly storageKey: string = DEVICE_PROFILE_KEY,
  ) {}

  /** Fresh read every time (another tab, or the offline Zone, may have written in between). */
  private read(): DeviceBlob {
    if (this.memAhead) return this.mem;
    let raw: string | null;
    try {
      const s = this.storage();
      if (!s) { this.persistent = false; return this.mem; }
      raw = s.getItem(this.storageKey);
    } catch {
      this.persistent = false;
      return this.mem;
    }
    const blob = parseDeviceBlob(raw);
    if (!blob) return raw === null || raw === '' ? (this.mem = emptyBlob()) : this.mem;
    if (blob.v > DEVICE_BLOB_VERSION) this.readOnly = true;
    this.mem = blob;
    return blob;
  }

  private write(blob: DeviceBlob): void {
    this.mem = blob;
    if (this.readOnly) { this.memAhead = true; this.persistent = false; return; }
    try {
      const s = this.storage();
      if (!s) throw new Error('no storage');
      s.setItem(this.storageKey, JSON.stringify(blob));
      this.memAhead = false;
    } catch {
      this.persistent = false;
      this.memAhead = true;
    }
  }

  load(key: string): unknown | null {
    const p = this.read().profiles[key];
    this.seen.set(key, stampOf(p) ?? '');
    return p === undefined ? null : copy(p);
  }

  /** Throw ProfileConflict when `key` changed in storage since this instance last loaded or wrote it. */
  private checkFresh(b: DeviceBlob, key: string): void {
    const cur = stampOf(b.profiles[key]);
    const last = this.seen.get(key);
    if (last === undefined) {
      if (cur === undefined) return; // nothing stored yet: nothing to clobber
      throw new ProfileConflict(`device profile ${key} was never loaded by this tab: load it first`);
    }
    if ((cur ?? '') !== last) throw new ProfileConflict(`device profile ${key} changed in another tab`);
  }

  save(key: string, profile: Profile): void {
    const b = this.read();
    this.checkFresh(b, key);
    const stored = copy(profile);
    this.write({ v: Math.max(DEVICE_BLOB_VERSION, b.v), profiles: { ...b.profiles, [key]: stored }, ledger: [...b.ledger] });
    this.seen.set(key, stampOf(stored) ?? '');
  }

  /** One "transaction": a stale key throws ProfileConflict before anything is written (see the file header). */
  commitGrants(batch: readonly GrantCommit[]): boolean[] {
    const b = this.read();
    const ledger = [...b.ledger];
    const recorded = new Set(ledger);
    const profiles = { ...b.profiles };
    const checked = new Set<string>();
    const written = new Map<string, unknown>();
    const out = batch.map((c) => {
      if (!c.grantKey || recorded.has(c.grantKey)) return false;
      if (!checked.has(c.key)) { this.checkFresh(b, c.key); checked.add(c.key); }
      recorded.add(c.grantKey);
      ledger.push(c.grantKey);
      profiles[c.key] = copy(c.profile);
      written.set(c.key, profiles[c.key]);
      return true;
    });
    if (written.size) {
      this.write({ v: Math.max(DEVICE_BLOB_VERSION, b.v), profiles, ledger: ledger.slice(-DEVICE_LEDGER_MAX) });
      for (const [key, p] of written) this.seen.set(key, stampOf(p) ?? '');
    }
    return out;
  }

  /** True when this grant key was already recorded on this device. */
  hasGrant(grantKey: string): boolean {
    return this.read().ledger.includes(grantKey);
  }
}
