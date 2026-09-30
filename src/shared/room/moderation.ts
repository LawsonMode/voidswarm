// OWNER: ROOM agent (moderation seam). Chat / name moderation for the Zone and its Rooms.
//
// Two layers:
//  1. The shared word filter (`../moderation/filter`: filterChat / checkName / isSpam). It is pure TS, so it runs in
//     BOTH hosts: the Node server and the browser's offline Zone. Every human chat line (zone + room, all + team) and
//     every human-chosen name (guest callsign, /name, room names) goes through it.
//  2. An optional ModerationHook (ZoneOptions.moderation) that a host injects. The Node server's implementation
//     (src/server/moderation/service.ts) logs every line to SQLite, enforces mutes, counts strikes (auto-mute),
//     answers moderator chat commands and files /report. Offline there is no hook: filter only, nothing is logged.
//
// v0.6 (LAN edition, docs/LAN-EDITION-proposal.md §5.6-§5.8): every log entry carries `roomUid` (room identity across
// restarts) and `display` (what the others saw); filtered lines get TAGS (A1: PROFANITY, VULGAR, HATE, THREAT,
// SELF-HARM, GANG, or a host custom label); a blocked / masked line is replaced for everyone else by a positive line
// and the sender gets a generic private warning that escalates (A2); a self-harm statement is withheld with a kind
// note (MSG_CARE, with 988) and never punished; host announcements are logged on the 'announce' channel; a few
// callsigns (Host, Teacher, Admin, ...) are reserved.
//
// No DOM and no Node APIs here (shared code).
import type { PlayerId } from '../types';
import { nameKey } from './util';

/** What happened to one chat line (or one name attempt). */
export type ChatAction =
  /** shown as typed */
  | 'pass'
  /**
   * shown as typed (a name: allowed), but a host's review-only custom term matched: logged for a moderator to look
   * at (hits "flag:<category>:<term>"), with no strike and no mute
   */
  | 'flag'
  /** shown with the offending words starred out */
  | 'mask'
  /** not shown: language (the sender gets a private notice and a strike) */
  | 'block'
  /** not shown: repeat flood */
  | 'spam'
  /** not shown: the sender is muted */
  | 'muted';

/**
 * Log channel: the chat channel of a line; 'name' / 'room' for a callsign / room name — a refused attempt
 * (action 'block', original = the attempted name, shown = ''), an accepted guest callsign (joining name, /name) or
 * room name (create, rename) (v0.6: action 'pass', shown = the name), or an allowed one that a review-only custom term
 * flagged (action 'flag', shown = the name); 'announce' (v0.6) for a host announcement (Zone.announce).
 */
export type LogChannel = 'all' | 'team' | 'name' | 'room' | 'announce';

/**
 * v0.6 (§5.8): what the others saw of a logged line (chat_log.display). `action` stays the filter's verdict (block,
 * mask, ...) so severity is still queryable; `display` says how the line reached everyone else.
 */
export type ChatDisplay =
  /** the line as written (display taming aside) */
  | 'as-typed'
  /** starred words (substitution off: ZoneChatOptions.substitute 'masked') */
  | 'masked'
  /** a positive line under the sender's name (`shown` = that line) */
  | 'substituted'
  /** the positive line as a system line (`shown` = that line) */
  | 'system'
  /** nothing (substitute 'hide', a blocked line with substitution off, a muted / flood / filter-error line) */
  | 'hidden'
  /** a self-harm statement: never shown, never replaced with a cheerful line */
  | 'withheld';

