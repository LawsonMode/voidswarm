// OWNER: SERVER MODERATION. The game server's moderation service: the Node implementation of the Zone's
// ModerationHook (chat log, mutes, strikes → automatic mute, moderator chat commands, /report), ban enforcement
// (ws hello, /api/login, /api/register, live kicks), and the operations the admin HTTP API and the chat commands
// share. State lives in SQLite (./store.ts); bans and moderators are cached in memory and reloaded whenever
// mod_meta.rev changes (the CLI bumps it), so a running server picks up CLI changes within `pollMs`.
//
// Hot-path rule: everything the Zone calls per chat line (logChat, isMuted, onStrike, isAdmin) is in-memory.
// Chat-log writes are batched on timers (never inside a tick); pruning runs in small steps.
import { checkName, parseStrictness, type Strictness } from '../../shared/moderation/filter';
import {
  bannedMessage, formatWhen, mutedMessage,
  type AlertKind, type ModerationHook, type ModUser, type MuteInfo, type OnlinePilot, type ReplyLines, type ReportContext,
  type StrikeReason,
} from '../../shared/room/moderation';
import { nameKey } from '../../shared/room/util';
import { SlidingWindowLimiter } from '../auth/ratelimit';
import { runAdminCommand } from './commands';
import { describeDuration } from './durations';
import {
  ModStore, type ActionRow, type BanKind, type BanRow, type BanScope, type ChatIdent, type ChatLogRow, type ModActionKind,
  type Party, type ReportRow, type ReportStatus,
} from './store';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** What the service needs from the Zone (Zone.onlinePilots / kickPilots / tellPilot). */
export interface ZoneControl {
  onlinePilots(): OnlinePilot[];
  kickPilots(select: (p: OnlinePilot) => boolean, reason: string): number;
  tellPilot(playerId: number, text: string): boolean;
}

/** Who performed a moderation action: a moderator account, the CLI, or the server itself (auto-mute). */
export interface Actor { accountId: string; name: string }
export const SYSTEM_ACTOR: Actor = { accountId: 'system', name: 'system' };
export const CLI_ACTOR: Actor = { accountId: 'cli', name: 'cli' };

export interface ModerationConfig {
  /** Blocked messages within strikeWindowMs that trigger an automatic mute (MOD_STRIKE_LIMIT, default 3). */
  strikeLimit: number;
  /** MOD_STRIKE_WINDOW_MIN, default 10. */
  strikeWindowMs: number;
  /** Automatic mute length (MOD_AUTOMUTE_MIN, default 10). */
  autoMuteSec: number;
  /** Chat-log retention (CHAT_LOG_RETENTION_DAYS, default 90). */
  retentionDays: number;
  /** Reports / moderation actions / ended bans are kept this long (default 365). */
  keepDays: number;
  /** /report: [max, windowMs] per reporter (default 3 per 10 minutes). */
  reportLimit: [number, number];
  /** /report: [max, windowMs] per network address (a classroom shares one; default 30 per 10 minutes). */
  reportAddressLimit: [number, number];
  /** Word-filter strictness for usernames at registration (CHAT_FILTER, default 'strict'; the Zone gets the same). */
  chatFilter: Strictness;
}

