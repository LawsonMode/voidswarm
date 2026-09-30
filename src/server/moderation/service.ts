// OWNER: SERVER MODERATION. The game server's moderation service: the Node implementation of the Zone's
// ModerationHook (chat log, mutes, strikes → automatic mute, moderator chat commands, /report), ban enforcement
// (ws hello, /api/login, /api/register, live kicks), and the operations the admin HTTP API and the chat commands
// share. State lives in SQLite (./store.ts); bans and moderators are cached in memory and reloaded whenever
// mod_meta.rev changes (the CLI bumps it), so a running server picks up CLI changes within `pollMs`.
//
// Hot-path rule: everything the Zone calls per chat line (logChat, isMuted, onStrike, strikeStatus, isAdmin, alert)
// is in-memory. Chat-log writes are batched (never inside a tick); heavy reads and writes run in the maintenance
// worker (attachMaint), never here.
//
// v0.6 LAN edition (docs/LAN-EDITION-proposal.md; task B8b):
//  - Live chat (§5.4): every logged line (announcements too) also goes into an in-memory ring of 5,000 lines with a
//    sequence number (LiveFeed; numbered from the start time, so a cursor from before a restart gets `gap`).
//    `chat/live` long-polls it: all waiters are woken together per setImmediate, at most 4 waits per session (429
//    beyond), an abort frees the waiter, and a line never carries its original text or hit labels. SELF-HARM lines are
//    the nameless "Wellbeing alert" line (moderators get none). No DB work.
//  - Tag policy (§5.8): a strike counts only for tags whose policy says `strike`; the auto-mute comes at the strike
//    limit (all counted tags) or at a tag's own `autoMuteAfter`, whichever is first; strikeStatus tells the Zone
//    where the pilot stands so its generic warning escalates. SELF-HARM is never a strike.
//  - Alerts (§5.2, §5.3, §5.11): a SELF-HARM line raises a nameless wellbeing alert for the host only (never an
//    in-game line to a moderator, never a log line); a THREAT raises an alert for the host and, in game, a name-only
//    line for `trusted` moderators; other tags raise one when their `notify` is banner / urgent. A SELF-HARM line
//    raises no named alert at all: a THREAT, HATE, … in it goes into its wellbeing alert (a tag chip, maybe urgent).
//    Urgent alerts can trigger the content-free alert email (setUrgentAlertSink). Unacknowledged wellbeing lines come
//    back as alerts after a restart (the worker's 'wellbeing.pending'); an acknowledgement is refused unless every
//    line of the alert is stored in wellbeing_acks (the lines are found in the worker by time: 'chat.locate').
//  - Exports (§5.5 ★): the worker streams the rows in pages of 1,000 through the one shared CSV writer (./csv.ts),
//    to a download or to data\exports\ (deleted after 7 days); audited with filter and row count.
//  - Manual purge (§5.5 ★): 409 with the row count first; then the worker's recorded, chunked purge.
//  - Retention (§5.5): days, term (nothing before the end date; at end + 14 days the term's lines go after a backup;
//    no next date within another 14 days → the 90-day fallback, with a banner; the next term's date set before that
//    purge leaves it owed, persisted, so it still happens: termPurgeOwed) or forever; records retention; the
//    nightly run also clears acknowledged wellbeing text after 30 days and minimises addresses (School). All in the
//    worker (maint/writes.ts); without one the old game-thread pruner runs in small steps.
//  - Report copies are shown-only (§6.4): the saved lines carry no original text, address or hit labels.
// The admin endpoints these back are moderationAdminHandlers() (AdminHttpOptions.handlers).
import * as fs from 'node:fs';
import path from 'node:path';
import { teamName } from '../../shared/data/teams';
import { checkName, parseStrictness, type Strictness } from '../../shared/moderation/filter';
import {
  bannedMessage, enforcedTagsOf, formatWhen, mutedMessage, TAG_SELF_HARM, TAG_THREAT, tagsOf,
  type AlertKind, type ChatDisplay, type ChatLogEntry, type ModerationHook, type ModUser, type MuteInfo, type OnlinePilot, type ReplyLines,
  type ReportContext, type StrikeDetail, type StrikeReason, type StrikeStatus,
} from '../../shared/room/moderation';
import { nameKey } from '../../shared/room/util';
import { HttpError } from '../auth/http';
import { SlidingWindowLimiter } from '../auth/ratelimit';
import type { CallOptions, MaintStream } from '../maint/client';
import { isWellbeingRow, type ContextResult, type LogPage, type LogRoom, type LogStats } from '../maint/queries';
import { isAddressTag, LOCATE_MAX, TERM_OWED_MAX, type LineMatch, type TermOwed } from '../maint/writes';
import type { ModerationPolicy, ModerationSettingsConfig, RetentionPolicy } from '../settings/bindings';
import { DEFAULT_TAG_DEFAULT, defaultTagPolicies, TERM_GRACE_DAYS, type TagPolicy } from '../settings/schema';
import { can } from './capabilities';
import { runAdminCommand } from './commands';
import { chatLogColumns, EXPORT_CONTENT_TYPES, exportFileName, exportWriter, type ExportFormat } from './csv';
import { describeDuration, parseSince, stamp } from './durations';
import type { AdminReply, AdminRouteContext, AdminRouteHandler, Banner } from './http';
import {
  CHAT_ACTIONS, ModStore, type ActionRow, type BanKind, type BanRow, type BanScope, type ChatIdent, type ChatLogRow, type LogQuery, type ModActionKind,
  type ModStoreOptions, type Party, type ReportRow, type ReportStatus,
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

/**
 * The audit kinds of v0.6 beside the store's ModActionKind (§6.6: mod_actions.action has no CHECK constraint).
 * ModStore.addAction stores any of them; its ModActionKind type is the older list (handoff: widen it there).
 */
export type AuditKind = ModActionKind | 'export' | 'purge' | 'wellbeing-ack' | 'settings' | 'view' | 'reveal' | (string & {});

export interface ModerationConfig {
  /** Blocked messages within strikeWindowMs that trigger an automatic mute (MOD_STRIKE_LIMIT, default 3). */
  strikeLimit: number;
  /** MOD_STRIKE_WINDOW_MIN, default 10. */
  strikeWindowMs: number;
  /** Automatic mute length (MOD_AUTOMUTE_MIN, default 10). */
  autoMuteSec: number;
  /** Chat-log retention (CHAT_LOG_RETENTION_DAYS, default 90). setPolicy's retention mode wins when it is set. */
  retentionDays: number;
  /** Reports / moderation actions / ended bans / conduct counters are kept this long (default 365). */
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

/**
 * The maintenance worker as this service uses it (maint/client.ts MaintClient has this shape). Panel reads,
 * exports, purges and retention run there.
 */
export interface MaintAccess {
  call<R = unknown>(op: string, args?: unknown, opts?: CallOptions): Promise<R>;
  stream<T = unknown>(op: string, args?: unknown, opts?: { signal?: AbortSignal }): MaintStream<T>;
}

/** What attachMaint takes (startServer: the MaintService's worker client and hooks). */
export interface MaintHooks {
  /** the worker client (null: no worker; exports and purges then answer 503, retention runs here in small steps) */
  client: MaintAccess | null;
  /** an encrypted backup before a term purge (MaintService.backupNow('pre-purge', { actor })) */
  backup?: (reason: 'pre-purge', actor: string) => Promise<{ ok: boolean; error?: string } | { ok: false; skipped?: string; text?: string }>;
  /** purges / clears left FTS index entries behind (MaintService.noteIndexDirty) */
  indexDirty?: () => void;
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
  /** How often the retention schedule is looked at (default 10 min; the run itself is nightly, after 02:00). */
  pruneEveryMs?: number;
  /** busy_timeout of the service's DB connection (default 250 ms: the game tick shares this thread). */
  busyTimeoutMs?: number;
  /** Chat rows per insert transaction (default 50). */
  batchRows?: number;
  /**
   * More ModStore options (with the maintenance worker checkpointing: GAME_THREAD_STORE_OPTIONS — walAutoCheckpoint 0,
   * txRows 1, flushBudgetMs 3).
   */
  storeOptions?: Partial<ModStoreOptions>;
  /** Where "Save on this PC" exports go (default: `exports` beside the database, i.e. data\exports). */
  exportsDir?: string;
  /** Live ring size (default LIVE_RING_SIZE). */
  liveRingSize?: number;
  /** The Live ring's first seq is this + 1 (default: the start time in ms, so a restart's cursors never collide; tests pass 0). */
  liveSeqBase?: number;
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

export type Fail = { ok: false; status: number; error: string; needsConfirm?: boolean; sharing?: number; code?: string; rows?: number; before?: number; note?: string };
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
/**
 * A network address a ban or mute can match, from a chat-log row or a caller: null for a minimised guest address
 * (`tag:xxxx`, maint/writes.ts address minimisation), which no connection ever has.
 */
const banAddress = (a: string | null | undefined): string | null => (typeof a === 'string' && a && !isAddressTag(a) ? a : null);
/** A Target that stands for a network address itself (resolveTarget of "10.0.0.7"), not for one pilot. */
export const isAddressTarget = (t: Target): boolean =>
  !t.accountId && !t.username && !!t.address && t.name === t.address && looksLikeAddress(t.query.trim().toLowerCase());
/** How long a moderator alert about the same pilot and kind is not repeated (withheld lines can come in bursts). */
const ALERT_REPEAT_MS = 60_000;
/** How often an automatic mute that could not be saved (DB busy) is retried. */
const PROVISIONAL_RETRY_MS = 5_000;
const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

// ------------------------------------------------------------------------------------------
// Live chat (§5.4): the ring and its long-poll
// ------------------------------------------------------------------------------------------

/** Lines the Live ring keeps (about 2 MB). */
export const LIVE_RING_SIZE = 5000;
/** chat/live `wait`: at most this long (ms). */
export const LIVE_MAX_WAIT_MS = 25_000;
/** Long-polls waiting at once per admin session (the 5th gets 429). */
export const LIVE_MAX_WAITS = 4;
export const LIVE_DEFAULT_LIMIT = 100;
export const LIVE_MAX_LIMIT = 500;
/** §5.4: what a SELF-HARM line shows in Live until it is opened (★ wellbeing/open). */
export const WELLBEING_LINE_TEXT = 'Wellbeing alert — needs your attention';

/** One Live line (§5.15 LiveLine). Never the original text or hit labels. */
export interface LiveLine {
  seq: number;
  ts: number;
  roomUid: string | null;
  roomName: string;
  /** "Flag Run · Crimson (team chat)", "Zone lobby", "All rooms (announcement)" */
  label: string;
  channel: string;
  team: number;
  playerId: number;
  name: string;
  accountId: string | null;
  /** the admin API turns it into `addressTag` for a principal without `addresses` */
  address: string | null;
  /** what the others saw (a substituted line: the positive line, never the student's words) */
  shown: string;
  action: string;
  display: ChatDisplay;
  tags: string[];
  /** true → name, account, address and shown are blank until wellbeing/open ★ */
  wellbeing: boolean;
  online: boolean;
  /** the chat_log id once the line is written (null until then, and while ModStore can't say) */
  chatId: number | null;
  /** the alert this line raised (wellbeing / threat / tag), if any */
  alertId: number | null;
}

/** A ring line: the LiveLine fields plus the room id, the sender's name key and account (kept even for a nameless line, never shown). */
interface LiveItem extends Omit<LiveLine, 'online'> { roomId: string | null; key: string; owner: string | null }

export interface LiveQuery {
  /** lines after this seq (the previous answer's `next`); absent = the newest `limit` lines, no wait */
  after?: number;
  limit?: number;
  roomUid?: string;
  tag?: string;
  flaggedOnly?: boolean;
  /** a log channel, or 'lobby' */
  channel?: string;
  /** a callsign or username (name key); never matches a nameless wellbeing line */
  player?: string;
  /** host principals: SELF-HARM lines as the nameless line; false (moderators): none at all */
  includeWellbeing?: boolean;
}

/** `next`: pass it back as `after`. `gap`: lines after `after` were skipped (the ring moved on, or more than `limit`). */
export interface LivePage { lines: LiveLine[]; next: number; gap: boolean }

interface LiveWaiter { check(): void; finish(): void }

/** "Flag Run · Crimson (team chat)" / "Zone lobby" / "All rooms (announcement)". */
export function liveLabel(e: Pick<ChatLogEntry, 'roomId' | 'roomName' | 'channel' | 'team'>): string {
  if (e.channel === 'announce') return e.roomId ? `${e.roomName} (announcement)` : 'All rooms (announcement)';
  const base = e.roomId === null ? 'Zone lobby' : e.roomName || 'Room';
  const team = Number.isInteger(e.team) && e.team >= 0 ? teamName(e.team) : null;
  switch (e.channel) {
    case 'team': return `${base} · ${team ?? 'Team'} (team chat)`;
    case 'name': return `${base} (callsign)`;
    case 'room': return `${base} (room name)`;
    default: return team ? `${base} · ${team}` : base;
  }
}

/** Is this logged line a wellbeing (SELF-HARM) line? (withheld, or any SELF-HARM hit, review-only included) */
const isWellbeingEntry = (e: Pick<ChatLogEntry, 'display' | 'hits'>): boolean => e.display === 'withheld' || tagsOf(e.hits).includes(TAG_SELF_HARM);

/**
 * The Live ring (§5.4): the last `size` logged lines with sequence numbers, and the long-poll waiters. In memory on
 * the game thread; no DB work. A line keeps no original text and no hit labels; a wellbeing line keeps no name.
 *
 * Sequence numbers start after `base` (the service passes the start time in ms), so every run of the server numbers
 * its lines above the last run's (a run logs far fewer lines than it lasts milliseconds): a panel's cursor from before
 * a restart is below this run's oldest line, and it gets `gap` and the lines from the oldest one. A cursor above the
 * head (the clock went back) is a restart too.
 */
export class LiveFeed {
  private readonly buf: (LiveItem | undefined)[];
  private head: number;
  private readonly base: number;
  private readonly waiters = new Set<LiveWaiter>();
  private readonly perKey = new Map<string, number>();
  private wakeQueued = false;
  private closed = false;

  constructor(readonly size = LIVE_RING_SIZE, private readonly onlineIds: () => ReadonlySet<number> = () => new Set(), base = Date.now()) {
    this.size = Math.max(1, Math.floor(size));
    this.buf = new Array<LiveItem | undefined>(this.size);
    this.base = Number.isFinite(base) && base >= 0 ? Math.floor(base) : 0;
    this.head = this.base;
  }

  /** The newest seq (`base` = nothing yet). */
  get seq(): number { return this.head; }
  /** The oldest seq still in the ring. */
  get oldest(): number { return Math.max(this.base + 1, this.head - this.size + 1); }
  /** Long-polls waiting now. */
  get waiting(): number { return this.waiters.size; }

  /** Add one logged line; wakes the waiters (together, on the next turn of the event loop). */
  push(e: ChatLogEntry): LiveItem {
    const seq = ++this.head;
    const tags = tagsOf(e.hits);
    const wellbeing = isWellbeingEntry(e);
    const item: LiveItem = {
      seq, ts: Math.floor(e.time), roomId: e.roomId ?? null, roomUid: typeof e.roomUid === 'string' ? e.roomUid : null,
      roomName: String(e.roomName ?? ''), label: liveLabel(e), channel: String(e.channel), team: Math.floor(e.team) || 0,
      playerId: wellbeing ? 0 : Math.floor(e.playerId) || 0, name: wellbeing ? '' : String(e.name ?? ''),
      accountId: wellbeing ? null : e.accountId ?? null, address: wellbeing ? null : e.address ?? null,
      shown: wellbeing ? '' : String(e.shown ?? ''), action: String(e.action), display: e.display ?? 'as-typed',
      tags: wellbeing && !tags.includes(TAG_SELF_HARM) ? [...tags, TAG_SELF_HARM] : tags, wellbeing,
      chatId: null, alertId: null, key: wellbeing ? '' : nameKey(String(e.name ?? '')), owner: e.accountId ?? null,
    };
    this.buf[seq % this.size] = item;
    if (this.waiters.size && !this.wakeQueued) {
      this.wakeQueued = true;
      setImmediate(() => {
        this.wakeQueued = false;
        for (const w of [...this.waiters]) w.check();
      });
    }
    return item;
  }

  private at(seq: number): LiveItem | undefined {
    const it = this.buf[seq % this.size];
    return it && it.seq === seq ? it : undefined;
  }

  /** Forget ring lines (a purge removed them from the log). Returns how many. */
  remove(pred: (it: Readonly<LiveItem>) => boolean): number {
    let n = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const it = this.buf[i];
      if (it && pred(it)) { this.buf[i] = undefined; n++; }
    }
    return n;
  }

  /** The lines matching `q` after `q.after`, without waiting. */
  page(q: LiveQuery): LivePage {
    const head = this.head;
    const oldest = this.oldest;
    const limit = Math.max(1, Math.min(LIVE_MAX_LIMIT, Math.floor(Number.isFinite(q.limit) ? q.limit! : LIVE_DEFAULT_LIMIT)));
    const after = q.after !== undefined && Number.isInteger(q.after) && q.after >= 0 ? q.after : null;
    // A cursor above the head (an earlier run, the clock set back): a gap, then the newest lines.
    const restarted = after !== null && after > head;
    const fresh = after === null || restarted;
    // Lines between the cursor and the oldest line still in the ring were overwritten, or the cursor is from an earlier
    // run (below this run's `base`): a gap.
    let gap = restarted || (after !== null && !fresh && after + 1 < oldest);
    const start = after === null || fresh ? oldest : Math.max(after + 1, oldest);
    const pk = q.player ? nameKey(q.player) : null;
    const tag = q.tag ? q.tag.toUpperCase() : null;
    const hits: LiveItem[] = [];
    for (let s = start; s <= head; s++) {
      const it = this.at(s);
      if (!it) continue;
      if (it.wellbeing && !q.includeWellbeing) continue;
      if (q.roomUid && it.roomUid !== q.roomUid && !(it.channel === 'announce' && it.roomUid === null)) continue;
      if (tag && !it.tags.includes(tag)) continue;
      if (q.flaggedOnly && it.action === 'pass') continue;
      if (q.channel) {
        if (q.channel === 'lobby') { if (it.roomId !== null || it.channel !== 'all') continue; }
        else if (it.channel !== q.channel) continue;
      }
      if (pk !== null && (it.wellbeing || it.key !== pk)) continue;
      hits.push(it);
    }
    let items = hits;
    if (hits.length > limit) {
      items = hits.slice(hits.length - limit);
      if (!fresh) gap = true;
    }
    const online = items.length ? this.onlineIds() : new Set<number>();
    return { lines: items.map((it) => liveLineOf(it, online)), next: head, gap };
  }

  /**
   * The long-poll: lines now, or wait up to `waitMs` for the first matching one (or a gap). 'busy' = this key already
   * has LIVE_MAX_WAITS waits open. The signal (the client went away) frees the waiter at once.
   */
  async wait(q: LiveQuery, o: { waitMs: number; key: string; signal?: AbortSignal }): Promise<LivePage | 'busy'> {
    const now = this.page(q);
    if (now.lines.length || now.gap || !(o.waitMs > 0) || q.after === undefined || this.closed || o.signal?.aborted) return now;
    const n = this.perKey.get(o.key) ?? 0;
    if (n >= LIVE_MAX_WAITS) return 'busy';
    this.perKey.set(o.key, n + 1);
    return new Promise<LivePage>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (page?: LivePage): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
        this.waiters.delete(w);
        const left = (this.perKey.get(o.key) ?? 1) - 1;
        if (left > 0) this.perKey.set(o.key, left); else this.perKey.delete(o.key);
        resolve(page ?? this.page(q));
      };
      const onAbort = (): void => finish();
      const w: LiveWaiter = {
        check: () => {
          const p = this.page(q);
          if (p.lines.length || p.gap) finish(p);
        },
        finish: () => finish(),
      };
      timer = setTimeout(() => finish(), Math.min(LIVE_MAX_WAIT_MS, o.waitMs));
      timer.unref?.();
      o.signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(w);
    });
  }

  /** Give the waiters their (empty) answers and stop waiting (shutdown). */
  close(): void {
    this.closed = true;
    for (const w of [...this.waiters]) w.finish();
  }

  /** The ring item of a seq (tests). */
  item(seq: number): Readonly<LiveItem> | undefined { return this.at(seq); }
}

