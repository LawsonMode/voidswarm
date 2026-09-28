// OWNER: LOOT agent. ProfileService: attach on hello, equip / seenItems (rate-limited), grantBatch (docs/v0.3-proposal.md §7.3).
// Method names are frozen by §8.8. The constructor options, ProfileUser, (Profile)GrantEntry and GrantOutcome are LOOT-owned
// (refined from the M1 stub: see the notes on each).
//
// The service never throws out of a public method: storage failures are logged, and grants are queued and retried.
// It never touches the DOM or Node APIs (runs server-side and in the offline in-page Zone).
import type { ClientMsg, LootGrant, Profile, ServerMsg } from '../protocol';
import type { GameType, PlayerId } from '../types';
import type { ZoneUser } from '../room/user';
import { FRESH_MAX, PITY_EPIC, PITY_LEGENDARY, PROFILE_OPS_BURST, PROFILE_OPS_WINDOW_MS } from '../data/loot';
import { hash32 } from '../util/hash';
import { Rng } from '../util/rng';
import { MAX_ID_LEN, defaultProfile, equip, isCosmeticIdLike, markSeen, normalizeProfile } from './profile';
import { applyGrant, grantSeed, rollGrant, type GrantInput } from './rolls';
import { ProfileConflict, type GrantCommit, type ProfileStore } from './store';

/**
 * The slice of ZoneUser the service reads and writes (§8.8: ZoneUser += profile, profileKey, profileWritable,
 * opTimes). Structural, so a ZoneUser is accepted as-is; attach() initializes every field.
 */
export interface ProfileUser {
  readonly playerId: PlayerId;
  readonly sink: { sendMsg(msg: ServerMsg): void };
  /** null = online guest (no server profile; the client keeps a device profile). */
  profile: Profile | null;
  /** accountId | 'local' | null (online guest). */
  profileKey: string | null;
  /** false = read-only this session (v > PROFILE_VERSION, or the store could not be read at attach). */
  profileWritable: boolean;
  /** epoch ms of recent equip / seenItems ops (PROFILE_OPS_BURST per PROFILE_OPS_WINDOW_MS). */
  opTimes: number[];
}

/** One human's grant. profileKey: accountId | 'local' | `guest:${playerId}` (guests are rolled, never stored). */
export interface ProfileGrantEntry { user: ProfileUser | null; profileKey: string; input: GrantInput }
/** The Room-facing entry (= room/user.ts LootGrantEntry, RoomHost.grantLoot), as in the M1 stub. */
export interface GrantEntry extends ProfileGrantEntry { user: ZoneUser | null }

/**
 * persisted: false = the grant is not in any server-side store — apply it to the device profile (guests), or the
 * store failed / is absent / the profile is read-only (account pilots: show it, don't apply it to the device).
 */
export interface GrantOutcome {
  grant: LootGrant;
  persisted: boolean;
  /**
   * This grantKey was already recorded (idempotent replay): nothing changed, and `grant` is the grant this process
   * recorded for it (empty when an earlier process did), never a re-roll. Don't send or announce it again.
   */
  duplicate?: boolean;
  /** The store failed; the grant is queued and retried on the next GRANT_RETRY_PASSES retryQueued() calls. */
  queued?: boolean;
}

export type ProfileMsg = Extract<ClientMsg, { type: 'equip' } | { type: 'seenItems' }>;

export interface ProfileServiceOptions {
  /** Clock (epoch ms). Default Date.now. */
  now?: () => number;
  /** Server log sink. Default: console.warn. */
  log?: (line: string) => void;
  /**
   * The random stream one grant rolls with. Default `saltedGrantRng`: grantSeed(grantKey, profileKey) mixed with
   * 64 fresh CSPRNG bits per roll (M2 amendment to §6.6 step 5, §7.4 "Predictable loot"). Every other roll input is
   * known to the client (grantKey, profile, tokens, the roll code), so an unsalted stream let a modded client predict
   * its crates and steer them by choosing how many caches to secure. Nothing needs a roll to be reproducible: a
   * queued retry re-applies the grant it already rolled, and a replayed grantKey returns the recorded grant.
   * Tests inject `rolls.grantRng` for the reproducible stream.
   */
  rollRng?: (grantKey: string, profileKey: string) => () => number;
}