/** One chat-log entry (ModerationHook.logChat). `roomId` null = the zone lobby (Command screen chat). */
export interface ChatLogEntry {
  time: number;
  roomId: string | null;
  roomName: string;
  channel: LogChannel;
  /** team of the sender (NO_TEAM = -1 in the lobby / FFA) */
  team: number;
  playerId: PlayerId;
  name: string;
  accountId: string | null;
  address: string | null;
  original: string;
  /** what the others saw ('' when nothing was shown) */
  shown: string;
  action: ChatAction;
  hits: string[];
  /**
   * v0.6 (§5.7): `${bootId}:${roomId}` for a room, `${bootId}:zone` for the zone lobby, null for a zone-wide
   * announcement (not one room). Keeps "by room" and the context drawer right across restarts (roomIds restart at r1).
   * Always set by the Zone; optional only so pre-0.6 producers (older tests, tools) still type-check.
   */
  roomUid?: string | null;
  /** v0.6 (§5.8): what the others saw. Always set by the Zone; absent = 'as-typed' (pre-0.6 rows). */
  display?: ChatDisplay;
}

/** The identity a hook sees for a connected pilot. */
export interface ModUser {
  playerId: PlayerId;
  /** current callsign */
  name: string;
  /** null = guest */
  accountId: string | null;
  /** account username (null = guest) */
  username: string | null;
  /** rate-limit key of the client's address (IPv4 or IPv6 /64); null offline / unknown */
  address: string | null;
}

/** A connected pilot as the server's moderation sees it (Zone.onlinePilots). */
export interface OnlinePilot extends ModUser {
  /** null = in the zone lobby */
  roomId: string | null;
  roomName: string | null;
}

/** An active mute: `until` epoch ms, null = permanent. */
export interface MuteInfo { until: number | null; reason: string }

/**
 * Why ModerationHook.onStrike is called: a blocked or (v0.6, with substitution on) masked chat line ('language'), a
 * threat ('threat': a strike, and moderators should hear about it at once — v0.6 also sends ModerationHook.alert), a
 * refused name with a slur / hate / sexual term in it ('name'; a name refused only for profanity is logged but is not
 * a strike). 'selfharm' is kept for older hosts only: since v0.6 the Zone never calls onStrike for a self-harm
 * statement (it is never an offence); it calls ModerationHook.alert(user, 'selfharm', entry) instead.
 */
export type StrikeReason = 'language' | 'threat' | 'name' | 'selfharm';

/** v0.6: what the Zone tells the hook about a strike (the host's per-tag policy decides whether it counts). */
export interface StrikeDetail {
  /** the enforced (block / mask tier) tags of the line or name, deduped (tagsOf) — SELF-HARM never appears here */
  tags: string[];
  /** the filter's verdict for the line ('block' for a refused name) */
  action: 'block' | 'mask';
}

/**
 * v0.6: ModerationHook.strikeStatus — where a pilot stands right after onStrike, so the Zone can pick the escalating
 * private warning (§5.8): 1st, 2nd, "one more and your chat will be muted" at `limit - 1`, then the auto-mute notice.
 */
export interface StrikeStatus {
  /** strikes in the window after the last one; 0 = the host's tag policy didn't count that line */
  count: number;
  /** the strike count that auto-mutes (0 = never) */
  limit: number;
}

/** Is `v` a usable StrikeStatus? */
export function isStrikeStatus(v: unknown): v is StrikeStatus {
  if (!v || typeof v !== 'object') return false;
  const o = v as StrikeStatus;
  return typeof o.count === 'number' && Number.isFinite(o.count) && typeof o.limit === 'number' && Number.isFinite(o.limit);
}

export interface ReportContext { roomId: string | null; roomName: string }

/** Private reply lines for the caller (sync or async). */
export type ReplyLines = string[] | Promise<string[]>;

/**
 * v0.3.x moderation hook (ZoneOptions.moderation). Every method is called synchronously from the Zone's message
 * handling, so implementations must be cheap (no blocking I/O: logChat only buffers). A throwing method is logged
 * and treated as "no effect" — except that a failing filter blocks the line (fail closed).
 */