function liveLineOf(it: LiveItem, online: ReadonlySet<number>): LiveLine {
  return {
    seq: it.seq, ts: it.ts, roomUid: it.roomUid, roomName: it.roomName, label: it.label, channel: it.channel, team: it.team,
    playerId: it.playerId, name: it.name, accountId: it.accountId, address: it.address, shown: it.shown, action: it.action,
    display: it.display, tags: [...it.tags], wellbeing: it.wellbeing, online: !it.wellbeing && online.has(it.playerId),
    chatId: it.chatId, alertId: it.alertId,
  };
}

// ------------------------------------------------------------------------------------------
// Alerts (§5.2, §5.3, §5.11)
// ------------------------------------------------------------------------------------------

export type ModAlertKind = 'wellbeing' | 'threat' | 'tag';
export type AlertLevel = 'banner' | 'urgent';
/** The in-memory alerts kept (the oldest acknowledged ones go first). */
export const MAX_ALERTS = 500;
/** At most one content-free alert email this often (§4.7). */
export const URGENT_MAIL_EVERY_MS = 10 * MIN;

/**
 * One line an alert stands for: its chat id once known, and how to find it until then (never its text). `match` null
 * with `chatId` null: the line is not in the log (dropped or purged), so nothing of it can come back after a restart.
 */
interface AlertLine { chatId: number | null; match: { ts: number; playerId: number; channel: string; ident: ChatIdent } | null }

interface ModAlert {
  id: number;
  kind: ModAlertKind;
  tag: string;
  level: AlertLevel;
  at: number;
  lastAt: number;
  /** lines folded into this alert (the same pilot and tag within a minute) */
  count: number;
  /** the line's time */
  lineTs: number;
  roomName: string;
  roomUid: string | null;
  channel: string;
  playerId: number | null;
  name: string;
  accountId: string | null;
  senderKey: string;
  /** the lines folded into it (the first one's chat id is the alert's chatId) */
  lines: AlertLine[];
  /**
   * A wellbeing alert: the other alerting tags of its lines (THREAT, HATE, …). A line that is a SELF-HARM line raises
   * no named alert of its own (§5.2 "no in-game alert names the student"; T-WB-1): its other tags come here.
   */
  alsoTags: string[];
  acked: boolean;
  ackedAt: number | null;
  ackedBy: string | null;
  note: string | null;
}

/**
 * An alert as alerts/list returns it. A wellbeing alert never names the student (§5.3 "shows no name until you open
 * it"): id, when, where, and the line's chat id for wellbeing/open ★.
 */
export type AlertView = Record<string, unknown> & { id: number; kind: ModAlertKind; level: AlertLevel };

function alertView(a: ModAlert): AlertView {
  const base = {
    id: a.id, kind: a.kind, level: a.level, at: a.at, lastAt: a.lastAt, count: a.count, roomName: a.roomName, roomUid: a.roomUid,
    channel: a.channel, chatId: a.lines[0]?.chatId ?? null, acked: a.acked, ackedAt: a.ackedAt,
  };
  // (a wellbeing alert's other tags are chips, like its Live line's: never a name, the words or a second alert)
  if (a.kind === 'wellbeing') return { ...base, wellbeing: true, tags: [TAG_SELF_HARM, ...a.alsoTags], text: 'A wellbeing alert needs your attention' };
  return { ...base, tag: a.tag, tags: [a.tag], playerId: a.playerId, name: a.name, accountId: a.accountId, ackedBy: a.ackedBy, note: a.note };
}

// ------------------------------------------------------------------------------------------
// Retention (§5.5): days, term, forever; the fallback
// ------------------------------------------------------------------------------------------

/** The nightly retention run starts at the first look after this local hour. */
export const RETENTION_HOUR = 2;
/** The first retention run after a start (ms). */
export const RETENTION_FIRST_MS = 60_000;
/** The banner before a term ends (days). */
export const TERM_BANNER_DAYS = 7;
export const ADDRESS_MINIMISE_DAYS = 7;
export const WELLBEING_CLEAR_DAYS = 30;
export const DEVICE_CHECK_DAYS = 7;
/** Rows per step of the game-thread pruner (no worker: at most 100, see store.ts PRUNE_CHUNK). */
export const FALLBACK_PRUNE_CHUNK = 100;

export type RetentionPhase = 'days' | 'forever' | 'term-before' | 'term-ending' | 'term-grace' | 'term-purge' | 'term-fallback';