function envNum(env: NodeJS.ProcessEnv, k: string, dflt: number, min: number, max: number): number {
  const v = Number(env[k]);
  return Number.isFinite(v) && v >= min && v <= max ? v : dflt;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ModerationConfig {
  return {
    strikeLimit: Math.floor(envNum(env, 'MOD_STRIKE_LIMIT', 3, 1, 100)),
    strikeWindowMs: envNum(env, 'MOD_STRIKE_WINDOW_MIN', 10, 1, 24 * 60) * MIN,
    autoMuteSec: Math.floor(envNum(env, 'MOD_AUTOMUTE_MIN', 10, 1, 7 * 24 * 60) * 60),
    retentionDays: envNum(env, 'CHAT_LOG_RETENTION_DAYS', 90, 1, 3650),
    keepDays: 365,
    reportLimit: [3, 10 * MIN],
    reportAddressLimit: [30, 10 * MIN],
    chatFilter: parseStrictness(env.CHAT_FILTER),
  };
}

export interface ModerationOptions {
  dbPath: string;
  log?: (line: string) => void;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  config?: Partial<ModerationConfig>;
  /** false = no timers (tests call flushStep / poll / pruneNow themselves). Default true. */
  timers?: boolean;
  /** Chat-log flush period (default 1000 ms; a full batch of 50 flushes sooner). */
  flushMs?: number;
  /** How often mod_meta.rev is checked for outside changes (default 2000 ms). */
  pollMs?: number;
  /** Retention prune period (default 1 h). */
  pruneEveryMs?: number;
  /** busy_timeout of the service's DB connection (default 250 ms: the game tick shares this thread). */
  busyTimeoutMs?: number;
  /** Chat rows per insert transaction (default 50). */
  batchRows?: number;
}

/** A player a moderation action is about, resolved from a callsign, username, account id or address. */
export interface Target {
  query: string;
  /** display name (account username, or the callsign) */
  name: string;
  /** matching live connections */
  online: OnlinePilot[];
  accountId: string | null;
  username: string | null;
  address: string | null;
  /** the (first) online pilot, or null when the target is offline */
  playerId: number | null;
}

export type Fail = { ok: false; status: number; error: string; needsConfirm?: boolean; sharing?: number };
export type Result<T> = ({ ok: true } & T) | Fail;
const fail = (status: number, error: string, extra: Partial<Fail> = {}): Fail => ({ ok: false, status, error, ...extra });

export interface BanSpec {
  kind: BanKind;
  target?: Target | null;
  accountId?: string | null;
  address?: string | null;
  scope?: BanScope;
  /** seconds; null = permanent */
  durationSec: number | null;
  reason: string;
  /** required when an address-wide ban / mute also hits other online pilots */
  confirm?: boolean;
  /** tell a muted online target (default true) */
  notify?: boolean;
}

export interface Whois {
  query: string;
  online: (OnlinePilot & { guest: boolean; muted: MuteInfo | null; strikes: number; admin: boolean })[];
  account: { accountId: string; username: string; createdAt: number; lastLogin: number | null; admin: boolean } | null;
  addresses: string[];
  activeBans: BanRow[];
  strikes: number;
  flagged24h: number;
  recentActions: ActionRow[];
}

/** An automatic mute held in memory until the DB accepts it (see ModerationService.provisionalMute). */
interface ProvisionalMute { row: BanRow; playerId: number; target: Target }

/** Identity used for ban matching. */
interface Ident { accountId: string | null; address: string | null; name?: string | null; playerId?: number | null }

const isLive = (b: BanRow, now: number): boolean => b.revokedAt === null && (b.expiresAt === null || b.expiresAt > now);
/** The longer-lasting of two bans (permanent wins). */
const stronger = (a: BanRow | null, b: BanRow): BanRow =>
  !a ? b : a.expiresAt === null ? a : b.expiresAt === null || b.expiresAt > a.expiresAt ? b : a;
/** An IPv4 address or an IPv6 /64 key, as addresses are stored. */
export const looksLikeAddress = (s: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || /^[0-9a-f:]+::\/64$/i.test(s);
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
/** A Target that stands for a network address itself (resolveTarget of "10.0.0.7"), not for one pilot. */
export const isAddressTarget = (t: Target): boolean =>
  !t.accountId && !t.username && !!t.address && t.name === t.address && looksLikeAddress(t.query.trim().toLowerCase());
/** How long a moderator alert about the same pilot and kind is not repeated (withheld lines can come in bursts). */
const ALERT_REPEAT_MS = 60_000;
/** How often an automatic mute that could not be saved (DB busy) is retried. */
const PROVISIONAL_RETRY_MS = 5_000;

export class ModerationService {
  readonly store: ModStore;
  readonly config: ModerationConfig;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly batchRows: number;
  private zone: ZoneControl | null = null;
  private bans: BanRow[] = [];
  private admins = new Set<string>();
  private lastRev = -1;
  /** Strike timestamps per identity key (account, or guest callsign on a network, or connection). */
  private strikes = new Map<string, number[]>();
  /** Guest connections muted directly (a guest mute also follows the connection through a rename). */
  private mutedPids = new Map<number, number>();
  private readonly reportLimiter: SlidingWindowLimiter;
  private readonly reportAddrLimiter: SlidingWindowLimiter;
  /** A moderator's address-wide ban waiting for /confirm. */
  private pending = new Map<string, { at: number; run: () => string[] }>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private flushQueued = false;
  private pruning = false;
  private closed = false;
  private lastWarn = new Map<string, number>();
  private lastSweep = 0;
  /** When each (moderator, read) note was last written (auditRead coalescing). */
  private readNotes = new Map<string, number>();
  /** When each (pilot, alert kind) last reached the moderators (ModerationHook.alert). */
  private lastAlert = new Map<string, number>();
  /**
   * Automatic mutes the DB could not save yet (SQLITE_BUSY while the CLI writes): enforced from memory at once and
   * saved by retryProvisional() on the poll timer. Negative ids; never shown by the store.
   */
  private provisional: ProvisionalMute[] = [];
  private provisionalSeq = 0;
  private lastProvisionalTry = 0;

  constructor(opts: ModerationOptions) {
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.now = opts.now ?? Date.now;
    this.config = { ...configFromEnv(opts.env ?? process.env), ...opts.config };
    this.batchRows = Math.max(1, Math.floor(opts.batchRows ?? 50));
    this.store = new ModStore(opts.dbPath, { log: this.log, busyTimeoutMs: opts.busyTimeoutMs ?? 250, batchRows: this.batchRows });
    this.reportLimiter = new SlidingWindowLimiter(this.config.reportLimit[0], this.config.reportLimit[1], this.now);
    this.reportAddrLimiter = new SlidingWindowLimiter(this.config.reportAddressLimit[0], this.config.reportAddressLimit[1], this.now);
    this.reload();
    if (opts.timers !== false) {
      const every = (ms: number, fn: () => void): void => {
        const t = setInterval(() => { try { fn(); } catch (e) { this.warn('timer', `[mod] timer error: ${(e as Error)?.message ?? e}`); } }, ms);
        t.unref?.();
        this.timers.push(t);
      };
      every(opts.flushMs ?? 1000, () => this.flushStep());
      every(opts.pollMs ?? 2000, () => this.poll());
      every(opts.pruneEveryMs ?? 60 * MIN, () => { void this.pruneNow(); });
      const first = setTimeout(() => { void this.pruneNow(); }, 15_000);
      first.unref?.();
      this.timers.push(first as unknown as ReturnType<typeof setInterval>);
    }
    this.log(`[mod] ready — ${this.admins.size} moderator(s), ${this.bans.length} active ban(s)/mute(s), chat log kept ${this.config.retentionDays} days`);
  }

  /** The Zone this service moderates (for kicks, warnings, the online list). */
  attachZone(zone: ZoneControl): void {
    this.zone = zone;
    this.enforceOnline();
  }

  /** ZoneOptions.moderation for the server's Zone. */
  hook(): ModerationHook {
    return {
      logChat: (e) => {
        this.store.logChat(e);
        if (this.store.pending >= this.batchRows) this.queueFlush();
      },
      isMuted: (u) => this.muteFor(u),
      onStrike: (u, reason) => this.onStrike(u, reason),
      isAdmin: (u) => this.isAdmin(u),
      adminCommand: (u, cmd, args) => runAdminCommand(this, u, cmd, args),
      report: (u, target, reason, ctx) => this.fileReport(u, target, reason, ctx),
      alert: (u, kind) => this.alert(u, kind),
    };
  }

  // ------------------------------------------------------------------------------------------
  // Matching / enforcement
  // ------------------------------------------------------------------------------------------

  /**
   * Does ban / mute `b` apply to this identity? (ignores expiry) Moderator accounts are exempt from address-wide
   * bans / mutes: a teacher who bans a troll's network is usually on that same school network.
   */
  banMatches(b: BanRow, who: Ident): boolean {
    switch (b.scope) {
      case 'account': return !!who.accountId && who.accountId === b.accountId;
      case 'address': return !!who.address && who.address === b.address && !(who.accountId && this.admins.has(who.accountId));
      case 'guest':
        if (who.accountId || !who.address || who.address !== b.address) return false;
        if (!b.username) return true;
        if (who.name && nameKey(who.name) === nameKey(b.username)) return true;
        return who.playerId != null && this.mutedPids.get(who.playerId) === b.id;
    }
    return false;
  }

  /** The strongest live ban (kind 'ban' by default) for this identity, or null. */
  banFor(who: Ident, kind: BanKind = 'ban'): BanRow | null {
    const now = this.now();
    let best: BanRow | null = null;
    for (const b of this.bans) if (b.kind === kind && isLive(b, now) && this.banMatches(b, who)) best = stronger(best, b);
    for (const { row } of this.provisional) if (row.kind === kind && isLive(row, now) && this.banMatches(row, who)) best = stronger(best, row);
    return best;
  }

  /** "You are banned until <date>: <reason>" */
  banMessage(b: BanRow): string {
    return bannedMessage(b.expiresAt, b.reason);
  }

  /** The pilot's live mute, or null (ModerationHook.isMuted). */
  muteFor(u: ModUser): MuteInfo | null {
    const b = this.banFor(u, 'mute');
    return b ? { until: b.expiresAt, reason: b.reason } : null;
  }

  isAdmin(u: { accountId: string | null }): boolean {
    return !!u.accountId && this.admins.has(u.accountId);
  }

  isAdminAccount(accountId: string): boolean {
    return this.admins.has(accountId);
  }

  /** AuthService sign-in guard: a banned account, or an account signing in from a banned network. */
  loginRefused(account: { accountId: string; username: string }, ip: string): boolean {
    const b = this.banFor({ accountId: account.accountId, address: ip, name: account.username });
    if (b) this.log(`[mod] refused sign-in of ${account.username} (ban #${b.id})`);
    return !!b;
  }

  /** AuthService register guard: a network under an address ban, or a username the name filter refuses. */
  registerRefusal(username: string, ip: string): { status: number; message: string } | null {
    const now = this.now();
    for (const b of this.bans) {
      if (b.kind === 'ban' && b.scope === 'address' && b.address === ip && isLive(b, now)) {
        this.log(`[mod] refused account creation from a banned network (ban #${b.id})`);
        return { status: 403, message: "Accounts can't be created from your network right now." };
      }
    }
    let ok = true;
    try { ok = checkName(username, { strictness: this.config.chatFilter }).ok === true; } catch { ok = false; }
    if (!ok) return { status: 400, message: "That username isn't allowed — pick another." };
    return null;
  }

  /** Kick every online pilot a live ban applies to (after a reload: bans made by the CLI). */
  enforceOnline(): number {
    const z = this.zone;
    if (!z) return 0;
    const now = this.now();
    let kicked = 0;
    for (const b of this.bans) {
      if (b.kind !== 'ban' || !isLive(b, now)) continue;
      kicked += z.kickPilots((p) => this.banMatches(b, p), this.banMessage(b));
    }
    if (kicked) this.log(`[mod] disconnected ${kicked} banned pilot(s)`);
    return kicked;
  }

  // ------------------------------------------------------------------------------------------
  // Cache, polling, flushing, pruning
  // ------------------------------------------------------------------------------------------

  /** Reload bans + moderators from the DB. */
  reload(rev?: number): void {
    const r = rev ?? this.store.rev();
    const now = this.now();
    this.bans = this.store.liveBans(now);
    this.admins = this.store.adminIds();
    this.lastRev = r;
    const live = new Set([...this.bans.map((b) => b.id), ...this.provisional.map((p) => p.row.id)]);
    for (const [pid, id] of this.mutedPids) if (!live.has(id)) this.mutedPids.delete(pid);
  }

  /** Pick up changes made elsewhere (the CLI): reload and kick newly banned pilots. Cheap when nothing changed. */
  poll(): void {
    if (this.closed) return;
    let rev: number;
    try { rev = this.store.rev(); } catch (e) { this.warn('poll', `[mod] poll failed: ${(e as Error)?.message ?? e}`); return; }
    const now = this.now();
    if (now - this.lastSweep > MIN) { this.lastSweep = now; this.sweep(now); }
    if (this.provisional.length && now - this.lastProvisionalTry >= PROVISIONAL_RETRY_MS) this.retryProvisional();
    if (rev === this.lastRev) return;
    this.reload(rev);
    this.enforceOnline();
  }

  /** Forget stale strike / confirmation state (bounded memory). */
  private sweep(now: number): void {
    for (const [k, arr] of this.strikes) {
      while (arr.length && now - arr[0]! > this.config.strikeWindowMs) arr.shift();
      if (!arr.length) this.strikes.delete(k);
    }
    for (const [k, p] of this.pending) if (now - p.at > MIN) this.pending.delete(k);
    for (const [k, t] of this.readNotes) if (now - t > MIN) this.readNotes.delete(k);
    for (const [k, t] of this.lastAlert) if (now - t > ALERT_REPEAT_MS) this.lastAlert.delete(k);
    this.reportLimiter.sweep();
    this.reportAddrLimiter.sweep();
  }

  private queueFlush(): void {
    if (this.flushQueued || this.closed) return;
    this.flushQueued = true;
    setImmediate(() => { this.flushQueued = false; this.flushStep(); });
  }

  /** Write one batch of buffered chat lines; more waiting → another batch on the next turn of the event loop. */
  flushStep(): void {
    if (this.closed || !this.store.pending) return;
    try { this.store.flush(); } catch (e) { this.warn('flush', `[mod] chat-log write failed (kept ${this.store.pending} lines in memory): ${(e as Error)?.message ?? e}`); return; }
    if (this.store.pending) this.queueFlush();
  }

  /** Write everything buffered now (before a report snapshot or a log lookup). Never throws. */
  flushAllQuiet(): void {
    try { this.store.flushAll(); } catch (e) { this.warn('flush', `[mod] chat-log write failed: ${(e as Error)?.message ?? e}`); }
  }

  /** Retention prune in small steps (yields between them). Resolves with the rows removed. */
  async pruneNow(chunk = 500): Promise<number> {
    if (this.pruning || this.closed) return 0;
    this.pruning = true;
    let total = 0;
    try {
      const now = this.now();
      const cut = { chatBefore: now - this.config.retentionDays * DAY, keepBefore: now - this.config.keepDays * DAY };
      for (;;) {
        if (this.closed) break;
        const k = this.store.pruneStep(cut, chunk);
        total += k;
        if (k === 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      if (total) this.log(`[mod] pruned ${total} old moderation row(s)`);
    } catch (e) {
      this.warn('prune', `[mod] prune failed: ${(e as Error)?.message ?? e}`);
    } finally {
      this.pruning = false;
    }
    return total;
  }

  private warn(key: string, line: string): void {
    const t = this.now();
    if (t - (this.lastWarn.get(key) ?? -1e12) < MIN) return;
    this.lastWarn.set(key, t);
    this.log(line);
  }

  close(): void {
    if (this.closed) return;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.closed = true;
    try { this.store.close(); } catch (e) { this.log(`[mod] close failed: ${(e as Error)?.message ?? e}`); }
  }

  // ------------------------------------------------------------------------------------------
  // Strikes → automatic mute
  // ------------------------------------------------------------------------------------------

  private strikeKeys(u: ModUser): string[] {
    if (u.accountId) return [`a:${u.accountId}`];
    return [`g:${u.address ?? '?'}:${nameKey(u.name)}`, `p:${u.playerId}`];
  }

  /** Strikes in the window for this pilot. */
  strikeCount(u: ModUser): number {
    const now = this.now();
    let c = 0;
    for (const k of this.strikeKeys(u)) {
      const arr = this.strikes.get(k);
      if (arr) c = Math.max(c, arr.filter((t) => now - t <= this.config.strikeWindowMs).length);
    }
    return c;
  }

  /**
   * ModerationHook.onStrike: count it; at the limit, mute automatically. Returns a private notice or null.
   * 'selfharm' is never counted (nobody is punished for it): online moderators are asked to check in instead.
   * 'threat' counts and alerts online moderators at once.
   */
  onStrike(u: ModUser, reason: StrikeReason): string | null {
    if (reason === 'selfharm') {
      this.notifyAdmins(`${u.name} wrote something that may be about self-harm (not shown to anyone). Please check in with them — /log ${u.name}`);
      this.log(`[mod] possible self-harm statement from ${u.name} (#${u.playerId}) — see the chat log`);
      return null;
    }
    if (reason === 'threat') this.notifyAdmins(`${u.name} wrote something threatening (blocked) — /log ${u.name}`);
    const now = this.now();
    const keys = this.strikeKeys(u);
    let count = 0;
    for (const k of keys) {
      let arr = this.strikes.get(k);
      if (!arr) { arr = []; this.strikes.set(k, arr); }
      while (arr.length && now - arr[0]! > this.config.strikeWindowMs) arr.shift();
      arr.push(now);
      count = Math.max(count, arr.length);
    }
    if (this.muteFor(u)) return null;
    const len = describeDuration(this.config.autoMuteSec);
    if (count >= this.config.strikeLimit) {
      const what = reason === 'name' ? 'offensive names' : 'blocked language';
      const target = this.targetOfUser(u);
      const spec: BanSpec = {
        kind: 'mute', target, durationSec: this.config.autoMuteSec, notify: false, reason: `Automatic: repeated ${what}`,
      };
      // The game thread must never wait on a DB lock (the CLI may hold it): noWait, and on failure the mute is
      // enforced from memory right away and saved on a later poll.
      const res = this.createBan(SYSTEM_ACTOR, spec, { noWait: true });
      if (!res.ok) {
        if (!this.provisionalMute(u, target, spec)) { this.log(`[mod] auto-mute of ${u.name} failed: ${res.error}`); return null; }
        this.log(`[mod] auto-mute of ${u.name} enforced in memory (not saved yet: ${res.error}); retrying`);
      }
      for (const k of keys) this.strikes.delete(k);
      this.notifyAdmins(`Auto-muted ${u.name} for ${len} (${count} strikes: ${what}).`);
      return `You are muted for ${len} (repeated ${what}).`;
    }
    if (count === this.config.strikeLimit - 1) return `Warning: one more and you'll be muted for ${len}.`;
    return null;
  }

  /**
   * An automatic mute the DB refused (busy): enforce it from memory now; retryProvisional() saves it later.
   * False when there is nothing to key it on (a guest with no known address).
   */
  private provisionalMute(u: ModUser, target: Target, spec: BanSpec): boolean {
    if (!u.accountId && !u.address) return false;
    const now = this.now();
    const row: BanRow = {
      id: -(++this.provisionalSeq), kind: 'mute', scope: u.accountId ? 'account' : 'guest',
      accountId: u.accountId, username: u.accountId ? u.username : u.name, address: u.accountId ? null : u.address,
      createdAt: now, expiresAt: spec.durationSec === null ? null : now + spec.durationSec * 1000, revokedAt: null,
      reason: spec.reason, by: SYSTEM_ACTOR.name, active: true,
    };
    this.provisional.push({ row, playerId: u.playerId, target });
    if (!u.accountId) this.mutedPids.set(u.playerId, row.id);
    this.lastProvisionalTry = now;
    return true;
  }

  /** Save the automatic mutes that are only in memory (poll timer). Expired ones are dropped. */
  retryProvisional(): void {
    const now = this.now();
    this.lastProvisionalTry = now;
    const keep: ProvisionalMute[] = [];
    for (const p of this.provisional) {
      if (!isLive(p.row, now)) continue;
      const left = p.row.expiresAt === null ? null : Math.max(1, Math.ceil((p.row.expiresAt - now) / 1000));
      const res = this.createBan(SYSTEM_ACTOR, {
        kind: 'mute', target: p.target, durationSec: left, notify: false, reason: p.row.reason,
      }, { noWait: true, quiet: true });
      if (!res.ok) { keep.push(p); continue; }
      if (this.mutedPids.get(p.playerId) === p.row.id) this.mutedPids.set(p.playerId, res.ban.id);
    }
    this.provisional = keep;
  }

  /** ModerationHook.alert: a withheld line (muted / flood) read as self-harm or a threat. Deduped per pilot. */
  alert(u: ModUser, kind: AlertKind): void {
    const key = `${kind}:${u.accountId ? `a:${u.accountId}` : `p:${u.playerId}`}`;
    const t = this.now();
    const last = this.lastAlert.get(key);
    if (last !== undefined && t - last < ALERT_REPEAT_MS) return;
    this.lastAlert.set(key, t);
    if (kind === 'selfharm') {
      this.notifyAdmins(`${u.name} wrote something that may be about self-harm (not shown to anyone). Please check in with them — /log ${u.name}`);
      this.log(`[mod] possible self-harm statement from ${u.name} (#${u.playerId}, line withheld) — see the chat log`);
    } else {
      this.notifyAdmins(`${u.name} wrote something threatening (not shown to anyone) — /log ${u.name}`);
      this.log(`[mod] threat from ${u.name} (#${u.playerId}, line withheld) — see the chat log`);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Targets
  // ------------------------------------------------------------------------------------------

  online(): OnlinePilot[] {
    return this.zone ? this.zone.onlinePilots() : [];
  }

  private targetOfUser(u: ModUser): Target {
    const online = this.online().filter((p) => p.playerId === u.playerId);
    return {
      query: u.name, name: u.username ?? u.name, online, accountId: u.accountId, username: u.username, address: u.address,
      playerId: u.playerId,
    };
  }

  /**
   * Resolve a player: an online pilot by callsign or account username (case-insensitive, look-alike aware), else an
   * account by username, else the last chat-log line under that callsign (a guest who left), else an address key.
   */
  resolveTarget(query: string): Target | null {
    const q = String(query ?? '').trim().slice(0, 64);
    if (!q) return null;
    const key = nameKey(q);
    const all = this.online();
    const online = all.filter((p) => nameKey(p.name) === key || (!!p.username && nameKey(p.username) === key));
    if (online.length) {
      const p = online[0]!;
      return { query: q, name: p.username ?? p.name, online, accountId: p.accountId, username: p.username, address: p.address, playerId: p.playerId };
    }
    this.flushAllQuiet();
    const acc = this.store.accountByUsername(q);
    if (acc) {
      const last = this.store.recentChat({ accountId: acc.id }, 1)[0];
      return { query: q, name: acc.username, online: [], accountId: acc.id, username: acc.username, address: last?.address ?? null, playerId: null };
    }
    const last = this.store.lastSeenByName(key);
    if (last) {
      const username = last.accountId ? this.store.accountById(last.accountId)?.username ?? null : null;
      return { query: q, name: username ?? last.name, online: [], accountId: last.accountId, username, address: last.address, playerId: null };
    }
    if (looksLikeAddress(q.toLowerCase())) {
      const addr = q.toLowerCase();
      return { query: q, name: addr, online: all.filter((p) => p.address === addr), accountId: null, username: null, address: addr, playerId: null };
    }
    return null;
  }

  /** Target by account id (HTTP API). */
  targetByAccountId(accountId: string): Target | null {
    const acc = this.store.accountById(accountId);
    if (!acc) return null;
    const online = this.online().filter((p) => p.accountId === acc.id);
    const last = online.length ? null : this.store.recentChat({ accountId: acc.id }, 1)[0];
    return {
      query: acc.username, name: acc.username, online, accountId: acc.id, username: acc.username,
      address: online[0]?.address ?? last?.address ?? null, playerId: online[0]?.playerId ?? null,
    };
  }

  /** Target by live connection id (HTTP API). */
  targetByPlayerId(playerId: number): Target | null {
    const p = this.online().find((x) => x.playerId === playerId);
    if (!p) return null;
    return { query: p.name, name: p.username ?? p.name, online: [p], accountId: p.accountId, username: p.username, address: p.address, playerId: p.playerId };
  }

  private identOf(t: Target): ChatIdent {
    return t.accountId ? { accountId: t.accountId } : { nameKey: nameKey(t.online[0]?.name ?? t.name), address: t.address };
  }

  private isSame(p: OnlinePilot, t: Target | null | undefined): boolean {
    if (!t) return false;
    if (t.online.some((o) => o.playerId === p.playerId)) return true;
    return !!t.accountId && p.accountId === t.accountId;
  }

  /** Private line to every online moderator. */
  notifyAdmins(text: string): void {
    const z = this.zone;
    if (!z) return;
    for (const p of z.onlinePilots()) if (this.isAdmin(p)) z.tellPilot(p.playerId, `[mod] ${text}`);
  }

  // ------------------------------------------------------------------------------------------
  // Operations (chat commands + HTTP API)
  // ------------------------------------------------------------------------------------------

  /** Audit one moderation action. */
  audit(actor: Actor, action: ModActionKind, t: { accountId?: string | null; name?: string | null; address?: string | null } | null,
    reason: string, extra: { durationSec?: number | null; expiresAt?: number | null } = {}): void {
    try {
      this.store.addAction({
        ts: this.now(), actorAccountId: actor.accountId, actorName: actor.name, action,
        targetAccountId: t?.accountId ?? null, targetName: t?.name ?? null, targetAddress: t?.address ?? null,
        durationSec: extra.durationSec ?? null, expiresAt: extra.expiresAt ?? null, reason,
      });
    } catch (e) {
      this.warn('audit', `[mod] could not write the audit trail: ${(e as Error)?.message ?? e}`);
    }
  }

  /** Audit a read (HTTP API, chat lookups): an identical note from the same moderator within 60 s is not written twice. */
  auditRead(actor: Actor, reason: string): void {
    const key = `${actor.accountId}\n${reason}`;
    const t = this.now();
    const last = this.readNotes.get(key);
    if (last !== undefined && t - last < MIN) return;
    this.readNotes.set(key, t);
    this.audit(actor, 'note', null, reason);
  }

  /**
   * Ban or mute. Kicks banned online pilots at once; tells a muted online pilot (unless notify: false).
   * A target that is a bare network address ("/mute 10.0.0.7") means that network: scope 'address' unless given.
   * opts.noWait: never wait on a DB lock (game-thread callers); opts.quiet: no log line on a failed save.
   */
  createBan(actor: Actor, spec: BanSpec, opts: { noWait?: boolean; quiet?: boolean } = {}): Result<{ ban: BanRow; kicked: number }> {
    if (spec.target && isAddressTarget(spec.target)) {
      spec = { ...spec, target: null, accountId: null, address: spec.target.address, scope: spec.scope ?? 'address' };
    }
    const t = spec.target ?? null;
    const accountId = t?.accountId ?? spec.accountId ?? null;
    const address = t?.address ?? spec.address ?? null;
    const label = t?.name ?? accountId ?? address ?? '?';
    const reason = clip(String(spec.reason ?? '').trim() || (spec.kind === 'ban' ? 'Banned by a moderator' : 'Muted by a moderator'), 200);
    let scope = spec.scope;
    if (!scope) {
      if (accountId) scope = 'account';
      else if (spec.kind === 'mute' && address && t) scope = 'guest';
      else if (t && !accountId) {
        return fail(400, `${label} is a guest (no account), so there is no account to ban. Kick them, mute them, or ban their network `
          + "(scope 'guest' = every guest there, 'address' = everyone there — a school usually shares one address).");
      } else return fail(400, 'Say who: a target, an account id or an address (with a scope).');
    }
    if (scope === 'account' && !accountId) return fail(400, `${label} has no account — use scope 'guest' or 'address'.`);
    if (scope !== 'account' && !address) return fail(400, `No network address is known for ${label}.`);
    // Guest mute of a named guest: only that callsign (and that connection). Guest ban: every guest on the network.
    const username = scope === 'account' ? (t?.username ?? this.store.accountById(accountId!)?.username ?? null)
      : scope === 'guest' && spec.kind === 'mute' && t ? (t.online[0]?.name ?? t.name) : null;
    if (actor.accountId !== 'system' && actor.accountId !== 'cli' && accountId && accountId === actor.accountId) {
      return fail(400, `You can't ${spec.kind} yourself.`);
    }
    const wide = scope === 'address' || (scope === 'guest' && !username);
    if (wide && !spec.confirm) {
      const others = this.online().filter((p) => p.address === address && !this.isSame(p, t) && !this.isAdmin(p)
        && (scope === 'address' || !p.accountId));
      if (others.length) {
        const who = t ? `${others.length} other pilot${others.length === 1 ? '' : 's'} online share${others.length === 1 ? 's' : ''} that network address`
          : `${others.length} pilot${others.length === 1 ? '' : 's'} online use${others.length === 1 ? 's' : ''} that network address`;
        return fail(409, `${who} (a school or home network shares one) — this ${spec.kind} would hit ${t ? 'them too' : 'all of them'}.`,
          { needsConfirm: true, sharing: others.length });
      }
    }
    const now = this.now();
    const expiresAt = spec.durationSec === null ? null : now + spec.durationSec * 1000;
    let ban: BanRow;
    try {
      ban = this.store.addBan({
        kind: spec.kind, scope, accountId: scope === 'account' ? accountId : null, username,
        address: scope === 'account' ? null : address, createdAt: now, expiresAt, reason, by: actor.name,
      }, now, { noWait: opts.noWait });
    } catch (e) {
      if (!opts.quiet) this.log(`[mod] could not save the ${spec.kind}: ${(e as Error)?.message ?? e}`);
      return fail(503, `Could not save the ${spec.kind} (database busy?) — try again.`);
    }
    this.audit(actor, spec.kind, { accountId, name: label, address }, reason, { durationSec: spec.durationSec, expiresAt });
    try { this.reload(); } catch { this.bans.push(ban); }
    if (spec.kind === 'mute' && scope === 'guest' && username && t?.playerId != null) this.mutedPids.set(t.playerId, ban.id);
    let kicked = 0;
    const z = this.zone;
    if (z && spec.kind === 'ban') kicked = z.kickPilots((p) => this.banMatches(ban, p), this.banMessage(ban));
    if (z && spec.kind === 'mute' && spec.notify !== false) {
      for (const p of z.onlinePilots()) if (this.banMatches(ban, p)) z.tellPilot(p.playerId, mutedMessage({ until: expiresAt, reason }));
    }
    this.log(`[mod] ${actor.name}: ${spec.kind} ${label} [${scope}] ${describeDuration(spec.durationSec)} — ${reason}${kicked ? ` (${kicked} disconnected)` : ''}`);
    return { ok: true, ban, kicked };
  }

  /** Lift bans / mutes: one by id, or every live one of `kind` that applies to the target. */
  revoke(actor: Actor, spec: { id: number } | { target: Target; kind: BanKind }): Result<{ revoked: number; bans: BanRow[] }> {
    const now = this.now();
    let list: BanRow[];
    if ('id' in spec) {
      const b = this.store.getBan(spec.id, now);
      if (!b) return fail(404, 'No such ban.');
      list = b.active ? [b] : [];
    } else {
      const t = spec.target;
      const key = nameKey(t.online[0]?.name ?? t.name);
      list = this.store.liveBans(now).filter((b) => {
        if (b.kind !== spec.kind) return false;
        if (t.accountId && b.accountId === t.accountId) return true;
        if (b.scope !== 'account' && t.address && b.address === t.address) {
          if (b.scope === 'address' || !b.username) return true;
          return !t.accountId && nameKey(b.username) === key;
        }
        return b.scope !== 'account' && !!b.username && nameKey(b.username) === key && !t.address;
      });
    }
    const done: BanRow[] = [];
    for (const b of list) {
      try {
        if (this.store.revokeBan(b.id, now)) done.push(b);
      } catch (e) {
        this.log(`[mod] could not revoke #${b.id}: ${(e as Error)?.message ?? e}`);
        return fail(503, 'Could not save the change (database busy?) — try again.');
      }
    }
    for (const b of done) {
      this.audit(actor, b.kind === 'ban' ? 'unban' : 'unmute', { accountId: b.accountId, name: b.username ?? b.address, address: b.address }, `lifted #${b.id}`);
    }
    if (done.length) {
      try { this.reload(); } catch { /* next poll */ }
      const z = this.zone;
      if (z) {
        for (const b of done) {
          if (b.kind !== 'mute') continue;
          for (const p of z.onlinePilots()) if (this.banMatches(b, p) && !this.muteFor(p)) z.tellPilot(p.playerId, 'You can chat again.');
        }
      }
      this.log(`[mod] ${actor.name}: lifted ${done.map((b) => `#${b.id}`).join(', ')}`);
    }
    return { ok: true, revoked: done.length, bans: done };
  }

  /** Disconnect a target's live connections (they may reconnect). */
  kick(actor: Actor, t: Target, reason: string): Result<{ kicked: number }> {
    const z = this.zone;
    if (!z || !t.online.length) return fail(404, `${t.name} is not online.`);
    const why = clip(String(reason ?? '').trim() || 'No reason given', 200);
    const ids = new Set(t.online.map((p) => p.playerId));
    const kicked = z.kickPilots((p) => ids.has(p.playerId), `Kicked by a moderator: ${why}`);
    this.audit(actor, 'kick', { accountId: t.accountId, name: t.name, address: t.address }, why);
    this.log(`[mod] ${actor.name}: kick ${t.name} — ${why}`);
    return { ok: true, kicked };
  }

  /** A private warning line to the target. */
  warnPilot(actor: Actor, t: Target, reason: string): Result<{ warned: number }> {
    const z = this.zone;
    const why = clip(String(reason ?? '').trim(), 200);
    if (!why) return fail(400, 'Say what the warning is.');
    if (!z || !t.online.length) return fail(404, `${t.name} is not online.`);
    let warned = 0;
    for (const p of t.online) if (z.tellPilot(p.playerId, `Warning from a moderator: ${why}`)) warned++;
    this.audit(actor, 'warn', { accountId: t.accountId, name: t.name, address: t.address }, why);
    return { ok: true, warned };
  }

  /** A target's last `n` chat lines (oldest first). */
  chatOf(t: Target, n: number): ChatLogRow[] {
    this.flushAllQuiet();
    return this.store.recentChat(this.identOf(t), n);
  }

  /** Online-list row for the API / whois. */
  describePilot(p: OnlinePilot): Whois['online'][number] {
    const u: ModUser = p;
    return { ...p, guest: !p.accountId, muted: this.muteFor(u), strikes: this.strikeCount(u), admin: this.isAdmin(p) };
  }

  whois(t: Target): Whois {
    this.flushAllQuiet();
    const now = this.now();
    const acc = t.accountId ? this.store.accountById(t.accountId) : null;
    const ident = this.identOf(t);
    const who: Ident = { accountId: t.accountId, address: t.address, name: t.online[0]?.name ?? t.name, playerId: t.playerId };
    const activeBans = this.store.liveBans(now).filter((b) => this.banMatches(b, who) || (!!t.accountId && b.accountId === t.accountId));
    const strikes = t.online.length ? Math.max(...t.online.map((p) => this.strikeCount(p)))
      : t.accountId ? this.strikeCount({ playerId: -1, name: t.name, accountId: t.accountId, username: t.username, address: t.address }) : 0;
    return {
      query: t.query,
      online: t.online.map((p) => this.describePilot(p)),
      account: acc ? { accountId: acc.id, username: acc.username, createdAt: acc.createdAt, lastLogin: acc.lastLogin, admin: this.isAdminAccount(acc.id) } : null,
      addresses: [...new Set([...(t.address ? [t.address] : []), ...this.store.addressesOf(ident)])].slice(0, 10),
      activeBans,
      strikes,
      flagged24h: this.store.flaggedCount(ident, now - DAY),
      recentActions: this.store.listActions({ limit: 20, targetAccountId: t.accountId, targetName: t.accountId ? null : t.name, targetAddress: t.accountId ? null : t.address }).actions,
    };
  }

  /** ModerationHook.report: `/report <target> <reason>` (rate limited per reporter and per network). */
  fileReport(reporter: ModUser, targetQuery: string, reason: string, ctx: ReportContext): ReplyLines {
    const rk = reporter.accountId ? `a:${reporter.accountId}` : `g:${reporter.address ?? '?'}:${nameKey(reporter.name)}`;
    if (this.reportLimiter.blockedFor(rk) > 0 || (reporter.address && this.reportAddrLimiter.blockedFor(reporter.address) > 0)) {
      return ["You've sent several reports recently — a moderator will look at them. Please wait a few minutes."];
    }
    const t = this.resolveTarget(targetQuery);
    if (!t || (!t.online.length && looksLikeAddress(t.query.toLowerCase()))) {
      return [`No pilot called "${clip(targetQuery, 20)}" — check the spelling on the scoreboard.`];
    }
    if (t.online.some((p) => p.playerId === reporter.playerId) || (!!reporter.accountId && t.accountId === reporter.accountId)) {
      return ["You can't report yourself."];
    }
    this.reportLimiter.record(rk);
    if (reporter.address) this.reportAddrLimiter.record(reporter.address);
    let row: ReportRow;
    try {
      const recentChat = this.chatOf(t, 20);
      row = this.store.addReport({
        ts: this.now(), reason: clip(reason.trim(), 200), room: ctx.roomName, recentChat,
        reporter: { playerId: reporter.playerId, name: reporter.name, accountId: reporter.accountId, address: reporter.address },
        target: { playerId: t.playerId, name: t.online[0]?.name ?? t.name, accountId: t.accountId, address: t.address },
      });
    } catch (e) {
      this.log(`[mod] could not save a report: ${(e as Error)?.message ?? e}`);
      return ["Couldn't send the report right now — please try again in a moment."];
    }
    this.log(`[mod] report #${row.id}: ${reporter.name} → ${row.target.name} (${ctx.roomName}): ${row.reason}`);
    this.notifyAdmins(`New report #${row.id}: ${reporter.name} reported ${row.target.name} — ${row.reason} (/reports)`);
    return ['Report sent — thank you.'];
  }

  listReports(status: ReportStatus | 'all', limit: number, before?: number): { reports: ReportRow[]; nextBefore: number | null } {
    return this.store.listReports({ status, limit, before });
  }

  reviewReport(actor: Actor, id: number, status: ReportStatus, note?: string | null): Result<{ report: ReportRow }> {
    const r = this.store.reviewReport(id, status, actor.name, this.now(), note ?? null);
    if (!r) return fail(404, 'No such report.');
    this.audit(actor, 'note', { accountId: r.target.accountId, name: r.target.name, address: r.target.address }, `report #${id} ${status}${note ? `: ${note}` : ''}`);
    return { ok: true, report: r };
  }

  /** Remember an action that needs /confirm (per moderator, 60 s). */
  setPending(accountId: string, run: () => string[]): void {
    this.pending.set(accountId, { at: this.now(), run });
  }

  /** Run (and forget) a moderator's pending action; null = none (or expired). */
  takePending(accountId: string): (() => string[]) | null {
    const p = this.pending.get(accountId);
    this.pending.delete(accountId);
    if (!p || this.now() - p.at > MIN) return null;
    return p.run;
  }

  /** "until Sep 28, 2026, 2:05 PM" / "permanently" */
  untilText(expiresAt: number | null): string {
    return expiresAt === null ? 'permanently' : `until ${formatWhen(expiresAt)}`;
  }

  /** Party of an online pilot (reports). */
  static partyOf(p: ModUser): Party {
    return { playerId: p.playerId, name: p.name, accountId: p.accountId, address: p.address };
  }
}