export interface ModerationHook {
  /** Every human chat line and refused name attempt, after the filter ran. Must only buffer (never block). */
  logChat(entry: ChatLogEntry): void;
  /** The pilot's active mute, or null. Checked before every chat line is broadcast. */
  isMuted(user: ModUser): MuteInfo | null;
  /**
   * A line was blocked (v0.6: or masked, with substitution on) for language, or an offensive name refused. Returns an
   * optional private notice for the pilot, e.g. when this strike triggered an automatic mute. `detail` (v0.6) carries
   * the line's tags so the host can apply its per-tag policy (strike, autoMuteAfter).
   * v0.6 with strikeStatus: a notice REPLACES the Zone's generic warning, so return one only for the auto-mute (the
   * Zone says "one more ..." itself at limit − 1). Without strikeStatus a notice follows the Zone's own warning.
   */
  onStrike(user: ModUser, reason: StrikeReason, detail?: StrikeDetail): string | null | void;
  /**
   * Optional (v0.6): the pilot's strike count and limit right after onStrike (count 0 = the host's tag policy didn't
   * count that line). With it the Zone escalates the warning on the host's own count; without it (offline, older
   * hosts) the Zone counts warned lines itself for WARN_WINDOW_MS and knows no limit.
   */
  strikeStatus?(user: ModUser): StrikeStatus | null;
  /** Server-side moderator check. Non-moderators never learn that the moderator commands exist. */
  isAdmin(user: ModUser): boolean;
  /** A moderator chat command (`cmd` lowercased, without the slash; `args` split on whitespace). */
  adminCommand(user: ModUser, cmd: string, args: string[]): ReplyLines;
  /** `/report <target> <reason>` from any pilot. */
  report(reporter: ModUser, target: string, reason: string, ctx: ReportContext): ReplyLines;
  /**
   * Optional (v0.4): a line read as a self-harm statement or a threat. v0.4 sent it only for lines withheld anyway
   * (muted / repeat flood); since v0.6 it is sent for EVERY such line — a withheld self-harm statement (never a strike),
   * a substituted threat (also a strike), a muted or flood line — so the host can raise its urgent alert (§5.8, §5.11).
   * `entry` (v0.6) is the same object just passed to logChat, so the host can tie the alert to its chat-log row.
   */
  alert?(user: ModUser, kind: AlertKind, entry?: ChatLogEntry): void;
}

/** What ModerationHook.alert is about. */
export type AlertKind = 'selfharm' | 'threat';

/** Chat commands that exist only for moderators (anyone else gets the ordinary "Unknown command" line). */
export const MOD_COMMANDS: ReadonlySet<string> = new Set([
  'ban', 'ipban', 'mute', 'unmute', 'unban', 'kick', 'warn', 'log', 'reports', 'whois', 'confirm', 'modhelp',
]);

/** The player command every pilot has. */
export const REPORT_COMMAND = 'report';

/** The sender's notice for a blocked line with substitution OFF (ZoneChatOptions.substitute 'masked'; v0.5 behaviour). */
export const MSG_BLOCKED = 'Message blocked (language).';
/** The support part of every kind note (MSG_CARE, MSG_CARE_NAME): a trusted adult, and the US 988 line. */
export const CARE_SUPPORT = "If you're having a hard time, please talk to a teacher or another adult you trust. In the US you can call or text 988.";
/**
 * The sender's kind note for a self-harm statement (withheld, never a strike, never replaced with a cheerful line;
 * the host gets an urgent wellbeing alert). v0.6 adds the US 988 line.
 */
export const MSG_CARE = `Message not sent. ${CARE_SUPPORT}`;
/**
 * v0.6: the kind note for a callsign or room name read as a self-harm statement. The name is not used (a guest
 * joining under it flies as a generated callsign), it is never a strike, and the host gets the wellbeing alert.
 */
export const MSG_CARE_NAME = `That name wasn't used. ${CARE_SUPPORT}`;
export const MSG_SPAM = "Message not sent — please don't repeat the same thing.";
/** A line the filter could not check (it threw): not shown (fail closed), no strike — it was not the pilot's fault. */
export const MSG_NOT_SENT = 'Message not sent — please try again.';