export interface RetentionPlan {
  phase: RetentionPhase;
  /** lines with ts < chatBefore go on this run; null = no chat purge now */
  chatBefore: number | null;
  /** the cut includes the term's (it needs an encrypted backup first) */
  backupFirst: boolean;
  /** term: local midnight after the end date ("lines older than the end date"); null otherwise */
  termCut: number | null;
  /** term: when its lines go (termCut + grace) */
  purgeAt: number | null;
  /** term: when the `days` fallback starts if no next end date was set (purgeAt + grace) */
  fallbackAt: number | null;
  banner: Banner | null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Local midnight `plusDays` after the date "YYYY-MM-DD" (DST-safe: calendar days). null for a bad date. */
function localDay(date: string, plusDays: number): number | null {
  const m = ISO_DATE.exec(date);
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  const day = new Date(y, mo - 1, d, 0, 0, 0, 0);
  if (day.getFullYear() !== y || day.getMonth() !== mo - 1 || day.getDate() !== d) return null; // 2026-02-30, 2026-13-45
  const t = new Date(y, mo - 1, d + plusDays, 0, 0, 0, 0).getTime();
  return Number.isFinite(t) ? t : null;
}
const dayText = (t: number): string => {
  try { return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return new Date(t).toISOString().slice(0, 10); }
};

/**
 * The retention rule at `now` (§5.5):
 *  - days: lines older than `days` go;
 *  - forever: nothing goes automatically;
 *  - term (end date E, grace G = 14 days): nothing before the end date (a banner from 7 days before); after it,
 *    nothing for G more days (a banner: export first, set the next date); at E + G the lines older than E go, after
 *    an encrypted backup; if no next end date was set by E + 2G, the `days` rule (90 by default) applies too, with a
 *    banner. A term with no (or a bad) end date keeps `days`.
 */
export function retentionPlan(p: RetentionPolicy, now: number): RetentionPlan {
  const days = Math.max(1, Math.floor(Number.isFinite(p.days) ? p.days : 90));
  const daysCut = now - days * DAY;
  const none = { termCut: null, purgeAt: null, fallbackAt: null, banner: null, backupFirst: false };
  if (p.mode === 'forever') return { ...none, phase: 'forever', chatBefore: null };
  if (p.mode !== 'term' || !p.termEnd) return { ...none, phase: 'days', chatBefore: daysCut };
  const grace = Math.max(0, Math.floor(Number.isFinite(p.graceDays) ? p.graceDays : TERM_GRACE_DAYS));
  const cut = localDay(p.termEnd, 1);
  const purgeAt = localDay(p.termEnd, 1 + grace);
  const fallbackAt = localDay(p.termEnd, 1 + 2 * grace);
  const bannerFrom = localDay(p.termEnd, 1 - TERM_BANNER_DAYS);
  if (cut === null || purgeAt === null || fallbackAt === null || bannerFrom === null) return { ...none, phase: 'days', chatBefore: daysCut };
  const t = { termCut: cut, purgeAt, fallbackAt };
  const end = dayText(localDay(p.termEnd, 0)!);
  if (now < bannerFrom) return { ...t, phase: 'term-before', chatBefore: null, backupFirst: false, banner: null };
  if (now < cut) {
    return {
      ...t, phase: 'term-ending', chatBefore: null, backupFirst: false,
      banner: { code: 'term-ending', level: 'info', text: `The term ends on ${end}. Its chat is deleted on ${dayText(purgeAt)}, after a backup: export it first if the district keeps it, and set the next term's end date in Settings → Chat.` },
    };
  }
  if (now < purgeAt) {
    return {
      ...t, phase: 'term-grace', chatBefore: null, backupFirst: false,
      banner: { code: 'term-ended', level: 'warn', text: `The term ended on ${end}. Its chat is deleted on ${dayText(purgeAt)}, after a backup: export it first if the district keeps it, and set the next term's end date in Settings → Chat.` },
    };
  }
  if (now < fallbackAt) {
    return {
      ...t, phase: 'term-purge', chatBefore: cut, backupFirst: true,
      banner: { code: 'term-next', level: 'warn', text: `Set the next term's end date in Settings → Chat. Without one, chat is kept ${days} days from ${dayText(fallbackAt)}.` },
    };
  }
  return {
    ...t, phase: 'term-fallback', chatBefore: Math.max(cut, daysCut), backupFirst: true,
    banner: { code: 'term-fallback', level: 'warn', text: `No next term end date was set, so chat is now kept ${days} days. Set the term's end date in Settings → Chat.` },
  };
}

/**
 * The term purge still owed when the retention rule changes from `prev` to `next` at `now` (§5.5; T-ADM-9): the
 * banners ask the host to set the NEXT term's end date from 7 days before the end until the purge, and doing so must
 * not cancel the ending term's purge. So when a term's end date is replaced from its banner window on (term-ending,
 * term-grace, term-purge, term-fallback) by a date on or after that term's purge day (the next term), or cleared, the
 * old term's cut stays owed: its lines still go at its purgeAt, after the backup. A new date before the purge day
 * corrects this term's date (its own plan purges within the grace); a change to `days` or `forever` is the host's new
 * rule and owes nothing. null = nothing owed.
 */
export function termPurgeOwed(prev: RetentionPolicy | null | undefined, next: RetentionPolicy, now: number): TermOwed | null {
  if (!prev || prev.mode !== 'term' || next.mode !== 'term' || !prev.termEnd || prev.termEnd === next.termEnd) return null;
  const old = retentionPlan(prev, now);
  if (old.termCut === null || old.purgeAt === null || old.phase === 'term-before' || old.phase === 'days') return null;
  const nextCut = next.termEnd ? localDay(next.termEnd, 1) : null;
  if (nextCut !== null && nextCut < old.purgeAt) return null;
  return { cut: old.termCut, purgeAt: old.purgeAt };
}

/** Add an owed term purge to a list (one per cut; the newest TERM_OWED_MAX kept). */
function withOwed(list: readonly TermOwed[], p: TermOwed): TermOwed[] {
  const out = list.filter((x) => x.cut !== p.cut);
  out.push({ cut: p.cut, purgeAt: Math.min(p.purgeAt, list.find((x) => x.cut === p.cut)?.purgeAt ?? p.purgeAt) });
  return out.sort((a, b) => a.cut - b.cut).slice(-TERM_OWED_MAX);
}

/** "The term ended on Dec 18, 2026" for an owed cut (the local midnight after the end date). */
const owedEndText = (cut: number): string => dayText(cut - 12 * 3_600_000);

/** The next nightly run: RETENTION_HOUR local time, strictly after `now`. */
export function nextRetentionAt(now: number): number {
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), RETENTION_HOUR, 0, 0, 0).getTime();
  return today > now ? today : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, RETENTION_HOUR, 0, 0, 0).getTime();
}

/** One retention run's result. */
export interface RetentionRun {
  at: number;
  phase: RetentionPhase;
  /** where the run happened: the worker, or this thread (no worker) */
  where: 'worker' | 'thread';
  chat: number;
  records: number;
  addresses: number;
  wellbeing: number;
  /** why the chat purge was skipped (the term backup failed, …) */
  skipped: string | null;
}

// ------------------------------------------------------------------------------------------
// Exports and purges (§5.5 ★)
// ------------------------------------------------------------------------------------------

/** A download stops past this many lines (then: Save on this PC). §5.5 recommends saving above 200,000. */
export const DOWNLOAD_MAX_ROWS = 500_000;
/** Exports saved on the PC are deleted after this many days (§6.4). */
export const EXPORTS_KEEP_DAYS = 7;
/** The worker streams the export in pages of this many rows. */
export const EXPORT_PAGE_ROWS = 1000;
/** What the purge dialog says (§5.5). */
export const PURGE_NOTE = 'Backups keep these lines until they age out (at most 35 days). The search index finishes tidying at the next restart or overnight.';
const EXPORT_FILE_RE = /^voidswarm-[a-z0-9-]+-\d{4}-\d{2}-\d{2}_\d{6}(?:-\d+)?\.(?:csv|json)$/;
/** Save on this PC: names tried in one second (name, name-2, …) before the export fails. */
const EXPORT_NAME_TRIES = 50;

export interface ChatExportRequest {
  /** the worker's log.export filter (LogQuery fields: player, accountId, address, q, channel, roomUid, tag, since, …) */
  filter: Record<string, unknown>;
  format?: ExportFormat;
  /** the "what they typed" column ("include unfiltered text"; a principal with `reveal`) */
  includeOriginal?: boolean;
  /** SELF-HARM lines too ("include wellbeing lines"; a principal with `wellbeing`) */
  includeWellbeing?: boolean;
  /** a text search matches the original text too (a principal with `reveal`); default the shown text only */
  searchOriginal?: boolean;
  /** write data\exports\<file> instead of a download */
  saveOnHost?: boolean;
  actor: Actor;
  signal?: AbortSignal;
  /** downloads stop past this many rows (default DOWNLOAD_MAX_ROWS) */
  maxRows?: number;
}

export type ChatExportResult =
  | { ok: true; saved: false; body: Buffer; fileName: string; contentType: string; rows: number }
  | { ok: true; saved: true; savedTo: string; fileName: string; rows: number }
  | Fail;

export type PurgeResult =
  | { ok: true; deleted: number; conductRows: number; reportCopies: number; before: number; note: string }
  | Fail;

/** The filter of an export or a purge, for the audit row (never the whole text of a search). */
function filterDesc(f: Record<string, unknown>): string {
  const keys = ['player', 'accountId', 'address', 'q', 'grep', 'channel', 'roomUid', 'roomId', 'action', 'display', 'tag', 'since', 'until'];
  const parts = keys.filter((k) => f[k] !== undefined && f[k] !== null && f[k] !== '').map((k) => `${k}=${String(f[k]).slice(0, 40)}`);
  if (Array.isArray(f.ranges)) parts.push(`ranges=${f.ranges.length}`);
  return parts.length ? parts.join(' ') : 'everything';
}

/** 'host:<name>' for the deletion ledger's `by` (an admin principal, never a student's name). */
const ledgerBy = (a: Actor): string => `${a.accountId || 'host'}:${a.name || a.accountId || 'host'}`.slice(0, 64);

// ------------------------------------------------------------------------------------------
// The service
// ------------------------------------------------------------------------------------------

/** The tag policy defaults (§5.8, A1) when no settings are bound. */
const BUILTIN_TAG_POLICY: Readonly<Record<string, TagPolicy>> = Object.freeze(defaultTagPolicies());

/** One strike, with the tags it counted for ([] = an untagged strike: an older Zone, or a line with no tag). */
interface StrikeMark { t: number; tags: string[] }

/** Where a pilot stands against the strike limit and the tags' autoMuteAfter (the one closest to a mute). */
interface Standing { count: number; limit: number; mute: boolean }