/** A failed grant commit is retried on this many housekeeping passes, then the user is told it was lost. */
export const GRANT_RETRY_PASSES = 3;
export const LOOT_NOT_SAVED_MSG = 'Loot could not be saved. Sorry, the server could not reach its profile storage.';
export const PROFILE_OPS_SLOW_MSG = 'Slow down: too many Hangar changes. Try again in a few seconds.';
/** Grants this process committed, remembered by ledger key so a replayed key returns the recorded grant. */
export const COMMITTED_MEMO_MAX = 512;

const isGuestKey = (key: string): boolean => key === '' || key.startsWith('guest:');

/** 32 random bits from the platform CSPRNG (browsers, Node 19+); Math.random only where there is none. */
function randomU32(): number {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const a = new Uint32Array(1);
    c.getRandomValues(a);
    return a[0] >>> 0;
  }
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

/**
 * The default grant stream: Rng(hash32(grantSeed(grantKey, profileKey), r1, r2)) with r1, r2 fresh CSPRNG words.
 * Server-only entropy, so the reveal can be neither predicted nor steered from the client.
 */
export function saltedGrantRng(grantKey: string, profileKey: string): () => number {
  const r = new Rng(hash32(grantSeed(grantKey, profileKey), randomU32(), randomU32()));
  return () => r.next();
}

interface Pending {
  key: string; grant: LootGrant; won: boolean; user: ProfileUser | null; passes: number;
  /** A commit hit ProfileConflict: the retry rebuilds on a FRESH store read, never on the live session copy. */
  stale: boolean;
}
interface Base { profile: Profile; writable: boolean }
/** One grant ready to commit. `profile` = the profile AFTER the grant (rebased in place after a conflict). */
interface Job { key: string; grant: LootGrant; profile: Profile; won: boolean }
/**
 * written: recorded now. recorded: the ledger already had this grantKey (replay, or an earlier attempt landed).
 * readonly: a fresh read after a conflict found a newer-version profile (never written; session only).
 * failed: not written (queue it).
 */
type CommitResult = 'written' | 'recorded' | 'readonly' | 'failed';

const nat = (v: unknown, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.floor(v))) : 0;
const memoKey = (key: string, grantKey: string): string => `${key}\u0000${grantKey}`;

/** Group items into rounds with at most one item per key (same-key grants must build on each other's commit). */
function rounds<T>(items: readonly T[], keyOf: (t: T) => string): T[][] {
  const out: T[][] = [];
  const depth = new Map<string, number>();
  for (const it of items) {
    const k = keyOf(it);
    const d = depth.get(k) ?? 0;
    depth.set(k, d + 1);
    (out[d] ??= []).push(it);
  }
  return out;
}

function emptyGrant(input: GrantInput | undefined): LootGrant {
  return {
    grantKey: typeof input?.grantKey === 'string' ? input.grantKey : '',
    gameType: input?.gameType ?? 'arena',
    items: [], shards: 0, cachesSecured: 0, cachesLost: 0, epicIn: PITY_EPIC, legendaryIn: PITY_LEGENDARY,
  };
}

export class ProfileService {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** The live connection per profile key (the latest attach wins). */
  private readonly byKey = new Map<string, ProfileUser>();
  private queue: Pending[] = [];
  private readonly rollRng: (grantKey: string, profileKey: string) => () => number;
  /** `${key}\0${grantKey}` → the grant this process committed (insertion order = age; COMMITTED_MEMO_MAX kept). */
  private readonly committed = new Map<string, LootGrant>();