// --- v0.6 (A2): the sender's private warnings for a substituted line. They never name the words, the category or
// the tag. warningText() picks one from the strike count and limit. ---
/** 1st warning. */
export const MSG_WARN_FIRST = "That message used inappropriate language and wasn't shared. Keep chat friendly!";
/** 2nd warning. */
export const MSG_WARN_SECOND = "Second warning — that message wasn't shared either.";
/** 3rd and later warnings (only with a strike limit above 3, or offline where there is no mute). */
export const MSG_WARN_AGAIN = "Another warning — that message wasn't shared either.";
/** Added to the warning at strike limit − 1. */
export const MSG_WARN_LAST = 'One more and your chat will be muted for a while.';
/** At the limit when the host gave no notice of its own (it normally answers with its auto-mute line). */
export const MSG_WARN_MUTED = 'That message wasn\'t shared, and your chat is muted for a while.';

/**
 * The generic private warning for the `n`th strike (1-based) against a strike `limit` (0 = no auto-mute known, e.g.
 * offline). 1 → MSG_WARN_FIRST, 2 → MSG_WARN_SECOND, later → MSG_WARN_AGAIN; at `limit - 1` MSG_WARN_LAST is added
 * (with the default limit of 3 that is the 2nd warning); at or past the limit MSG_WARN_MUTED.
 */
export function warningText(n: number, limit = 0): string {
  const k = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
  const lim = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (lim > 0 && k >= lim) return MSG_WARN_MUTED;
  const base = k === 1 ? MSG_WARN_FIRST : k === 2 ? MSG_WARN_SECOND : MSG_WARN_AGAIN;
  return lim > 1 && k === lim - 1 ? `${base} ${MSG_WARN_LAST}` : base;
}

// --- v0.6 (A2): substitution ---

/**
 * How everyone else sees a blocked or masked line (ZoneChatOptions.substitute; Settings key `chat.substitute`):
 * 'sender' (default; the owner's decision) a positive line under the sender's name; 'system' the positive line as a
 * system line; 'hide' nothing. 'masked' is the v0.5 behaviour (masked lines starred for everyone including the
 * sender, blocked lines withheld with MSG_BLOCKED, no warning for a masked line), kept as a test-only option for the
 * old assertions — not offered in the host's settings.
 */
export type SubstituteMode = 'sender' | 'system' | 'hide' | 'masked';
export const SUBSTITUTE_MODES: readonly SubstituteMode[] = ['sender', 'system', 'hide', 'masked'];

/** A positive line is at most this long. */
export const POSITIVE_LINE_MAX_LEN = 60;
/** At least this many positive lines are kept (Settings → Chat refuses a shorter list). */
export const POSITIVE_LINES_MIN = 5;
/** At most this many positive lines are kept. */
export const POSITIVE_LINES_MAX = 200;

/**
 * The curated PG positive lines (§5.8): each at most POSITIVE_LINE_MAX_LEN characters and passing the filter (pinned
 * by a test). Editable by the host (Zone.setChatOptions({ positiveLines })).
 */
export const DEFAULT_POSITIVE_LINES: readonly string[] = [
  'GG, pilots!', 'Great flying, everyone!', 'Nice teamwork out there!', 'Good luck, have fun!', 'What a match!',
  "You're all doing great!", 'Let\'s keep it friendly!', 'Nice moves!', 'Great game so far!', 'Stay sharp, pilots!',
  'That was awesome!', 'Good hustle, team!', 'Love this crew!', 'Having a great time!', 'Well played, everyone!',
  'Keep it up, pilots!', 'Fly safe out there!', 'This is so much fun!', 'Great effort, all!', 'Onward, pilots!',
  'Teamwork makes the dream work!', 'High five, everyone!', 'What a comeback!', 'Nice save!', 'Awesome flying!',
  'Loving these matches!', 'Cheers, pilots!', "Everyone's playing great!", "Let's go, team!", 'Good vibes only!',
  'Respect to all pilots!', 'That was close!', 'Brilliant play!', 'See you among the stars!', 'The stars look bright today!',
  'Ready for the next round!', 'Thanks for the game!', 'Nice work, everybody!', 'Smooth flying!', 'Great sportsmanship!',
];

/** Zone.setChatOptions / ZoneOptions.chat (§5.13 Settings → Chat; applied live). */
export interface ZoneChatOptions {
  substitute: SubstituteMode;
  positiveLines: readonly string[];
  /** Word-filter strictness (chat and names). 'strict' is the classroom default. */
  strictness: 'strict' | 'standard';
}