export class ModerationService {
  readonly store: ModStore;
  readonly config: ModerationConfig;
  /** The Live ring (§5.4). */
  readonly live: LiveFeed;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly batchRows: number;
  private readonly exportsDir: string;
  private zone: ZoneControl | null = null;
  private policy: ModerationPolicy | null = null;
  private maint: MaintHooks | null = null;
  private bans: BanRow[] = [];
  private admins = new Set<string>();
  private lastRev = -1;
  /** Strikes per identity key (account, or guest callsign on a network, or connection). */
  private strikes = new Map<string, StrikeMark[]>();
  /** The standing right after the last onStrike (strikeStatus reads it). */
  private lastStrike: { playerId: number; status: StrikeStatus } | null = null;
  /** Guest connections muted directly (a guest mute also follows the connection through a rename). */
  private mutedPids = new Map<number, number>();
  private readonly reportLimiter: SlidingWindowLimiter;
  private readonly reportAddrLimiter: SlidingWindowLimiter;
  /** A moderator's address-wide ban waiting for /confirm. */
  private pending = new Map<string, { at: number; run: () => string[] }>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private flushQueued = false;
  private closed = false;
  private lastWarn = new Map<string, number>();
  private lastSweep = 0;
  private lastFlushErrorAt: number | null = null;
  /** When each (moderator, read) note was last written (auditRead coalescing). */
  private readNotes = new Map<string, number>();
  /** When each (pilot, alert kind) last reached the moderators in game. */
  private lastAlert = new Map<string, number>();
  private alertList: ModAlert[] = [];
  private alertSeq = 0;
  /** The ring item and the alerts of a logged entry (until the store has written it). */
  private readonly ringItems = new WeakMap<ChatLogEntry, LiveItem>();
  private readonly entryLines = new WeakMap<ChatLogEntry, AlertLine[]>();
  /** The wellbeing alert of a logged SELF-HARM line (its other tags fold into it; never a second, named alert). */
  private readonly wellbeingOf = new WeakMap<ChatLogEntry, ModAlert>();
  private urgentSink: (() => void) | null = null;
  private lastUrgentMail = -Infinity;
  /** The next retention run, the one running, the term cuts already backed up. */
  private nextRetention: number;
  private retentionRunning: Promise<RetentionRun> | null = null;
  private lastRetention: RetentionRun | null = null;
  private retentionProblem: Banner | null = null;
  private readonly termBackups = new Set<number>();
  /** Term purges still owed after the host set the next term's date early (termPurgeOwed; persisted by the worker). */
  private termOwed: TermOwed[] = [];
  /** attachMaint's loads (the wellbeing alerts and the owed term purges of earlier runs). */
  private maintLoads: Promise<void> = Promise.resolve();
  private readonly timersOn: boolean;
  /** The one-shot run a minute after a start or a retention change. */
  private retentionSoon: ReturnType<typeof setTimeout> | null = null;
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
    // `onWritten` (the chat_log id of each written entry, for Live reveals and alerts) is used when ModStore offers it
    // (a handoff to store.ts); until then alerts find their line's id with a point query.
    const storeOpts: ModStoreOptions & { onWritten?: (e: ChatLogEntry, id: number) => void } = {
      log: this.log, busyTimeoutMs: opts.busyTimeoutMs ?? 250, batchRows: this.batchRows, ...opts.storeOptions,
      onWritten: (e, id) => this.noteWritten(e, id),
    };
    this.store = new ModStore(opts.dbPath, storeOpts);
    this.exportsDir = opts.exportsDir ?? path.join(path.dirname(path.resolve(opts.dbPath)), 'exports');
    this.live = new LiveFeed(opts.liveRingSize ?? LIVE_RING_SIZE, () => new Set(this.online().map((p) => p.playerId)), opts.liveSeqBase ?? this.now());
    this.reportLimiter = new SlidingWindowLimiter(this.config.reportLimit[0], this.config.reportLimit[1], this.now);
    this.reportAddrLimiter = new SlidingWindowLimiter(this.config.reportAddressLimit[0], this.config.reportAddressLimit[1], this.now);
    this.nextRetention = this.now() + RETENTION_FIRST_MS;
    this.timersOn = opts.timers !== false;
    this.reload();
    if (this.timersOn) {
      const every = (ms: number, fn: () => void): void => {
        const t = setInterval(() => { try { fn(); } catch (e) { this.warn('timer', `[mod] timer error: ${errMsg(e)}`); } }, ms);
        t.unref?.();
        this.timers.push(t);
      };
      every(opts.flushMs ?? 1000, () => this.flushStep());
      every(opts.pollMs ?? 2000, () => this.poll());
      every(opts.pruneEveryMs ?? 10 * MIN, () => { if (this.now() >= this.nextRetention) void this.runRetention(); });
      this.retentionChanged(); // the first run, a minute after the start
    }
    this.log(`[mod] ready — ${this.admins.size} moderator(s), ${this.bans.length} active ban(s)/mute(s), chat log kept ${this.config.retentionDays} days`);
  }

  /** The Zone this service moderates (for kicks, warnings, the online list). */
  attachZone(zone: ZoneControl): void {
    this.zone = zone;
    this.enforceOnline();
  }

  /**
   * The maintenance worker and its hooks (startServer: the MaintService's client, backupNow('pre-purge'),
   * noteIndexDirty). Exports, purges, log stats and the retention run use it; the unacknowledged wellbeing lines of
   * earlier runs come back as alerts.
   */
  attachMaint(h: MaintHooks | null): void {
    this.maint = h;
    if (h?.client) {
      const loads = Promise.all([this.loadPendingWellbeing(), this.loadTermOwed()]).then(() => undefined, () => undefined);
      this.maintLoads = loads;
    }
  }

  /** Resolves when attachMaint's loads are done (the wellbeing alerts and owed term purges of earlier runs). */
  maintReady(): Promise<void> {
    return this.maintLoads;
  }

  /** The maintenance worker (null: none attached, or it is gone). The panel's reads run there. */
  get worker(): MaintAccess | null {
    return this.maint?.client ?? null;
  }

  /** The content-free alert email (§4.7 `alerts.email`): called for urgent alerts, at most every 10 minutes. */
  setUrgentAlertSink(fn: (() => void) | null): void {
    this.urgentSink = fn;
  }

  /**
   * Live settings (settings/bindings.ts moderationConfigOf): strikes, retention days, records days, the filter
   * strictness. Bad values are ignored.
   */
  setConfig(c: Partial<ModerationSettingsConfig>): void {
    const num = (v: unknown, min: number, max: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined);
    const before = { r: this.config.retentionDays, k: this.config.keepDays };
    const set = <K extends keyof ModerationConfig>(k: K, v: ModerationConfig[K] | undefined): void => { if (v !== undefined) this.config[k] = v; };
    set('strikeLimit', num(c.strikeLimit, 1, 100) === undefined ? undefined : Math.floor(c.strikeLimit!));
    set('strikeWindowMs', num(c.strikeWindowMs, MIN, DAY));
    set('autoMuteSec', num(c.autoMuteSec, 1, 7 * 86400) === undefined ? undefined : Math.floor(c.autoMuteSec!));
    set('retentionDays', num(c.retentionDays, 1, 3650));
    set('keepDays', num(c.keepDays, 1, 3650));
    if (c.chatFilter === 'strict' || c.chatFilter === 'standard') this.config.chatFilter = c.chatFilter;
    if (before.r !== this.config.retentionDays || before.k !== this.config.keepDays) this.retentionChanged();
  }

  /** The v0.6 policy (settings/bindings.ts moderationPolicyOf): per-tag policy, retention mode, address minimisation, tier. */
  setPolicy(p: ModerationPolicy): void {
    const old = this.policy;
    const prev = old ? JSON.stringify([old.retention, old.addressMinimisation]) : null;
    this.policy = structuredClone(p);
    if (prev === JSON.stringify([p.retention, p.addressMinimisation])) return;
    // The next term's end date set before the ending term was purged: that purge is still owed (termPurgeOwed).
    // Switching to `days` or `forever` is a new rule: nothing is owed any more.
    const now = this.now();
    if (p.retention.mode !== 'term') {
      if (this.termOwed.length) this.saveTermOwed([]);
    } else {
      const owed = old ? termPurgeOwed(old.retention, p.retention, now) : null;
      if (owed) this.saveTermOwed(withOwed(this.termOwed, owed));
    }
    this.retentionChanged();
  }

  /** A retention change applies within a minute (a one-shot run), not the next night. */
  private retentionChanged(): void {
    this.nextRetention = Math.min(this.nextRetention, this.now() + RETENTION_FIRST_MS);
    if (!this.timersOn || this.closed) return;
    if (this.retentionSoon) clearTimeout(this.retentionSoon);
    this.retentionSoon = setTimeout(() => { this.retentionSoon = null; void this.runRetention(); }, RETENTION_FIRST_MS);
    this.retentionSoon.unref?.();
  }

  /** The owed term purges now (retentionInfo shows them). */
  get owedTermPurges(): readonly TermOwed[] { return this.termOwed.slice(); }

  /** Keep the owed term purges, in memory now and in the database through the worker (mod_meta; best effort). */
  private saveTermOwed(list: TermOwed[]): void {
    this.termOwed = list.slice().sort((a, b) => a.cut - b.cut);
    const client = this.maint?.client;
    if (!client) return;
    // after the load (which merges the stored list with this one), so the stored list is never overwritten unread
    this.maintLoads = this.maintLoads.then(async () => {
      try { await client.call('retention.term.set', { owed: this.termOwed }, { timeoutMs: 30_000 }); } catch (e) {
        this.warn('term-owed', `[mod] the owed term purge could not be saved (it is kept in memory): ${errMsg(e)}`);
      }
    });
  }

  /** The owed term purges of earlier runs (the worker's 'retention.term.get'), merged with any noted since the start. */
  private async loadTermOwed(): Promise<void> {
    const client = this.maint?.client;
    if (!client) return;
    let stored: TermOwed[];
    try {
      stored = (await client.call<{ owed: TermOwed[] }>('retention.term.get', {}, { timeoutMs: 30_000 })).owed ?? [];
    } catch (e) {
      this.warn('term-owed', `[mod] the owed term purges could not be read: ${errMsg(e)}`);
      return;
    }
    const mine = this.termOwed;
    let merged = stored.slice();
    for (const p of mine) merged = withOwed(merged, p);
    // a policy that is not `term` any more owes nothing
    if (this.policy && this.policy.retention.mode !== 'term') merged = [];
    const same = JSON.stringify(merged) === JSON.stringify([...stored].sort((a, b) => a.cut - b.cut));
    this.termOwed = merged;
    if (!same) {
      try { await client.call('retention.term.set', { owed: merged }, { timeoutMs: 30_000 }); } catch (e) {
        this.warn('term-owed', `[mod] the owed term purge could not be saved (it is kept in memory): ${errMsg(e)}`);
      }
    }
  }

  /**
   * The moderator tier (§5.2): the settings' `moderators.tier` once they are bound (setPolicy; `limited` by default,
   * fixed in School). A service with no settings bound (the pre-0.6 server) keeps the v0.5 moderator view, `trusted`.
   * SELF-HARM never reaches a moderator in either tier.
   */
  get moderatorTier(): 'limited' | 'trusted' {
    if (!this.policy) return 'trusted';
    return this.policy.tier === 'trusted' ? 'trusted' : 'limited';
  }

  /** The policy of one tag (§5.8): the settings' row, else the built-in default, else "Other custom labels". */
  tagPolicy(tag: string): TagPolicy {
    const t = String(tag).toUpperCase();
    const own = (this.policy?.tags ?? BUILTIN_TAG_POLICY)[t] ?? BUILTIN_TAG_POLICY[t] ?? this.policy?.tagDefault ?? DEFAULT_TAG_DEFAULT;
    // SELF-HARM is never an offence, and its alert can't be switched off.
    if (t === TAG_SELF_HARM) return { strike: false, autoMuteAfter: null, notify: own.notify === 'urgent' ? 'urgent' : 'banner', dailySummary: own.dailySummary };
    return own;
  }

  /** ZoneOptions.moderation for the server's Zone. */
  hook(): ModerationHook {
    return {
      logChat: (e) => this.logChat(e),
      isMuted: (u) => this.muteFor(u),
      onStrike: (u, reason, detail) => this.onStrike(u, reason, detail),
      strikeStatus: (u) => this.strikeStatus(u),
      isAdmin: (u) => this.isAdmin(u),
      adminCommand: (u, cmd, args) => runAdminCommand(this, u, cmd, args),
      report: (u, target, reason, ctx) => this.fileReport(u, target, reason, ctx),
      alert: (u, kind, entry) => this.alert(u, kind, entry),
    };
  }

  /** ModerationHook.logChat: the Live ring, the chat-log buffer, and the tag alerts. In memory only. */
  logChat(e: ChatLogEntry): void {
    if (this.closed) return;
    try { this.ringItems.set(e, this.live.push(e)); } catch (err) { this.warn('live', `[mod] live feed error: ${errMsg(err)}`); }
    this.store.logChat(e);
    if (this.store.pending >= this.batchRows) this.queueFlush();
    try { this.raiseTagAlerts(e); } catch (err) { this.warn('alert', `[mod] alert error: ${errMsg(err)}`); }
  }

  /** ModStore wrote `e` as chat_log row `id` (when the store reports it). */
  private noteWritten(e: ChatLogEntry, id: number): void {
    const item = this.ringItems.get(e);
    if (item) item.chatId = id;
    for (const l of this.entryLines.get(e) ?? []) { l.chatId = id; l.match = null; }
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
  // Cache, polling, flushing
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
    try { rev = this.store.rev(); } catch (e) { this.warn('poll', `[mod] poll failed: ${errMsg(e)}`); return; }
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
      while (arr.length && now - arr[0]!.t > this.config.strikeWindowMs) arr.shift();
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
    try { this.store.flush(); } catch (e) {
      this.lastFlushErrorAt = this.now();
      this.warn('flush', `[mod] chat-log write failed (kept ${this.store.pending} lines in memory): ${errMsg(e)}`);
      return;
    }
    if (this.store.pending) this.queueFlush();
  }

  /** Write everything buffered now (before a report snapshot or a log lookup). Never throws. */
  flushAllQuiet(): void {
    try { this.store.flushAll(); } catch (e) { this.lastFlushErrorAt = this.now(); this.warn('flush', `[mod] chat-log write failed: ${errMsg(e)}`); }
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
    if (this.retentionSoon) { clearTimeout(this.retentionSoon); this.retentionSoon = null; }
    this.live.close();
    this.closed = true;
    try { this.store.close(); } catch (e) { this.log(`[mod] close failed: ${errMsg(e)}`); }
  }

  // ------------------------------------------------------------------------------------------
  // Strikes → automatic mute (§5.8 per-tag policy)
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
      if (arr) c = Math.max(c, arr.filter((m) => now - m.t <= this.config.strikeWindowMs).length);
    }
    return c;
  }

  /**
   * Where the pilot stands: of the strike limit (every counted strike) and each tag's autoMuteAfter (the strikes of
   * that tag), the one closest to a mute. `mute` = one of them is reached.
   */
  private standing(u: ModUser): Standing {
    const now = this.now();
    let best: Standing & { rem: number } = { count: 0, limit: this.config.strikeLimit, mute: false, rem: this.config.strikeLimit };
    for (const k of this.strikeKeys(u)) {
      const marks = (this.strikes.get(k) ?? []).filter((m) => now - m.t <= this.config.strikeWindowMs);
      const consider = (count: number, limit: number): void => {
        const rem = limit - count;
        if (rem < best.rem) best = { count, limit, mute: rem <= 0, rem };
      };
      consider(marks.length, this.config.strikeLimit);
      const perTag = new Map<string, number>();
      for (const m of marks) for (const t of m.tags) perTag.set(t, (perTag.get(t) ?? 0) + 1);
      for (const [t, n] of perTag) {
        const a = this.tagPolicy(t).autoMuteAfter;
        if (typeof a === 'number' && a >= 1) consider(n, a);
      }
    }
    return { count: best.count, limit: best.limit, mute: best.mute };
  }

  /**
   * ModerationHook.onStrike: count it by the tag policy (§5.8); at the strike limit or a tag's autoMuteAfter, mute
   * automatically. Returns a private notice only for the auto-mute (with strikeStatus the Zone writes the escalating
   * warning itself). A line whose tags don't count (`strike: false`) is no strike at all. 'selfharm' is never counted
   * (nobody is punished for it): it raises the host's nameless wellbeing alert instead. Without `detail` (an older
   * Zone) every strike counts.
   */
  onStrike(u: ModUser, reason: StrikeReason, detail?: StrikeDetail): string | null {
    if (reason === 'selfharm') { this.alert(u, 'selfharm'); return null; }
    const tags = detail && Array.isArray(detail.tags) ? [...new Set(detail.tags.map((t) => String(t).toUpperCase()))].filter((t) => t !== TAG_SELF_HARM) : [];
    const counted = tags.filter((t) => this.tagPolicy(t).strike);
    if (tags.length && !counted.length) {
      this.lastStrike = { playerId: u.playerId, status: { count: 0, limit: this.config.strikeLimit } };
      return null;
    }
    const now = this.now();
    const keys = this.strikeKeys(u);
    for (const k of keys) {
      let arr = this.strikes.get(k);
      if (!arr) { arr = []; this.strikes.set(k, arr); }
      while (arr.length && now - arr[0]!.t > this.config.strikeWindowMs) arr.shift();
      arr.push({ t: now, tags: counted });
    }
    const st = this.standing(u);
    this.lastStrike = { playerId: u.playerId, status: { count: st.count, limit: st.limit } };
    if (this.muteFor(u)) return null;
    if (!st.mute) return null;
    const len = describeDuration(this.config.autoMuteSec);
    const what = reason === 'name' ? 'offensive names' : 'blocked language';
    const target = this.targetOfUser(u);
    const spec: BanSpec = {
      kind: 'mute', target, durationSec: this.config.autoMuteSec, notify: false, reason: `Automatic: repeated ${what}`,
    };
    // The game thread must never wait on a DB lock (the CLI or the worker may hold it): noWait, and on failure the
    // mute is enforced from memory right away and saved on a later poll.
    const res = this.createBan(SYSTEM_ACTOR, spec, { noWait: true });
    if (!res.ok) {
      if (!this.provisionalMute(u, target, spec)) { this.log(`[mod] auto-mute of #${u.playerId} failed: ${res.error}`); return null; }
      this.log(`[mod] auto-mute of #${u.playerId} enforced in memory (not saved yet: ${res.error}); retrying`);
    }
    for (const k of keys) this.strikes.delete(k);
    this.notifyAdmins(`Auto-muted ${u.name} for ${len} (${st.count} strikes: ${what}).`);
    return `You are muted for ${len} (repeated ${what}).`;
  }

  /**
   * ModerationHook.strikeStatus: the pilot's standing right after onStrike (count 0 = the tag policy didn't count
   * that line), so the Zone picks the 1st / 2nd / "one more …" warning (§5.8).
   */
  strikeStatus(u: ModUser): StrikeStatus {
    const last = this.lastStrike;
    this.lastStrike = null;
    if (last && last.playerId === u.playerId) return last.status;
    const st = this.standing(u);
    return { count: st.count, limit: st.limit };
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

  // ------------------------------------------------------------------------------------------
  // Alerts (routing: wellbeing → the host only; threat → the host, and in game trusted moderators, name only)
  // ------------------------------------------------------------------------------------------

  /**
   * ModerationHook.alert: a self-harm statement or a threat (withheld, substituted, muted or flood). SELF-HARM: the
   * host's nameless wellbeing alert, nothing to any moderator and no log line (§5.2, T-WB-1). THREAT: the host's
   * alert (its tag's `notify`), and a name-only line to online moderators whose tier may have it (trusted), at most
   * once a minute per pilot.
   */
  alert(u: ModUser, kind: AlertKind, entry?: ChatLogEntry): void {
    if (kind === 'selfharm') {
      if (entry) this.wellbeingAlertFor(entry, u);
      else this.raiseAlert('wellbeing', TAG_SELF_HARM, this.wellbeingLevel(), u);
      return;
    }
    // A threat inside a SELF-HARM line (withheld, or with a review-only SELF-HARM hit): no named alert, no moderator
    // line and no log line: the threat goes into that line's nameless wellbeing alert (§5.2, T-WB-1).
    if (entry && isWellbeingEntry(entry)) {
      this.foldIntoWellbeing(entry, u, [TAG_THREAT]);
      return;
    }
    const p = this.tagPolicy(TAG_THREAT);
    const a = p.notify === 'none' ? null : this.raiseAlert('threat', TAG_THREAT, p.notify, u, entry);
    const key = `threat:${u.accountId ? `a:${u.accountId}` : `p:${u.playerId}`}`;
    const t = this.now();
    const last = this.lastAlert.get(key);
    if (last !== undefined && t - last < ALERT_REPEAT_MS) return;
    this.lastAlert.set(key, t);
    if (can({ kind: 'moderator', tier: this.moderatorTier }, 'alerts.threat.ingame')) {
      this.notifyAdmins(`${u.name} wrote something threatening (not shown to anyone) — /log ${u.name}`);
    }
    this.log(`[mod] threat alert${a ? ` #${a.id}` : ''} (player #${u.playerId})`);
  }

  /**
   * The other tags' alerts (§5.8 `notify` banner / urgent), from a logged line's enforced tags. A SELF-HARM line raises
   * none of its own: its alerting tags (THREAT too) fold into its nameless wellbeing alert, which this raises when
   * the Zone has not yet.
   */
  private raiseTagAlerts(e: ChatLogEntry): void {
    if (e.channel === 'announce' || !Array.isArray(e.hits) || !e.hits.length) return;
    const who: ModUser = { playerId: e.playerId, name: e.name, accountId: e.accountId, username: null, address: e.address };
    if (isWellbeingEntry(e)) {
      const also = enforcedTagsOf(e.hits).filter((t) => t !== TAG_SELF_HARM && this.tagPolicy(t).notify !== 'none');
      if (also.length) this.foldIntoWellbeing(e, who, also);
      return;
    }
    for (const t of enforcedTagsOf(e.hits)) {
      if (t === TAG_SELF_HARM || t === TAG_THREAT) continue; // the Zone's alert() call raises these
      const p = this.tagPolicy(t);
      if (p.notify === 'none') continue;
      this.raiseAlert('tag', t, p.notify, who, e);
    }
  }

  /** The wellbeing alert's level: SELF-HARM's notify (urgent by default; never none). */
  private wellbeingLevel(): AlertLevel {
    return this.tagPolicy(TAG_SELF_HARM).notify === 'urgent' ? 'urgent' : 'banner';
  }

  /** The nameless wellbeing alert of a logged SELF-HARM line: the one it already raised, or a new (or folded) one. */
  private wellbeingAlertFor(entry: ChatLogEntry, u: ModUser): ModAlert {
    const had = this.wellbeingOf.get(entry);
    if (had && this.alertList.includes(had)) return had;
    const a = this.raiseAlert('wellbeing', TAG_SELF_HARM, this.wellbeingLevel(), u, entry);
    this.wellbeingOf.set(entry, a);
    return a;
  }

  /** Other alerting tags of a SELF-HARM line go into its wellbeing alert (their level can make it urgent). */
  private foldIntoWellbeing(entry: ChatLogEntry, u: ModUser, tags: readonly string[]): void {
    const a = this.wellbeingAlertFor(entry, u);
    let urgent = false;
    for (const t of tags) {
      const p = this.tagPolicy(t);
      if (p.notify === 'none') continue;
      if (!a.alsoTags.includes(t)) a.alsoTags.push(t);
      if (p.notify === 'urgent') urgent = true;
    }
    if (urgent && a.level !== 'urgent') { a.level = 'urgent'; this.urgentMail(); }
  }

  private raiseAlert(kind: ModAlertKind, tag: string, level: AlertLevel, u: ModUser, entry?: ChatLogEntry): ModAlert {
    const now = this.now();
    const senderKey = u.accountId ? `a:${u.accountId}` : `g:${u.address ?? '?'}:${nameKey(u.name)}`;
    const k = `${kind}:${tag}:${senderKey}`;
    const room = entry ? null : this.online().find((p) => p.playerId === u.playerId) ?? null;
    const line: AlertLine | null = entry ? {
      chatId: null,
      match: {
        ts: Math.floor(entry.time), playerId: Math.floor(entry.playerId) || 0, channel: String(entry.channel),
        ident: entry.accountId ? { accountId: entry.accountId } : { nameKey: nameKey(String(entry.name ?? '')), address: entry.address },
      },
    } : null;
    let a = this.alertList.find((x) => !x.acked && `${x.kind}:${x.tag}:${x.senderKey}` === k && now - x.lastAt < ALERT_REPEAT_MS);
    if (a) {
      a.count++;
      a.lastAt = now;
      if (level === 'urgent') a.level = 'urgent';
      if (line && a.lines.length < 50) a.lines.push(line);
    } else {
      a = {
        id: ++this.alertSeq, kind, tag, level, at: now, lastAt: now, count: 1, lineTs: entry ? Math.floor(entry.time) : now,
        roomName: entry ? String(entry.roomName ?? '') : room?.roomName ?? 'Zone', roomUid: entry && typeof entry.roomUid === 'string' ? entry.roomUid : null,
        channel: entry ? String(entry.channel) : 'all',
        playerId: u.playerId, name: u.name, accountId: u.accountId, senderKey, lines: line ? [line] : [],
        alsoTags: [], acked: false, ackedAt: null, ackedBy: null, note: null,
      };
      this.alertList.push(a);
      this.trimAlerts();
    }
    if (entry) {
      const item = this.ringItems.get(entry);
      if (item && (kind === 'wellbeing' || (item.alertId === null && !item.wellbeing))) item.alertId = a.id;
      if (line) {
        const list = this.entryLines.get(entry) ?? [];
        list.push(line);
        this.entryLines.set(entry, list);
      }
    }
    if (level === 'urgent') this.urgentMail();
    return a;
  }

  private trimAlerts(): void {
    if (this.alertList.length <= MAX_ALERTS) return;
    const order: ((a: ModAlert) => boolean)[] = [(a) => a.acked, (a) => a.kind !== 'wellbeing', () => true];
    for (const drop of order) {
      while (this.alertList.length > MAX_ALERTS) {
        const i = this.alertList.findIndex(drop);
        if (i < 0) break;
        this.alertList.splice(i, 1);
      }
    }
  }

  private urgentMail(): void {
    const t = this.now();
    if (!this.urgentSink || t - this.lastUrgentMail < URGENT_MAIL_EVERY_MS) return;
    this.lastUrgentMail = t;
    try { this.urgentSink(); } catch (e) { this.warn('alert-mail', `[mod] the alert email failed: ${errMsg(e)}`); }
  }

  /**
   * Find the chat ids of alert lines written since, quickly (on this thread: the sender's last 20 lines, a point query
   * each; at most 40 per call, newest first). resolveAlerts() finds the rest in the worker.
   */
  private resolveAlertIds(only?: ModAlert): void {
    const open = (only ? [only] : this.alertList).flatMap((a) => a.lines).filter((l) => l.chatId === null && l.match);
    if (!open.length) return;
    this.flushAllQuiet();
    for (const l of open.slice(-40)) {
      const m = l.match!;
      try {
        const row = this.store.recentChat(m.ident, 20).find((r) => r.ts === m.ts && r.playerId === m.playerId && r.channel === m.channel);
        if (row) { l.chatId = row.id; l.match = null; }
      } catch { /* the next call */ }
    }
  }

  /**
   * Find the chat id of every alert line not yet resolved (all of them, or one alert's), in the worker by time
   * ('chat.locate': the sender's key, ts, player and channel), however much the student typed since. A line that
   * is not in the log once everything buffered is written (dropped, or purged) is marked gone: nothing of it can come
   * back after a restart. Lines still buffered (the log is not accepting lines) stay open.
   */
  async resolveAlerts(only?: ModAlert): Promise<void> {
    this.resolveAlertIds(only);
    const client = this.maint?.client;
    if (!client) return;
    const open = (only ? [only] : this.alertList).flatMap((a) => a.lines).filter((l) => l.chatId === null && l.match);
    if (!open.length) return;
    this.flushAllQuiet();
    const buffered = this.store.pending > 0;
    for (let i = 0; i < open.length; i += LOCATE_MAX) {
      const part = open.slice(i, i + LOCATE_MAX);
      const lines: LineMatch[] = part.map((l) => {
        const m = l.match!;
        return { ts: m.ts, playerId: m.playerId, channel: m.channel, accountId: m.ident.accountId ?? null, nameKey: m.ident.accountId ? null : m.ident.nameKey ?? null };
      });
      const { ids } = await client.call<{ ids: (number | null)[] }>('chat.locate', { lines }, { timeoutMs: 30_000 });
      part.forEach((l, k) => {
        const id = ids[k];
        if (typeof id === 'number') { l.chatId = id; l.match = null; }
        else if (!buffered) l.match = null; // not in the log: gone
      });
    }
  }

  /** Unacknowledged wellbeing lines of earlier runs (the worker's 'wellbeing.pending') as nameless alerts. */
  async loadPendingWellbeing(): Promise<number> {
    const client = this.maint?.client;
    if (!client) return 0;
    let lines: { chatId: number; ts: number; roomName: string; roomUid: string | null; channel: string }[];
    try {
      lines = (await client.call<{ lines: typeof lines }>('wellbeing.pending', {}, { timeoutMs: 30_000 })).lines ?? [];
    } catch (e) {
      this.warn('wellbeing', `[mod] could not read the unacknowledged wellbeing alerts: ${errMsg(e)}`);
      return 0;
    }
    const known = new Set(this.alertList.flatMap((a) => a.lines.map((l) => l.chatId)).filter((x): x is number => x !== null));
    const level: AlertLevel = this.tagPolicy(TAG_SELF_HARM).notify === 'urgent' ? 'urgent' : 'banner';
    let added = 0;
    for (const l of [...lines].sort((x, y) => x.ts - y.ts)) {
      if (known.has(l.chatId)) continue;
      this.alertList.push({
        id: ++this.alertSeq, kind: 'wellbeing', tag: TAG_SELF_HARM, level, at: l.ts, lastAt: l.ts, count: 1, lineTs: l.ts,
        roomName: l.roomName, roomUid: l.roomUid, channel: l.channel, playerId: null, name: '', accountId: null, senderKey: `chat:${l.chatId}`,
        lines: [{ chatId: l.chatId, match: null }], alsoTags: [], acked: false, ackedAt: null, ackedBy: null, note: null,
      });
      added++;
    }
    this.alertList.sort((x, y) => x.at - y.at || x.id - y.id);
    this.trimAlerts();
    return added;
  }

  /** alerts/list: newest first; wellbeing alerts nameless. */
  alertsList(o: { includeAcked?: boolean } = {}): AlertView[] {
    this.resolveAlertIds();
    return this.alertList.filter((a) => o.includeAcked !== false || !a.acked).slice().reverse().map(alertView);
  }

  /** The Home tab's counts (no names): unacknowledged urgent and banner alerts, and how many are wellbeing ones. */
  alertCounts(): { urgent: number; banner: number; wellbeing: number } {
    const open = this.alertList.filter((a) => !a.acked);
    return { urgent: open.filter((a) => a.level === 'urgent').length, banner: open.filter((a) => a.level === 'banner').length, wellbeing: open.filter((a) => a.kind === 'wellbeing').length };
  }

  /** The kind of an alert (the handler checks `wellbeing` before acknowledging a wellbeing one). */
  alertKind(id: number): ModAlertKind | null {
    return this.alertList.find((a) => a.id === id)?.kind ?? null;
  }

  /**
   * alerts/ack ★: acknowledge one alert (with a note). A wellbeing one is also stored in wellbeing_acks for every line
   * it stands for (the worker), so none comes back after a restart and their text is cleared 30 days later. Audited.
   */
  async ackAlert(id: number, actor: Actor, note?: string | null): Promise<Result<{ alert: AlertView }>> {
    const a = this.alertList.find((x) => x.id === id);
    if (!a) return fail(404, 'No such alert.');
    const clean = typeof note === 'string' && note.trim() ? clip(note.trim(), 500) : null;
    if (!a.acked) {
      if (a.kind === 'wellbeing') {
        const client = this.maint?.client;
        if (client) {
          // Every line it stands for is stored in wellbeing_acks, or the acknowledgement is refused: an alert marked
          // acknowledged here but not there would come back after a restart, and its text would never be cleared.
          try { await this.resolveAlerts(a); } catch (e) {
            return fail(503, `The acknowledgement could not be saved (${errMsg(e)}) — try again.`);
          }
          if (a.lines.some((l) => l.chatId === null && l.match)) {
            return fail(503, 'The alert\'s chat line is not saved in the log yet (the Server panel says why) — try again in a moment.', { code: 'notLogged' });
          }
          const ids = [...new Set(a.lines.map((l) => l.chatId).filter((x): x is number => x !== null))];
          try {
            for (const chatId of ids) await client.call('wellbeing.ack', { chatId, by: actor.name, note: clean, at: this.now() }, { timeoutMs: 30_000 });
          } catch (e) {
            return fail(503, `The acknowledgement could not be saved (${errMsg(e)}) — try again.`);
          }
        } else this.resolveAlertIds(a);
      }
      a.acked = true;
      a.ackedAt = this.now();
      a.ackedBy = actor.name;
      a.note = clean;
      this.audit(actor, a.kind === 'wellbeing' ? 'wellbeing-ack' : 'note', a.kind === 'wellbeing' ? null : { accountId: a.accountId, name: a.name },
        `alert #${a.id} acknowledged (${a.kind === 'wellbeing' ? 'wellbeing' : a.tag})${clean && a.kind !== 'wellbeing' ? `: ${clean}` : ''}`);
    }
    return { ok: true, alert: alertView(a) };
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
      return { query: q, name: acc.username, online: [], accountId: acc.id, username: acc.username, address: banAddress(last?.address), playerId: null };
    }
    const last = this.store.lastSeenByName(key);
    if (last) {
      const username = last.accountId ? this.store.accountById(last.accountId)?.username ?? null : null;
      return { query: q, name: username ?? last.name, online: [], accountId: last.accountId, username, address: banAddress(last.address), playerId: null };
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
      address: online[0]?.address ?? banAddress(last?.address), playerId: online[0]?.playerId ?? null,
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

  /** Private line to every online moderator. Never used for a wellbeing (self-harm) line. */
  notifyAdmins(text: string): void {
    const z = this.zone;
    if (!z) return;
    for (const p of z.onlinePilots()) if (this.isAdmin(p)) z.tellPilot(p.playerId, `[mod] ${text}`);
  }

  // ------------------------------------------------------------------------------------------
  // Operations (chat commands + HTTP API)
  // ------------------------------------------------------------------------------------------

  /** Audit one moderation action (any v0.6 kind: AuditKind). */
  audit(actor: Actor, action: AuditKind, t: { accountId?: string | null; name?: string | null; address?: string | null } | null,
    reason: string, extra: { durationSec?: number | null; expiresAt?: number | null } = {}): void {
    try {
      this.store.addAction({
        ts: this.now(), actorAccountId: actor.accountId, actorName: actor.name, action: action as ModActionKind,
        targetAccountId: t?.accountId ?? null, targetName: t?.name ?? null, targetAddress: t?.address ?? null,
        durationSec: extra.durationSec ?? null, expiresAt: extra.expiresAt ?? null, reason,
      });
    } catch (e) {
      this.warn('audit', `[mod] could not write the audit trail: ${errMsg(e)}`);
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
    const address = banAddress(t?.address ?? spec.address);
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
      if (!opts.quiet) this.log(`[mod] could not save the ${spec.kind}: ${errMsg(e)}`);
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
        this.log(`[mod] could not revoke #${b.id}: ${errMsg(e)}`);
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

  /**
   * A target's last `n` chat lines (oldest first). SELF-HARM (wellbeing) lines are left out unless `wellbeing: true`:
   * they are the host's alone (§5.2 "moderators' feeds, /log and report lines leave them out entirely"), and the
   * in-game /log is a moderator's feed.
   */
  chatOf(t: Target, n: number, o: { wellbeing?: boolean } = {}): ChatLogRow[] {
    this.flushAllQuiet();
    if (o.wellbeing) return this.store.recentChat(this.identOf(t), n);
    const want = Math.max(1, Math.floor(n));
    return this.store.recentChat(this.identOf(t), Math.min(500, want + 20)).filter((l) => !isWellbeingRow(l)).slice(-want);
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

  /**
   * ModerationHook.report: `/report <target> <reason>` (rate limited per reporter and per network). The report keeps
   * the target's last 20 lines as SHOWN-ONLY copies (§6.4: no original text, address or hit labels; ModStore.addReport
   * enforces it too). Online moderators hear of it; a limited-tier moderator without the reporter's name (§5.2).
   */
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
      // (a withheld wellbeing line is kept as its marked copy, for the host only: ModStore.addReport; http.ts scrubs it)
      const recentChat = this.chatOf(t, 20, { wellbeing: true }).map((l) => ({ ...l, original: '', hits: [], address: null }));
      row = this.store.addReport({
        ts: this.now(), reason: clip(reason.trim(), 200), room: ctx.roomName, recentChat,
        reporter: { playerId: reporter.playerId, name: reporter.name, accountId: reporter.accountId, address: reporter.address },
        target: { playerId: t.playerId, name: t.online[0]?.name ?? t.name, accountId: t.accountId, address: t.address },
      }, { noWait: true }); // a player's /report runs on the game thread: never wait on a lock the worker or CLI holds
    } catch (e) {
      this.log(`[mod] could not save a report: ${errMsg(e)}`);
      return ["Couldn't send the report right now — please try again in a moment."];
    }
    this.log(`[mod] report #${row.id} filed (player #${reporter.playerId} → ${t.playerId === null ? 'offline player' : `#${t.playerId}`})`);
    const withReporter = can({ kind: 'moderator', tier: this.moderatorTier }, 'reports.reporter');
    this.notifyAdmins(withReporter
      ? `New report #${row.id}: ${reporter.name} reported ${row.target.name} — ${row.reason} (/reports)`
      : `New report #${row.id} about ${row.target.name} — ${row.reason} (/reports)`);
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

  // ------------------------------------------------------------------------------------------
  // Live chat (§5.4)
  // ------------------------------------------------------------------------------------------

  /**
   * chat/live: the Live lines after `q.after`, or a wait of up to `waitMs` (≤ 25 s) for the next matching one.
   * 'busy' = this session already has LIVE_MAX_WAITS waits open.
   */
  livePoll(q: LiveQuery, o: { waitMs?: number; key: string; signal?: AbortSignal }): Promise<LivePage | 'busy'> {
    return this.live.wait(q, { waitMs: Math.max(0, Math.min(LIVE_MAX_WAIT_MS, o.waitMs ?? 0)), key: o.key, signal: o.signal });
  }

  // ------------------------------------------------------------------------------------------
  // Exports (§5.5 ★): streamed by the worker, written by the shared CSV writer
  // ------------------------------------------------------------------------------------------

  /** Delete the exports saved on this PC more than 7 days ago (§6.4). Returns how many. */
  pruneExports(now = this.now()): number {
    let n = 0;
    let names: string[];
    try { names = fs.readdirSync(this.exportsDir); } catch { return 0; }
    for (const name of names) {
      if (!EXPORT_FILE_RE.test(name)) continue;
      const f = path.join(this.exportsDir, name);
      try {
        if (now - fs.statSync(f).mtimeMs > EXPORTS_KEEP_DAYS * DAY) { fs.rmSync(f, { force: true }); n++; }
      } catch { /* gone */ }
    }
    return n;
  }

  /**
   * One Chat log export: the worker streams the matching lines (oldest first, 1,000 per page) through the shared
   * writer, into a download (at most maxRows lines) or into data\exports\<file>. What they typed only with
   * includeOriginal; SELF-HARM lines only with includeWellbeing. Always audited ('export', filter and row count).
   */
  async exportChatLog(req: ChatExportRequest): Promise<ChatExportResult> {
    const client = this.maint?.client;
    if (!client) return fail(503, 'Exports need the maintenance worker, which is not running: restart the host (Server → status shows why).', { code: 'worker' });
    const format: ExportFormat = req.format === 'json' ? 'json' : 'csv';
    const includeOriginal = req.includeOriginal === true;
    const includeWellbeing = req.includeWellbeing === true;
    const max = Math.max(1, Math.floor(req.maxRows ?? DOWNLOAD_MAX_ROWS));
    const now = this.now();
    this.flushAllQuiet();
    const writer = exportWriter(format, chatLogColumns({ includeOriginal }));
    const args = {
      ...req.filter, includeOriginal, includeSelfHarm: includeWellbeing, searchIn: req.searchOriginal ? 'both' : 'shown',
      pageSize: EXPORT_PAGE_ROWS,
    };
    let fileName = exportFileName('chat-log', format, now);
    let rows = 0;
    let file: fs.promises.FileHandle | null = null;
    /** the file THIS export created (the only one it may delete on a failure) */
    let target: string | null = null;
    const chunks: string[] = [];
    try {
      if (req.saveOnHost) {
        fs.mkdirSync(this.exportsDir, { recursive: true });
        this.pruneExports(now);
        // Two exports in the same second (a double click, two tabs): -2, -3, … — never another export's file.
        const base = fileName;
        for (let n = 1; !file; n++) {
          const name = n === 1 ? base : base.replace(/\.(csv|json)$/, `-${n}.$1`);
          try {
            file = await fs.promises.open(path.join(this.exportsDir, name), 'wx', 0o600);
            fileName = name;
            target = path.join(this.exportsDir, name);
          } catch (e) {
            if ((e as { code?: string })?.code !== 'EEXIST' || n >= EXPORT_NAME_TRIES) throw e;
          }
        }
        await file.write(writer.head());
      } else chunks.push(writer.head());
      const stream = client.stream<ChatLogRow>('log.export', args, { signal: req.signal });
      for await (const page of stream) {
        rows += page.length;
        if (!file && rows > max) {
          stream.cancel();
          return fail(413, `This export has more than ${max.toLocaleString('en-US')} lines: narrow the filter, or tick "Save on this PC".`, { code: 'tooBig' });
        }
        const text = writer.rows(page);
        if (file) await file.write(text); else chunks.push(text);
      }
      await stream.result;
      if (req.signal?.aborted) {
        const err = Object.assign(new Error('The export was cancelled.'), { code: 'ECANCEL' });
        throw err; // (the catch removes this export's part-written file)
      }
      if (file) { await file.write(writer.end()); await file.close(); file = null; } else chunks.push(writer.end());
    } catch (e) {
      if (file) { try { await file.close(); } catch { /* closed */ } file = null; }
      if (target) { try { fs.rmSync(target, { force: true }); } catch { /* gone */ } }
      const code = (e as { code?: string })?.code;
      if (code === 'EARGS') return fail(400, errMsg(e), { code });
      if (code === 'ECANCEL') return fail(499, 'The export was cancelled.', { code: 'cancelled' });
      return fail(code === 'EWORKER' ? 503 : 500, `The export failed: ${errMsg(e)}`, { code: code ?? 'failed' });
    } finally {
      if (file) { try { await file.close(); } catch { /* closed */ } }
    }
    const flags = [format, includeOriginal ? 'with unfiltered text' : null, includeWellbeing ? 'with wellbeing lines' : null, req.saveOnHost ? 'saved on this PC' : 'download']
      .filter(Boolean).join(', ');
    const acc = typeof req.filter.accountId === 'string' ? req.filter.accountId : null;
    this.audit(req.actor, 'export', acc ? { accountId: acc } : null, `chat log export: ${rows} line(s) (${flags}); filter: ${filterDesc(req.filter)}`);
    if (target) return { ok: true, saved: true, savedTo: path.join(path.basename(this.exportsDir), fileName), fileName, rows };
    return { ok: true, saved: false, body: Buffer.from(chunks.join(''), 'utf8'), fileName, contentType: EXPORT_CONTENT_TYPES[format], rows };
  }

  // ------------------------------------------------------------------------------------------
  // Manual purge (§5.5 ★; T-ADM-8)
  // ------------------------------------------------------------------------------------------

  /**
   * "Purge lines before <date>" (optionally one student's): without `confirmRows` equal to the count, a 409 with the
   * count (and the cut, to send back); with it, the worker's recorded purge (the ledger entry first; the lines,
   * their tags, counters, reviews and report copies). A cut in the future means now. Audited.
   */
  async purgeLog(req: { before: number; accountId?: string | null; confirmRows?: number | null; actor: Actor }): Promise<PurgeResult> {
    const client = this.maint?.client;
    if (!client) return fail(503, 'Purges need the maintenance worker, which is not running: restart the host.', { code: 'worker' });
    const now = this.now();
    if (!Number.isFinite(req.before)) return fail(400, 'before must be a date or a time.');
    const before = Math.min(Math.floor(req.before), now);
    const accountId = req.accountId || null;
    this.flushAllQuiet();
    let rows: number;
    try {
      rows = (await client.call<{ rows: number }>('purge.count', { before, accountId }, { timeoutMs: 60_000 })).rows;
    } catch (e) {
      return fail(503, `The lines could not be counted: ${errMsg(e)}`);
    }
    if (req.confirmRows !== rows) {
      return fail(409, `This deletes ${rows.toLocaleString('en-US')} chat line(s) from before ${stamp(before)}${accountId ? ' (one student)' : ''}. Send confirmRows: ${rows} (and this before) to go ahead.`,
        { needsConfirm: true, rows, before, note: PURGE_NOTE });
    }
    if (rows === 0) return { ok: true, deleted: 0, conductRows: 0, reportCopies: 0, before, note: PURGE_NOTE };
    let r: { deleted: number; conductRows: number; reportCopies: number };
    try {
      r = await client.call('purge.chat', { before, accountId, by: ledgerBy(req.actor), ts: now }, { timeoutMs: 30 * MIN });
    } catch (e) {
      // The ledger entry is written and some lines may be gone: a purge is always audited (§5.5), a stopped one too.
      this.audit(req.actor, 'purge', accountId ? { accountId } : null,
        `purge of ${rows} chat line(s) before ${stamp(before)}${accountId ? ' (one student)' : ''} stopped part way (${clip(errMsg(e), 120)}); some lines may already be gone`);
      this.log(`[mod] purge stopped part way: ${errMsg(e)}`);
      try { this.maint?.indexDirty?.(); } catch { /* the hourly look finds it */ }
      return fail(500, `The purge stopped: ${errMsg(e)} (run it again to finish: it picks up where it stopped).`);
    }
    this.audit(req.actor, 'purge', accountId ? { accountId } : null, `purged ${r.deleted} chat line(s) before ${stamp(before)}${accountId ? ' (one student)' : ''}`);
    this.log(`[mod] purge: ${r.deleted} chat line(s) removed`);
    try { this.maint?.indexDirty?.(); } catch { /* the hourly look finds it */ }
    this.forgetLines(before, accountId);
    return { ok: true, deleted: r.deleted, conductRows: r.conductRows, reportCopies: r.reportCopies, before, note: PURGE_NOTE };
  }

  /** Lines older than `before` (one account's) are gone: out of the Live ring, and their alerts. */
  private forgetLines(before: number, accountId: string | null): void {
    this.live.remove((it) => it.ts < before && (!accountId || it.owner === accountId));
    // (a wellbeing alert keeps its account internally, never in its view)
    this.alertList = this.alertList.filter((a) => !(a.lineTs < before && (!accountId || a.accountId === accountId)));
  }

  // ------------------------------------------------------------------------------------------
  // Retention (§5.5)
  // ------------------------------------------------------------------------------------------

  /** The retention rule in force (the settings' when bound, else CHAT_LOG_RETENTION_DAYS in `days` mode). */
  retentionPolicy(): RetentionPolicy {
    if (this.policy) return this.policy.retention;
    return { mode: 'days', days: this.config.retentionDays, termEnd: null, graceDays: TERM_GRACE_DAYS, recordsDays: this.config.keepDays };
  }

  /** log/stats `retention` and `nextPurgeAt` (§5.5 header: "retention 90 days · next purge tonight"). */
  retentionInfo(): {
    mode: string; days: number; termEnd: string | null; recordsDays: number; phase: RetentionPhase; purgeAt: number | null; fallbackAt: number | null;
    nextPurgeAt: number | null; lastRunAt: number | null; owed: TermOwed[];
  } {
    const p = this.retentionPolicy();
    const now = this.now();
    const plan = retentionPlan(p, now);
    const owed = p.mode === 'term' ? this.termOwed.slice() : [];
    let nextPurgeAt = plan.phase === 'forever' ? null : plan.chatBefore === null ? plan.purgeAt : this.nextRetention;
    for (const o of owed) {
      const at = now >= o.purgeAt ? this.nextRetention : o.purgeAt;
      if (nextPurgeAt === null || at < nextPurgeAt) nextPurgeAt = at;
    }
    return {
      mode: p.mode, days: p.days, termEnd: p.termEnd, recordsDays: p.recordsDays, phase: plan.phase, purgeAt: plan.purgeAt, fallbackAt: plan.fallbackAt,
      nextPurgeAt, lastRunAt: this.lastRetention?.at ?? null, owed,
    };
  }

  /** When the next retention run is due. */
  get nextRetentionRunAt(): number { return this.nextRetention; }

  /**
   * One retention run (nightly after 02:00, a minute after a start or a retention change): the chat cut of
   * retentionPlan (a term's after a pre-purge backup, at most once per term), records retention, the 30-day wellbeing
   * clear and (School) address minimisation — in the worker, or here in small steps without one.
   */
  runRetention(o: { chunk?: number } = {}): Promise<RetentionRun> {
    if (this.retentionRunning) return this.retentionRunning;
    const p = this.retentionOnce(o).finally(() => { if (this.retentionRunning === p) this.retentionRunning = null; });
    this.retentionRunning = p;
    return p;
  }

  private async retentionOnce(o: { chunk?: number }): Promise<RetentionRun> {
    await this.maintLoads; // the owed term purges of earlier runs
    const now = this.now();
    const pol = this.retentionPolicy();
    const plan = retentionPlan(pol, now);
    const client = this.maint?.client ?? null;
    const run: RetentionRun = { at: now, phase: plan.phase, where: client ? 'worker' : 'thread', chat: 0, records: 0, addresses: 0, wellbeing: 0, skipped: null };
    this.nextRetention = nextRetentionAt(now);
    if (this.closed) return run;
    const keepBefore = now - Math.max(1, pol.recordsDays) * DAY;
    // A term purge still owed after the next term's date was set early (termPurgeOwed) goes at its own purgeAt,
    // whatever the plan of the new date says, with the same backup first.
    const owed = pol.mode === 'term' ? this.termOwed.filter((p) => now >= p.purgeAt) : [];
    let cut = plan.chatBefore;
    let termKey = plan.backupFirst ? plan.termCut : null;
    for (const p of owed) {
      if (cut === null || p.cut > cut) cut = p.cut;
      if (termKey === null || p.cut > termKey) termKey = p.cut;
    }
    try {
      if (cut !== null && termKey !== null && !this.termBackups.has(termKey)) {
        const due = client
          ? (await client.call<{ rows: number }>('purge.count', { before: cut }, { timeoutMs: 60_000 })).rows > 0
          : true;
        if (due) {
          const b = this.maint?.backup ? await this.maint.backup('pre-purge', 'system').catch((e: unknown) => ({ ok: false as const, error: errMsg(e) })) : null;
          if (!b || !b.ok) {
            const why = !b ? 'this server makes no backups' : 'error' in b && b.error ? b.error : 'text' in b && b.text ? b.text : 'the backup was skipped';
            run.skipped = `the term's chat was not deleted: the backup that must come first failed (${why})`;
            this.retentionProblem = { code: 'term-purge-waiting', level: 'warn', text: `The term's chat was not deleted yet: the backup that must come first failed (${why}). It is tried again tonight.` };
            cut = null;
          } else {
            this.termBackups.add(termKey);
            this.retentionProblem = null;
          }
        } else this.termBackups.add(termKey);
      } else if (termKey === null) this.retentionProblem = null;

      if (client) {
        if (cut !== null) {
          const r = await client.call<{ deleted: number }>('retention.chat', { before: cut }, { timeoutMs: 30 * MIN });
          run.chat = r.deleted;
          if (r.deleted) { try { this.maint?.indexDirty?.(); } catch { /* hourly look */ } this.forgetLines(cut, null); }
          this.settleOwed(cut);
        }
        const rec = await client.call<Record<string, number>>('retention.records', { keepBefore, deviceChecksBefore: now - DEVICE_CHECK_DAYS * DAY }, { timeoutMs: 30 * MIN });
        run.records = Object.values(rec).reduce((s, v) => s + (Number(v) || 0), 0);
        if (this.policy?.addressMinimisation) {
          const ad = await client.call<{ accountLines: number; guestLines: number }>('retention.addresses', { before: now - ADDRESS_MINIMISE_DAYS * DAY }, { timeoutMs: 30 * MIN });
          run.addresses = ad.accountLines + ad.guestLines;
        }
        const wb = await client.call<{ cleared: number }>('wellbeing.clear', { before: now - WELLBEING_CLEAR_DAYS * DAY }, { timeoutMs: 30 * MIN });
        run.wellbeing = wb.cleared;
        if (wb.cleared) { try { this.maint?.indexDirty?.(); } catch { /* hourly look */ } }
      } else {
        // No worker: the game-thread pruner in small steps with a pause between them (store.ts PRUNE_CHUNK).
        for (;;) {
          if (this.closed) break;
          const k = this.store.pruneStep({ chatBefore: cut ?? Number.MIN_SAFE_INTEGER, keepBefore }, Math.max(1, Math.floor(o.chunk ?? FALLBACK_PRUNE_CHUNK)));
          run.records += k;
          if (k === 0) break;
          await new Promise((r) => setTimeout(r, 25));
        }
        if (cut !== null) { this.forgetLines(cut, null); this.settleOwed(cut); }
      }
    } catch (e) {
      run.skipped = run.skipped ?? `the run stopped: ${errMsg(e)}`;
      this.warn('prune', `[mod] retention failed: ${errMsg(e)}`);
    }
    // §6.4: exports saved on this PC go after 7 days (also checked at every save).
    try { this.pruneExports(now); } catch { /* the next run */ }
    const total = run.chat + run.records + run.addresses + run.wellbeing;
    if (total) this.log(`[mod] retention: ${run.chat} chat line(s), ${run.records} record(s)${run.addresses ? `, ${run.addresses} address(es) minimised` : ''}${run.wellbeing ? `, ${run.wellbeing} wellbeing line(s) cleared` : ''}`);
    this.lastRetention = run;
    return run;
  }

  /** The chat before `cut` is gone: the owed term purges it covers are settled. */
  private settleOwed(cut: number): void {
    const left = this.termOwed.filter((p) => p.cut > cut);
    if (left.length !== this.termOwed.length) this.saveTermOwed(left);
  }

  /**
   * Run retention now. Resolves with the rows removed or changed (chat lines, records, …). `chunk`: rows per step of
   * the pruner without a worker (default FALLBACK_PRUNE_CHUNK; the CLI, in its own process, passes more).
   */
  async pruneNow(chunk?: number): Promise<number> {
    const r = await this.runRetention({ chunk });
    return r.chat + r.records + r.addresses + r.wellbeing;
  }

  // ------------------------------------------------------------------------------------------
  // Log stats and banners
  // ------------------------------------------------------------------------------------------

  /** log/stats (§5.15): the worker's numbers plus retention, the next purge and the chat buffer. */
  async logStats(a: { days?: number; tzOffsetMin?: number; fresh?: boolean } = {}): Promise<Result<LogStats & {
    retention: ReturnType<ModerationService['retentionInfo']>; nextPurgeAt: number | null; dropped: number; pending: number;
  }>> {
    const client = this.maint?.client;
    if (!client) return fail(503, 'The log statistics need the maintenance worker, which is not running.', { code: 'worker' });
    let st: LogStats;
    try { st = await client.call<LogStats>('log.stats', a, { timeoutMs: 30_000 }); } catch (e) { return fail(503, `The statistics could not be read: ${errMsg(e)}`); }
    const retention = this.retentionInfo();
    return { ok: true, ...st, retention, nextPurgeAt: retention.nextPurgeAt, dropped: this.store.dropped, pending: this.store.pending };
  }

  /**
   * This module's banners (§5.2): urgent alerts and a waiting wellbeing alert (counts only, never names), the term
   * retention banners, a term purge waiting for its backup, and "Chat is NOT being logged".
   */
  banners(): Banner[] {
    const out: Banner[] = [];
    const c = this.alertCounts();
    if (c.wellbeing) out.push({ code: 'wellbeing', level: 'urgent', text: `${c.wellbeing === 1 ? 'A wellbeing alert needs' : `${c.wellbeing} wellbeing alerts need`} your attention — open it on the Home tab.` });
    // (a wellbeing alert has its own banner above, whatever its level: never counted twice)
    const urgent = this.alertList.filter((a) => !a.acked && a.level === 'urgent' && a.kind !== 'wellbeing').length;
    if (urgent > 0) out.push({ code: 'alerts-urgent', level: 'urgent', text: `${urgent} urgent alert${urgent === 1 ? '' : 's'} — open the Home tab.` });
    const now = this.now();
    const plan = retentionPlan(this.retentionPolicy(), now);
    if (plan.banner) out.push(plan.banner);
    // an ended term whose purge is still owed (the next term's date was already set): its grace banner stays
    for (const p of this.retentionPolicy().mode === 'term' ? this.termOwed : []) {
      if (now >= p.purgeAt || (plan.termCut === p.cut && plan.banner)) continue;
      out.push({
        code: 'term-ended', level: 'warn',
        text: `The term ended on ${owedEndText(p.cut)}. Its chat is deleted on ${dayText(p.purgeAt)}, after a backup: export it first if the district keeps it.`,
      });
    }
    if (this.retentionProblem) out.push(this.retentionProblem);
    const recent = this.lastFlushErrorAt !== null && this.now() - this.lastFlushErrorAt < 5 * MIN;
    if (this.store.dropped > 0 || recent) {
      out.push({
        code: 'chat-not-logged', level: 'urgent',
        text: `Chat is NOT being logged: the database is not accepting lines${this.store.dropped ? ` (${this.store.dropped} dropped)` : ''}. Check the free space on the data drive; the Server panel has details.`,
      });
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------
// The admin endpoints (AdminHttpOptions.handlers): chat/live, log (in the worker; it wins over http.ts's built-in
// game-thread `log`, which stays the fallback without a worker), log/context, log/rooms, log/reveal ★, log/export ★,
// log/purge ★, log/stats, alerts/list, alerts/ack ★. http.ts decides who may call what (capabilities, ★, host PC) and
// scrubs the JSON replies (a file reply is not scrubbed: log/export applies the rules itself).
// ------------------------------------------------------------------------------------------

const bad = (msg: string): HttpError => new HttpError(400, msg);
const str = (v: unknown, max: number, what: string): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw bad(`${what} must be text`);
  return v.trim().slice(0, max) || undefined;
};
const intOf = (v: unknown, what: string, min: number, max: number): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(`${what} must be a whole number from ${min} to ${max}`);
  return v;
};
const boolOf = (v: unknown, what: string): boolean | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw bad(`${what} must be true or false`);
  return v;
};
const LIVE_CHANNELS = new Set(['all', 'team', 'name', 'room', 'announce', 'lobby']);

/** A chat/live body as a LiveQuery (and its wait in ms). */
export function liveQueryOf(b: Record<string, unknown>): { q: LiveQuery; waitMs: number } {
  const q: LiveQuery = {};
  q.after = intOf(b.after, 'after', 0, Number.MAX_SAFE_INTEGER);
  q.limit = intOf(b.limit, 'limit', 1, LIVE_MAX_LIMIT);
  q.roomUid = str(b.roomUid, 80, 'roomUid');
  q.tag = str(b.tag, 40, 'tag')?.toUpperCase();
  q.flaggedOnly = boolOf(b.flaggedOnly, 'flaggedOnly');
  const ch = str(b.channel, 16, 'channel');
  if (ch !== undefined && !LIVE_CHANNELS.has(ch)) throw bad('channel must be all, team, name, room, announce or lobby');
  q.channel = ch;
  q.player = str(b.player, 64, 'player');
  let waitMs = 0;
  if (b.wait !== undefined && b.wait !== null) {
    if (typeof b.wait !== 'number' || !Number.isFinite(b.wait) || b.wait < 0 || b.wait > LIVE_MAX_WAIT_MS / 1000) throw bad('wait must be 0 to 25 (seconds)');
    waitMs = Math.round(b.wait * 1000);
  }
  return { q, waitMs };
}

const EXPORT_FILTER_KEYS = ['player', 'accountId', 'address', 'q', 'grep', 'tag', 'roomId', 'roomUid'] as const;

/** An export's filter from its body (the worker validates the rest: action, display, channel, ranges). */
function exportFilterOf(b: Record<string, unknown>, c: AdminRouteContext): Record<string, unknown> {
  if (b.all === true) return {};
  const f: Record<string, unknown> = {};
  for (const k of EXPORT_FILTER_KEYS) {
    const v = str(b[k], k === 'q' || k === 'grep' ? 200 : 80, k);
    if (v !== undefined) f[k] = k === 'address' ? v.toLowerCase() : v;
  }
  if (f.address !== undefined && !c.can('addresses')) throw new HttpError(403, 'Not allowed for your role');
  for (const k of ['action', 'display', 'channel', 'ranges'] as const) if (b[k] !== undefined && b[k] !== null) f[k] = b[k];
  if (b.since !== undefined && b.since !== null) {
    const s = parseSince(b.since, c.now());
    if (s === undefined) throw bad('since must be epoch ms or a duration like 7d');
    f.since = s;
  }
  if (b.until !== undefined && b.until !== null) {
    if (typeof b.until !== 'number' || !Number.isFinite(b.until)) throw bad('until must be epoch ms');
    f.until = Math.floor(b.until);
  }
  return f;
}

/** A purge's `before`: epoch ms, or a date "YYYY-MM-DD" (the start of that day, host local time). */
export function purgeBeforeOf(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === 'string') {
    const t = localDay(v.trim(), 0);
    if (t !== null) return t;
  }
  throw bad('before must be a date (YYYY-MM-DD) or epoch ms');
}

/** An epoch-ms time, or a duration like 7d meaning that long before now (since / until of the log reads). */
function timeArg(v: unknown, c: AdminRouteContext, what: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  const t = parseSince(v, c.now());
  if (t === undefined) throw bad(`${what} must be epoch ms or a duration like 7d`);
  return t;
}

/** A `log` body as a LogQuery (the worker validates the rest: display, channel, ranges). */
function logQueryArgs(b: Record<string, unknown>, c: AdminRouteContext): LogQuery {
  const q: LogQuery = {};
  q.player = str(b.player, 64, 'player');
  q.accountId = str(b.accountId, 64, 'accountId');
  q.address = str(b.address, 64, 'address')?.toLowerCase();
  if (q.address && !c.can('addresses')) throw new HttpError(403, 'Not allowed for your role');
  q.q = str(b.q, 200, 'q');
  q.grep = str(b.grep, 200, 'grep');
  q.roomId = str(b.roomId, 32, 'roomId');
  q.roomUid = str(b.roomUid, 80, 'roomUid');
  q.tag = str(b.tag, 40, 'tag')?.toUpperCase();
  if (b.action !== undefined && b.action !== null) {
    if (b.action !== 'flagged' && !(CHAT_ACTIONS as readonly unknown[]).includes(b.action)) throw bad('action must be pass, flag, mask, block, spam, muted or flagged');
    q.action = b.action as LogQuery['action'];
  }
  if (b.display !== undefined && b.display !== null) q.display = b.display as LogQuery['display'];
  if (b.channel !== undefined && b.channel !== null) q.channel = b.channel as LogQuery['channel'];
  if (b.ranges !== undefined && b.ranges !== null) q.ranges = b.ranges as LogQuery['ranges'];
  q.since = timeArg(b.since, c, 'since');
  if (b.until !== undefined && b.until !== null) {
    if (typeof b.until !== 'number' || !Number.isFinite(b.until)) throw bad('until must be epoch ms');
    q.until = Math.floor(b.until);
  }
  q.before = intOf(b.before, 'before', 1, Number.MAX_SAFE_INTEGER);
  q.beforeTs = typeof b.beforeTs === 'number' && Number.isFinite(b.beforeTs) ? Math.floor(b.beforeTs) : undefined;
  q.limit = intOf(b.limit, 'limit', 1, 1000) ?? 100;
  for (const k of Object.keys(q) as (keyof LogQuery)[]) if (q[k] === undefined) delete q[k];
  return q;
}

const logArgsDesc = (q: LogQuery): string => (['player', 'accountId', 'address', 'q', 'grep', 'action', 'tag', 'roomUid', 'roomId', 'since'] as const)
  .filter((k) => q[k] !== undefined).map((k) => `${k}=${String(q[k]).slice(0, 40)}`).join(' ');

function needWorker(svc: ModerationService): MaintAccess {
  const w = svc.worker;
  if (!w) throw new HttpError(503, 'The chat log needs the maintenance worker, which is not running: restart the host.');
  return w;
}

/** A worker failure as a reply: bad arguments 400, the worker gone 503, a cancelled call 499, else 500. */
function workerFail(e: unknown): [number, Record<string, unknown>] {
  const code = (e as { code?: string })?.code;
  if (code === 'EARGS') return [400, { error: errMsg(e), code }];
  if (code === 'ECANCEL') return [499, { error: 'Cancelled.', code: 'cancelled' }];
  return [code === 'EWORKER' || code === 'ETIMEOUT' ? 503 : 500, { error: `The chat log could not be read: ${errMsg(e)}`, code: code ?? 'failed' }];
}

function replyOf(f: Fail): [number, Record<string, unknown>] {
  const { ok: _ok, status, ...rest } = f;
  return [status, rest];
}

/**
 * The endpoints this service answers, for AdminHttpOptions.handlers (startServer:
 * `handlers: { ...maintAdminHandlers(maint), ...moderationAdminHandlers(mod) }`).
 */
export function moderationAdminHandlers(svc: ModerationService): Record<string, AdminRouteHandler> {
  return {
    'chat/live': async (b, c): Promise<AdminReply> => {
      const { q, waitMs } = liveQueryOf(b);
      // Hosts get SELF-HARM lines as the nameless line; moderators none at all (§5.2).
      q.includeWellbeing = c.principal?.kind === 'host';
      const key = c.session?.tokenHash ?? 'anonymous';
      const page = await svc.livePoll(q, { waitMs, key, signal: c.signal });
      if (page === 'busy') return [429, { error: `At most ${LIVE_MAX_WAITS} Live views can wait at once in one session — close one.`, code: 'liveBusy' }];
      return [200, { ok: true, ...page }];
    },

    'log/export': async (b, c): Promise<AdminReply> => {
      if (b.format !== undefined && b.format !== 'csv' && b.format !== 'json') throw bad('format must be csv or json');
      const includeOriginal = boolOf(b.includeOriginal, 'includeOriginal') === true;
      const includeWellbeing = boolOf(b.includeWellbeing, 'includeWellbeing') === true;
      if (includeOriginal) c.require('reveal');
      if (includeWellbeing) c.require('wellbeing');
      const r = await svc.exportChatLog({
        filter: exportFilterOf(b, c), format: b.format === 'json' ? 'json' : 'csv', includeOriginal, includeWellbeing,
        searchOriginal: c.can('reveal'), saveOnHost: boolOf(b.saveOnHost, 'saveOnHost') === true, actor: c.actor, signal: c.signal,
      });
      if (!r.ok) return replyOf(r);
      if (r.saved) return [200, { ok: true, savedTo: r.savedTo, fileName: r.fileName, rows: r.rows }];
      return { file: { body: r.body, filename: r.fileName, contentType: r.contentType, rows: r.rows } };
    },

    'log/purge': async (b, c): Promise<AdminReply> => {
      const r = await svc.purgeLog({
        before: purgeBeforeOf(b.before), accountId: str(b.accountId, 64, 'accountId') ?? null,
        confirmRows: intOf(b.confirmRows, 'confirmRows', 0, Number.MAX_SAFE_INTEGER) ?? null, actor: c.actor,
      });
      if (!r.ok) return replyOf(r);
      return [200, r];
    },

    'log/stats': async (b): Promise<AdminReply> => {
      const r = await svc.logStats({
        days: intOf(b.days, 'days', 1, 400), tzOffsetMin: intOf(b.tzOffsetMin, 'tzOffsetMin', -840, 840), fresh: boolOf(b.fresh, 'fresh'),
      });
      if (!r.ok) return replyOf(r);
      return [200, r];
    },

    'log': async (b, c): Promise<AdminReply> => {
      const q = logQueryArgs(b, c);
      const see = { original: c.can('reveal'), selfHarm: c.can('wellbeing') };
      svc.flushAllQuiet();
      const client = svc.worker;
      let out: Record<string, unknown>;
      if (client) {
        // In the worker (§5.16, T-ADM-7): the rows the caller may not see are left out in the SQL, before paging (no
        // SELF-HARM row without `wellbeing`; without `reveal` the text is matched in the shown text only), and no
        // original text or hit labels come back (reveals go through log/reveal).
        let page: LogPage;
        try {
          page = await client.call<LogPage>('log.search', {
            ...q, searchIn: see.original ? 'both' : 'shown', includeSelfHarm: see.selfHarm, withOriginal: false,
          }, { timeoutMs: 30_000, signal: c.signal });
        } catch (e) { return workerFail(e); }
        out = { lines: page.lines, nextBefore: page.nextBefore, nextBeforeTs: page.nextBeforeTs, partial: page.partial };
      } else {
        // No worker: http.ts's own game-thread page (the same visibility rules), as the built-in `log` answers.
        const { visibleLogPage } = await import('./http');
        out = visibleLogPage(svc.store, q, see);
      }
      svc.auditRead(c.actor, `api log ${logArgsDesc(q)}`.trim());
      return [200, { ok: true, ...out }];
    },

    'log/context': async (b, c): Promise<AdminReply> => {
      const id = intOf(b.id, 'id', 1, Number.MAX_SAFE_INTEGER);
      if (id === undefined) throw bad('id is required');
      const client = needWorker(svc);
      let r: ContextResult;
      try {
        r = await client.call<ContextResult>('log.context', {
          id, before: intOf(b.before, 'before', 0, 50), after: intOf(b.after, 'after', 0, 50), includeSelfHarm: c.can('wellbeing'), withOriginal: false,
        }, { timeoutMs: 30_000, signal: c.signal });
      } catch (e) { return workerFail(e); }
      if (!r.anchor) throw new HttpError(404, 'No such line.');
      // §5.5: context views are always audited (a wellbeing line's without its name).
      const who = r.anchor.display === 'withheld' || r.anchor.tags.includes(TAG_SELF_HARM) ? null : { accountId: r.anchor.accountId, name: r.anchor.name };
      svc.audit(c.actor, 'view', who, `chat log context of line #${id}`);
      return [200, { ok: true, anchor: r.anchor, before: r.before, after: r.after, scope: r.scope, moreBefore: r.moreBefore, moreAfter: r.moreAfter }];
    },

    'log/rooms': async (b, c): Promise<AdminReply> => {
      const client = needWorker(svc);
      let r: { rooms: LogRoom[] };
      try {
        r = await client.call<{ rooms: LogRoom[] }>('log.rooms', {
          since: timeArg(b.since, c, 'since'), until: timeArg(b.until, c, 'until'), limit: intOf(b.limit, 'limit', 1, 1000),
        }, { timeoutMs: 30_000, signal: c.signal });
      } catch (e) { return workerFail(e); }
      svc.auditRead(c.actor, 'api log rooms');
      return [200, { ok: true, rooms: r.rooms }];
    },

    'log/reveal': async (b, c): Promise<AdminReply> => {
      const client = needWorker(svc);
      let args: Record<string, unknown>;
      if (b.ids !== undefined) {
        if (!Array.isArray(b.ids) || b.ids.length < 1 || b.ids.length > 100 || b.ids.some((x) => !Number.isInteger(x))) throw bad('ids must be 1 to 100 line ids');
        args = { ids: b.ids };
      } else {
        const accountId = str(b.accountId, 64, 'accountId');
        if (!accountId) throw bad('Pass ids, or an accountId');
        args = { accountId, since: timeArg(b.since, c, 'since'), until: timeArg(b.until, c, 'until'), before: intOf(b.before, 'before', 1, Number.MAX_SAFE_INTEGER) };
      }
      let r: { originals: { id: number; original: string }[]; nextBefore: number | null };
      try {
        r = await client.call('log.reveal', { ...args, includeSelfHarm: c.can('wellbeing') }, { timeoutMs: 30_000, signal: c.signal });
      } catch (e) { return workerFail(e); }
      // Every reveal is audited, never coalesced (§5.5, T-ADM-11).
      svc.audit(c.actor, 'reveal', typeof args.accountId === 'string' ? { accountId: args.accountId } : null,
        `revealed the original text of ${r.originals.length} chat line(s)${Array.isArray(args.ids) ? `: #${(args.ids as number[]).slice(0, 20).join(', #')}${(args.ids as number[]).length > 20 ? ', …' : ''}` : ' of one student'}`);
      return [200, { ok: true, originals: r.originals, nextBefore: r.nextBefore }];
    },

    'alerts/list': async (b): Promise<AdminReply> => {
      const includeAcked = boolOf(b.includeAcked, 'includeAcked') !== false;
      try { await svc.resolveAlerts(); } catch { /* the chat ids come at the next call */ }
      return [200, { ok: true, alerts: svc.alertsList({ includeAcked }), counts: svc.alertCounts() }];
    },

    'alerts/ack': async (b, c): Promise<AdminReply> => {
      const id = intOf(b.id, 'id', 1, Number.MAX_SAFE_INTEGER);
      if (id === undefined) throw bad('id is required');
      if (svc.alertKind(id) === 'wellbeing') c.require('wellbeing');
      const r = await svc.ackAlert(id, c.actor, str(b.note, 500, 'note') ?? null);
      if (!r.ok) return replyOf(r);
      return [200, { ok: true, alert: r.alert }];
    },
  };
}