  constructor(readonly store: ProfileStore | null, opts: ProfileServiceOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.warn(line));
    this.rollRng = opts.rollRng ?? saltedGrantRng;
  }

  /** Grants waiting for a retry (tests / diagnostics). */
  get queued(): number { return this.queue.length; }

  // -------------------------------------------------------------------------------------------
  // Attach / detach
  // -------------------------------------------------------------------------------------------

  /**
   * key = accountId | 'local' | null (online guest: never gets a profile message). Loads + normalizes, sets the
   * user's profile fields, then sends `{type: 'profile', profile, persisted}`. Call right after `welcome`.
   * Never writes: profile_json stays NULL until the first real change.
   */
  attach(user: ProfileUser, key: string | null): void {
    user.opTimes = [];
    if (key === null || typeof key !== 'string' || isGuestKey(key)) {
      user.profile = null; user.profileKey = null; user.profileWritable = false;
      return;
    }
    const now = this.now();
    let raw: unknown = null;
    let loadOk = true;
    if (this.store) {
      try { raw = this.store.load(key); }
      catch (e) { loadOk = false; this.log(`[profile] load failed for ${key}: ${String(e)}`); }
    }
    const n = normalizeProfile(raw, now);
    user.profileKey = key;
    user.profile = n.profile;
    // A failed read must never be followed by a write (it would clobber the stored profile with a blank one).
    user.profileWritable = n.writable && loadOk;
    this.byKey.set(key, user);
    this.push(user);
  }

  /** The connection closed. (Optional: a later attach for the same key replaces it anyway.) */
  detach(user: ProfileUser): void {
    if (user.profileKey && this.byKey.get(user.profileKey) === user) this.byKey.delete(user.profileKey);
  }

  /** Is this user's profile backed by the store right now? (the `persisted` flag of `profile` messages) */
  persisted(user: ProfileUser): boolean {
    return !!this.store && !!user.profile && user.profileWritable;
  }

  // -------------------------------------------------------------------------------------------
  // equip / seenItems
  // -------------------------------------------------------------------------------------------

  /**
   * Hangar ops (handled by the Zone, never forwarded to a Room): pure op → store.save → push `profile`.
   * Returns true when the equipped LOOK changed: the Zone then calls `user.room?.onProfileChanged(user)`.
   * Guests (profile null) are ignored. Rate limit: PROFILE_OPS_BURST ops per PROFILE_OPS_WINDOW_MS per user.
   */
  handle(user: ProfileUser, msg: ProfileMsg): boolean {
    try {
      if (!user.profile || !msg || typeof msg !== 'object') return false;
      const now = this.now();
      if (msg.type === 'equip') {
        if (!this.allowOp(user, now)) { this.send(user, { type: 'error', message: PROFILE_OPS_SLOW_MSG }); return false; }
        if (typeof msg.itemId !== 'string' || msg.itemId.length > MAX_ID_LEN) {
          this.send(user, { type: 'error', message: 'Unknown item.' });
          return false;
        }
        const r = equip(user.profile, msg.slot, msg.itemId, msg.shipClass);
        if (!r.ok) { this.send(user, { type: 'error', message: r.error }); return false; }
        if (r.profile === user.profile) return false;
        return this.commitChange(user, { ...r.profile, updatedAt: now });
      }
      if (msg.type === 'seenItems') {
        if (!this.allowOp(user, now)) return false; // silent: NEW badges are cosmetic
        if (!Array.isArray(msg.ids)) return false;
        const ids = msg.ids.slice(0, FRESH_MAX).filter(isCosmeticIdLike);
        const next = markSeen(user.profile, ids);
        if (next === user.profile) return false;
        this.commitChange(user, { ...next, updatedAt: now });
        return false;
      }
      return false;
    } catch (e) {
      this.log(`[profile] handle failed for ${user.profileKey}: ${String(e)}`);
      return false;
    }
  }

  private allowOp(user: ProfileUser, now: number): boolean {
    if (!Array.isArray(user.opTimes)) user.opTimes = [];
    const t = user.opTimes;
    while (t.length && now - t[0] > PROFILE_OPS_WINDOW_MS) t.shift();
    if (t.length >= PROFILE_OPS_BURST) return false;
    t.push(now);
    return true;
  }

  /** Adopt `next` in memory, write it through (when writable), push it. Returns true (the change applied). */
  private commitChange(user: ProfileUser, next: Profile): boolean {
    const key = user.profileKey;
    let saved = false;
    if (this.store && user.profileWritable && key) {
      try {
        this.store.save(key, next);
        saved = true;
      } catch (e) {
        if (e instanceof ProfileConflict) {
          // Someone else wrote this profile (single-process assumption broken, or a stale rev): re-read, drop the op.
          this.log(`[profile] save conflict for ${key}; reloading`);
          this.reload(user);
          this.send(user, { type: 'error', message: 'Your profile changed elsewhere. Please try again.' });
          return true;
        }
        this.log(`[profile] save failed for ${key}: ${String(e)}`);
      }
    }
    user.profile = next;
    this.push(user, saved ? undefined : false);
    return true;
  }

  /** Re-read the user's profile from the store (after a conflict or a duplicate grant). */
  private reload(user: ProfileUser): void {
    if (!this.store || !user.profileKey) return;
    try {
      const n = normalizeProfile(this.store.load(user.profileKey), this.now());
      user.profile = n.profile;
      user.profileWritable = n.writable;
    } catch (e) {
      this.log(`[profile] reload failed for ${user.profileKey}: ${String(e)}`);
    }
    this.push(user);
  }

  // -------------------------------------------------------------------------------------------
  // Grants
  // -------------------------------------------------------------------------------------------

  /**
   * Roll + record the match-end (or leave) grants of several humans in ONE commitGrants transaction.
   * Never throws (fix #18): a store failure logs, queues the grants (outcome.queued) and retries them on the next
   * GRANT_RETRY_PASSES retryQueued() passes; after that the user gets LOOT_NOT_SAVED_MSG.
   * - Guests (`guest:*` keys) roll against an empty profile and are never stored (persisted: false).
   * - Each grant rolls with `rollRng(grantKey, profileKey)`: salted with server-only entropy by default (see
   *   ProfileServiceOptions.rollRng). A key the store already recorded comes back { duplicate: true } carrying the
   *   grant this process recorded for it (an empty grant when it was recorded elsewhere), never a re-roll, and
   *   changes nothing: the Room neither sends nor announces it again.
   * - If the one transaction throws, each grant is committed on its own, so one bad key (a ProfileConflict from a
   *   write outside this process, an oversized profile) can't cost the other pilots their loot. A conflicting key
   *   is rebased onto a fresh store read (which also refreshes the store's rev) and committed once more.
   * - On success the live user's profile is replaced and pushed (`profile`); the Room sends `lootGrant` itself.
   * Outcomes are index-aligned with `entries`.
   */
  grantBatch(entries: readonly ProfileGrantEntry[]): GrantOutcome[] {
    const list = Array.isArray(entries) ? entries : [];
    const out: GrantOutcome[] = list.map((e) => ({ grant: emptyGrant(e?.input), persisted: false }));
    const indexed = list.map((e, i) => ({ e, i })).filter(({ e }) => {
      const ok = !!e && typeof e.profileKey === 'string' && !!e.input && typeof e.input.grantKey === 'string' && e.input.grantKey !== '';
      if (!ok) this.log('[profile] grant entry without a profileKey / grantKey skipped');
      return ok;
    });
    for (const round of rounds(indexed, ({ e }) => e.profileKey)) {
      try { this.grantRound(round, out); }
      catch (err) { this.log(`[profile] grant round failed: ${String(err)}`); }
    }
    return out;
  }

  private grantRound(round: readonly { e: ProfileGrantEntry; i: number }[], out: GrantOutcome[]): void {
    const now = this.now();
    const jobs: { job: Job; i: number; e: ProfileGrantEntry }[] = [];
    for (const { e, i } of round) {
      try {
        const key = e.profileKey;
        const guest = isGuestKey(key);
        const base = guest ? { profile: defaultProfile(now), writable: false } : this.baseFor(key, e.user, now);
        const rnd = this.rollRng(e.input.grantKey, key);
        if (!base) {
          // The store could not be read: roll against a blank profile and queue it (the retry re-applies the grant
          // onto a freshly read profile, never onto this blank one).
          const { grant } = rollGrant(defaultProfile(now), e.input, rnd, now);
          this.enqueue(key, grant, !!e.input.won, e.user, false);
          out[i] = { grant, persisted: false, queued: true };
          continue;
        }
        const { grant, profile } = rollGrant(base.profile, e.input, rnd, now);
        if (guest) { out[i] = { grant, persisted: false }; continue; }
        if (this.store && base.writable) {
          jobs.push({ job: { key, grant, profile, won: !!e.input.won }, i, e });
        } else {
          // Session-only (no store) or read-only: keep it in memory for this session.
          this.adopt(key, e.user, profile, false);
          out[i] = { grant, persisted: false };
        }
      } catch (err) {
        this.log(`[profile] grant roll failed for ${e?.profileKey}: ${String(err)}`);
      }
    }
    if (!jobs.length || !this.store) return;

    const res = this.commitJobs(jobs.map((x) => x.job), 'grant');
    for (let k = 0; k < jobs.length; k++) {
      const { job, i, e } = jobs[k];
      switch (res[k]) {
        case 'written':
          this.remember(job);
          this.adopt(job.key, e.user, job.profile, true);
          out[i] = { grant: job.grant, persisted: true };
          break;
        case 'recorded':
          out[i] = { grant: this.replayOf(job, e.user), persisted: true, duplicate: true };
          break;
        case 'readonly':
          this.adoptReadOnly(job.key, e.user, job.profile);
          out[i] = { grant: job.grant, persisted: false };
          break;
        default:
          this.enqueue(job.key, job.grant, job.won, e.user, res[k] === 'conflict');
          out[i] = { grant: job.grant, persisted: false, queued: true };
      }
    }
  }

  /**
   * Retry queued grant commits (call once per Zone housekeeping pass). Each grant is re-applied onto the CURRENT
   * profile (live session, else a fresh store read; always a fresh read after a ProfileConflict), so later equips /
   * grants are never clobbered. Idempotent by grantKey. After GRANT_RETRY_PASSES failed passes the grant is dropped
   * and the user is told.
   */
  retryQueued(): void {
    if (!this.queue.length) return;
    const pending = this.queue;
    this.queue = [];
    if (!this.store) { for (const q of pending) this.giveUp(q); return; }
    for (const round of rounds(pending, (q) => q.key)) {
      try { this.retryRound(round); }
      catch (err) {
        this.log(`[profile] retry round failed: ${String(err)}`);
        for (const q of round) this.failPass(q);
      }
    }
  }

  private retryRound(round: readonly Pending[]): void {
    const now = this.now();
    const jobs: { job: Job; q: Pending }[] = [];
    for (const q of round) {
      const base = this.baseFor(q.key, q.user, now, q.stale);
      if (!base) { this.failPass(q); continue; }
      if (!base.writable) { this.giveUp(q); continue; } // read-only (newer version): never write
      jobs.push({ job: { key: q.key, grant: q.grant, won: q.won, profile: applyGrant(base.profile, q.grant, now, q.won) }, q });
    }
    if (!jobs.length) return;
    const res = this.commitJobs(jobs.map((x) => x.job), 'retry');
    for (let k = 0; k < jobs.length; k++) {
      const { job, q } = jobs[k];
      switch (res[k]) {
        case 'written':
          this.remember(job);
          this.adopt(job.key, q.user, job.profile, true);
          break;
        case 'recorded': { // an earlier attempt landed
          const live = this.liveUser(job.key, q.user);
          if (live) this.reload(live);
          break;
        }
        case 'readonly':
          this.adoptReadOnly(job.key, q.user, job.profile);
          this.giveUp(q);
          break;
        default:
          if (res[k] === 'conflict') q.stale = true;
          this.failPass(q);
      }
    }
  }

  /**
   * Commit `jobs` in one commitGrants transaction. If it throws, fall back to one transaction per job so a single
   * bad key can't sink the rest; a job that hits ProfileConflict is rebased on a fresh read and committed once more.
   * One result per job ('conflict' = still not written after a conflict: the retry builds on a fresh read).
   */
  private commitJobs(jobs: Job[], what: string): (CommitResult | 'conflict')[] {
    const store = this.store as ProfileStore;
    try {
      return this.commitBatch(store, jobs);
    } catch (err) {
      const n = jobs.length;
      this.log(`[profile] commitGrants failed (${what}: ${n} grant${n === 1 ? '' : 's'}${n > 1 ? ', committing one by one' : ''}): ${String(err)}`);
      if (n === 1) return [err instanceof ProfileConflict ? this.rebaseAndCommit(store, jobs[0]) : 'failed'];
      return jobs.map((j) => {
        try { return this.commitBatch(store, [j])[0]; }
        catch (e) {
          if (e instanceof ProfileConflict) return this.rebaseAndCommit(store, j);
          this.log(`[profile] commitGrants failed for ${j.key} (${j.grant.grantKey}): ${String(e)}`);
          return 'failed';
        }
      });
    }
  }

  private commitBatch(store: ProfileStore, jobs: readonly Job[]): CommitResult[] {
    const batch: GrantCommit[] = jobs.map((j) => ({ key: j.key, grantKey: j.grant.grantKey, grant: j.grant, profile: j.profile }));
    const res = store.commitGrants(batch);
    if (!Array.isArray(res) || res.length !== jobs.length) throw new Error('commitGrants returned a bad result');
    return res.map((r) => (r ? 'written' : 'recorded'));
  }

  /**
   * The stored profile changed outside this process (ProfileConflict): re-read it (refreshing the store's rev),
   * re-apply the already-rolled grant and commit once more. `j.profile` becomes the rebased profile.
   */
  private rebaseAndCommit(store: ProfileStore, j: Job): CommitResult | 'conflict' {
    this.log(`[profile] grant ${j.grant.grantKey}: profile ${j.key} changed underneath; rebasing on a fresh read`);
    const now = this.now();
    let n: { profile: Profile; writable: boolean };
    try { n = normalizeProfile(store.load(j.key), now); }
    catch (e) { this.log(`[profile] reload failed for ${j.key}: ${String(e)}`); return 'conflict'; }
    j.profile = applyGrant(n.profile, j.grant, now, j.won);
    if (!n.writable) return 'readonly';
    try { return this.commitBatch(store, [j])[0]; }
    catch (e) { this.log(`[profile] rebased commit failed for ${j.key}: ${String(e)}`); return 'conflict'; }
  }

  private enqueue(key: string, grant: LootGrant, won: boolean, user: ProfileUser | null, stale: boolean): void {
    this.queue.push({ key, grant, won, user, passes: 0, stale });
  }

  private failPass(q: Pending): void {
    q.passes++;
    if (q.passes >= GRANT_RETRY_PASSES) this.giveUp(q);
    else this.queue.push(q);
  }

  private giveUp(q: Pending): void {
    this.log(`[profile] grant ${q.grant.grantKey} for ${q.key} could not be saved; dropped`);
    const live = this.liveUser(q.key, q.user);
    if (live) this.send(live, { type: 'error', message: LOOT_NOT_SAVED_MSG });
  }

  /** Remember a committed grant by ledger key (bounded), so a replay of that key returns exactly it. */
  private remember(j: Job): void {
    const k = memoKey(j.key, j.grant.grantKey);
    this.committed.delete(k);
    this.committed.set(k, j.grant);
    while (this.committed.size > COMMITTED_MEMO_MAX) {
      const oldest = this.committed.keys().next().value;
      if (oldest === undefined) break;
      this.committed.delete(oldest);
    }
  }

  /**
   * What a replayed grantKey stands for: the grant this process recorded, else (recorded by an earlier process) an
   * empty grant with the current pity. Never the fresh re-roll, which the pilot never received. Reloads the live user.
   */
  private replayOf(j: Job, user: ProfileUser | null): LootGrant {
    const live = this.liveUser(j.key, user);
    if (live) this.reload(live);
    const memo = this.committed.get(memoKey(j.key, j.grant.grantKey));
    if (memo) return memo;
    const p = live?.profile;
    const gt: GameType = j.grant.gameType;
    return {
      ...j.grant, items: [], shards: 0, cachesSecured: 0, cachesLost: 0,
      epicIn: PITY_EPIC - nat(p?.pity?.[gt], PITY_EPIC - 1),
      legendaryIn: PITY_LEGENDARY - nat(p?.pityLegendary, PITY_LEGENDARY - 1),
    };
  }

  /**
   * The profile a grant for `key` builds on: the live session's (when writable and not `fresh`), else a fresh store
   * read, else the session copy (read-only / no store). null = the store exists but could not be read (don't write
   * blind). `fresh` = an earlier commit hit ProfileConflict: the live copy is stale, build on the store's.
   */
  private baseFor(key: string, user: ProfileUser | null, now: number, fresh = false): Base | null {
    const live = this.liveUser(key, user);
    if (!fresh && live?.profile && live.profileWritable) return { profile: live.profile, writable: true };
    if (this.store) {
      let n: { profile: Profile; writable: boolean };
      try {
        n = normalizeProfile(this.store.load(key), now);
      } catch (e) {
        this.log(`[profile] load failed for ${key}: ${String(e)}`);
        return null;
      }
      // Read-only (newer version): keep building on the session copy (it has this session's equips).
      return n.writable ? n : { profile: live?.profile ?? n.profile, writable: false };
    }
    return { profile: live?.profile ?? defaultProfile(now), writable: false };
  }

  /** The live connection for `key`: the latest attach, else the entry's own user when it carries that key. */
  private liveUser(key: string, user: ProfileUser | null): ProfileUser | null {
    return this.byKey.get(key) ?? (user && user.profileKey === key ? user : null);
  }

  /** Replace the live user's profile with a committed (or session-only) one and push it. */
  private adopt(key: string, user: ProfileUser | null, profile: Profile, stored: boolean): void {
    const live = this.liveUser(key, user);
    if (!live) return;
    live.profile = profile;
    if (stored) live.profileWritable = true; // a fresh store read succeeded (heals a failed attach)
    this.push(live);
  }

  /** A fresh read found a newer-version profile: session-only from now on (never written). */
  private adoptReadOnly(key: string, user: ProfileUser | null, profile: Profile): void {
    const live = this.liveUser(key, user);
    if (!live) return;
    live.profile = profile;
    live.profileWritable = false;
    this.push(live);
  }

  // -------------------------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------------------------

  private push(user: ProfileUser, persisted?: boolean): void {
    if (!user.profile) return;
    this.send(user, { type: 'profile', profile: user.profile, persisted: persisted ?? this.persisted(user) });
  }

  private send(user: ProfileUser, msg: ServerMsg): void {
    try { user.sink.sendMsg(msg); }
    catch (e) { this.log(`[profile] send failed: ${String(e)}`); }
  }
}