/** A positive line the host's list could not use, and why (never the matched term). */
export interface RejectedLine { line: string; why: string }

/** Zone.setChatOptions result. On `ok: false` nothing changed. */
export type ChatOptionsResult =
  | { ok: true; options: ZoneChatOptions; rejected: RejectedLine[] }
  | { ok: false; error: string; rejected: RejectedLine[] };

// --- v0.6 (A1): tags ---

/** A tag (§5.8): the built-in ones, or a host custom category under its own upper-case label ("BULLYING"). */
export type ChatTag = 'PROFANITY' | 'VULGAR' | 'HATE' | 'THREAT' | 'SELF-HARM' | 'GANG' | (string & {});
export const TAG_PROFANITY = 'PROFANITY';
export const TAG_VULGAR = 'VULGAR';
export const TAG_HATE = 'HATE';
export const TAG_THREAT = 'THREAT';
export const TAG_SELF_HARM = 'SELF-HARM';
export const TAG_GANG = 'GANG';
/** The built-in tags, most severe first (wellbeing first: it needs the host's attention, never a punishment). */
export const BUILTIN_TAGS: readonly ChatTag[] = [TAG_SELF_HARM, TAG_THREAT, TAG_HATE, TAG_VULGAR, TAG_PROFANITY, TAG_GANG];

/**
 * Category → tag. Built-in categories (lists.ts) and the host's custom categories of the same spelling share it
 * (custom.ts already folds "Self-Harm" / "Threats" to 'selfharm' / 'threat'); 'gang' is the custom GANG category.
 * Any other custom category becomes its own upper-case label.
 */
const CATEGORY_TAGS: Readonly<Record<string, ChatTag>> = {
  profanity: TAG_PROFANITY, mild: TAG_PROFANITY, sexual: TAG_VULGAR, vulgar: TAG_VULGAR, slur: TAG_HATE, hate: TAG_HATE,
  threat: TAG_THREAT, selfharm: TAG_SELF_HARM, gang: TAG_GANG,
};

/** The tag of one filter category ('' / unusable → 'CUSTOM'). */
export function tagOfCategory(category: string): ChatTag {
  const c = String(category).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CATEGORY_TAGS, c)) return CATEGORY_TAGS[c]!;
  // A host's custom category spelled "self harm", "self_harm" or "Self-Harm" is the wellbeing tag, never a strike tag.
  const folded = c.replace(/[\s_-]+/g, '');
  if (Object.prototype.hasOwnProperty.call(CATEGORY_TAGS, folded)) return CATEGORY_TAGS[folded]!;
  const label = c.replace(/[^a-z0-9 _-]/g, '').replace(/[\s_]+/g, ' ').trim().toUpperCase().slice(0, 24);
  return label || 'CUSTOM';
}

/** The category of one hit: a FilterHit-like object, or a log label ("cat:term", "custom:cat:term", "flag:cat:term"). */
function categoryOfHit(h: unknown): string | null {
  if (h && typeof h === 'object') {
    const c = (h as { category?: unknown }).category;
    return typeof c === 'string' ? c : null;
  }
  if (typeof h !== 'string') return null;
  let s = h;
  let custom = false;
  if (s.startsWith(CUSTOM_HIT_PREFIX)) { s = s.slice(CUSTOM_HIT_PREFIX.length); custom = true; }
  else if (s.startsWith(FLAG_HIT_PREFIX)) { s = s.slice(FLAG_HIT_PREFIX.length); custom = true; }
  const i = s.indexOf(':');
  if (custom) return i >= 0 ? s.slice(0, i) : ''; // "custom:<term>" without a category → CUSTOM
  return i > 0 ? s.slice(0, i) : null; // no "category:" = not a filter hit ('filter-error', 'reserved', a reason)
}

/**
 * The tags of a line's hits (FilterHit objects or log labels, as in ChatLogEntry.hits), deduped — one tag per
 * category per line, so a store counting `tagsOf(entry.hits)` increments conduct_daily once per tag per line —
 * in first-seen order (the filter reports the most severe hits first). Labels that are not filter hits
 * ('filter-error', 'reserved', a refusal reason) give no tag. Review-only ('flag:') hits give their tag too; the
 * line's `action` 'flag' says they are for review only.
 */
export function tagsOf(hits: unknown): ChatTag[] {
  if (!Array.isArray(hits)) return [];
  const out: ChatTag[] = [];
  for (const h of hits) {
    const c = categoryOfHit(h);
    if (c === null) continue;
    const t = tagOfCategory(c);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** Tags of the hits that act on the line (block / mask tier; plain labels count), i.e. not the review-only ones. */
export function enforcedTagsOf(hits: unknown): ChatTag[] {
  if (!Array.isArray(hits)) return [];
  return tagsOf(hits.filter((h) => (h && typeof h === 'object'
    ? (h as { tier?: unknown }).tier !== 'flag'
    : typeof h === 'string' && !h.startsWith(FLAG_HIT_PREFIX))));
}

// --- v0.6 (§4.1, §5.6): reserved callsigns ---

/**
 * Callsigns nobody may fly under (guests; account registration should refuse them too), with their look-alikes:
 * "H0st", "Teach3r", "ADMIN_2", "Host-PC". A player can't pose as the host whose announcements read "[Host] ...".
 */
export const RESERVED_CALLSIGNS: readonly string[] = ['Host', 'Host PC', 'Teacher', 'Admin', 'Administrator', 'Moderator', 'Mod', 'System', 'Server'];
export const MSG_NAME_RESERVED = 'That callsign is reserved — pick another.';

const LEET: Readonly<Record<string, string>> = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g' };

/**
 * Comparison key for reserved callsigns: nameKey (case, accents, Cyrillic / Greek look-alikes), then separators
 * dropped, a trailing number dropped ("Host2", "Admin_007"), then leet digits read as letters ("H0st", "5erver").
 */
export function reservedKey(name: string): string {
  return reservedKeys(name)[0] ?? '';
}

const unleet = (s: string): string => s.replace(/[0-9]/g, (d) => LEET[d] ?? '').replace(/[^a-z]/g, '');

/**
 * Every comparison key a name may stand for: reservedKey first, then the same with 1, 2, ... of the trailing digits
 * kept and read as leet letters — a trailing digit is either a number ("Host2") or a letter ("Hos7", "H057" = Host).
 * Empty keys are left out.
 */
export function reservedKeys(name: string): string[] {
  const k = nameKey(typeof name === 'string' ? name.slice(0, 64) : '').replace(/[^a-z0-9]/g, '');
  const m = /\d+$/.exec(k);
  const head = m ? k.slice(0, m.index) : k;
  const tail = m ? m[0] : '';
  const out: string[] = [];
  for (let i = 0; i <= tail.length; i++) {
    const c = unleet(head + tail.slice(0, i));
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

const RESERVED_KEYS: ReadonlySet<string> = new Set(RESERVED_CALLSIGNS.map(reservedKey));

/**
 * Is `name` a reserved callsign (RESERVED_CALLSIGNS, or one of `extra` — e.g. the host admin's username)? Both
 * sides are read every way reservedKeys allows, so an extra name ending in a leet digit reserves its letter reading
 * too ("Jone5" reserves "Jones", as "Jones" reserves "Jone5").
 */
export function isReservedCallsign(name: string, extra?: Iterable<string>): boolean {
  const keys = reservedKeys(name);
  if (!keys.length) return false;
  if (keys.some((k) => RESERVED_KEYS.has(k))) return true;
  if (extra) {
    for (const e of extra) {
      if (reservedKeys(e).some((ek) => keys.includes(ek))) return true;
    }
  }
  return false;
}

/**
 * v0.6 (§5.8): who sent a chat line, across reconnects — `a:<accountId>` for an account, else `g:<nameKey(callsign)>`.
 * A substitute is kept out of its sender's chat history by this key as well as by playerId (a reconnect gets a new
 * playerId, so the sender would otherwise see their own substitute in the history).
 */
export function chatSenderKey(u: { account: { accountId: string } | null; name: string }): string {
  return u.account ? `a:${u.account.accountId}` : `g:${nameKey(u.name)}`;
}

// --- v0.6 (§5.6): announcements ---

/** A host announcement is a system line "[Host] <text>". */
export const ANNOUNCE_PREFIX = '[Host] ';
/** Longest announcement text (the admin API's `text: 1..200`). */
export const ANNOUNCE_MAX_LEN = 200;
/** Log room name of a zone-wide announcement (roomId null, roomUid null). */
export const ANNOUNCE_ALL_ROOM_NAME = 'All rooms';
/** Log name of the host as the "sender" of an announcement (playerId 0). */
export const ANNOUNCE_SENDER_NAME = 'Host';

/** Zone.announce result: `delivered` = pilots who received it. */
export type AnnounceResult = { ok: true; delivered: number; roomId: string | null } | { ok: false; error: string };
export const MSG_NAME_REFUSED = "That callsign isn't allowed here — pick another.";
export const MSG_ROOM_NAME_REFUSED = "That room name isn't allowed — pick another.";
export const MSG_REPORT_OFFLINE = 'Reports go to the moderators of an online server (not available offline).';
export const MSG_REPORT_USAGE = 'Usage: /report <name> <reason>';

/** Recent lines kept per pilot for the repeat-flood check. */
export const SPAM_RECENT_MAX = 8;
/** ...and for how long (ms). */
export const SPAM_RECENT_MS = 60_000;

/** Log-label prefix of a host custom term's block / mask hit: "custom:<category>:<term>". */
export const CUSTOM_HIT_PREFIX = 'custom:';
/** Log-label prefix of a review-only ('flag') hit: "flag:<category>:<term>" (custom terms only). */
export const FLAG_HIT_PREFIX = 'flag:';

/**
 * One filter hit as a log label: "category:term" for the built-in lists; "custom:category:term" for a host custom
 * term's block / mask hit and "flag:category:term" for a review-only hit (FilterHit.source === 'custom'). Built-in
 * categories are never 'custom' or 'flag', so the first segment tells the three apart. A plain string hit is kept
 * as is.
 */
export function hitLabel(h: unknown): string {
  if (h && typeof h === 'object') {
    const o = h as { category?: unknown; term?: unknown; source?: unknown; tier?: unknown };
    if (typeof o.term === 'string') {
      const base = typeof o.category === 'string' ? `${o.category}:${o.term}` : o.term;
      if (o.tier === 'flag') return `${FLAG_HIT_PREFIX}${base}`;
      return o.source === 'custom' ? `${CUSTOM_HIT_PREFIX}${base}` : base;
    }
  }
  return String(h);
}

/** Categories of the block-tier hits of a filter result (FilterHit.tier === 'block'). */
export function blockCategories(hits: unknown): string[] {
  if (!Array.isArray(hits)) return [];
  const out: string[] = [];
  for (const h of hits) {
    if (!h || typeof h !== 'object') continue;
    const o = h as { tier?: unknown; category?: unknown };
    if (o.tier === 'block' && typeof o.category === 'string') out.push(o.category);
  }
  return out;
}

/** Short, unambiguous date-time for chat lines ("Sep 28, 2026, 2:05 PM"); the host's local time zone. */
export function formatWhen(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return 'later';
  try {
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
}

/** "You are muted until …: reason." / "You are muted: reason." (permanent). */
export function mutedMessage(m: MuteInfo): string {
  const why = m.reason ? `: ${m.reason}` : '';
  return m.until === null ? `You are muted${why}.` : `You are muted until ${formatWhen(m.until)}${why}.`;
}

/** "You are banned until …: reason" / "You are banned: reason" (permanent). */
export function bannedMessage(until: number | null, reason: string): string {
  const why = reason ? `: ${reason}` : '';
  return until === null ? `You are banned${why}` : `You are banned until ${formatWhen(until)}${why}`;
}
