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
// No DOM and no Node APIs here (shared code).
import type { PlayerId } from '../types';

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
 * Log channel: the chat channel of a line, or 'name' / 'room' for a refused callsign / room name attempt
 * (original = the attempted name, shown = '') — or an ALLOWED one that a review-only custom term flagged
 * (action 'flag', shown = the name).
 */
export type LogChannel = 'all' | 'team' | 'name' | 'room';

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
 * Why ModerationHook.onStrike is called: a blocked chat line ('language'), a blocked threat ('threat': a strike, and
 * moderators should hear about it at once), a refused name with a slur / hate / sexual term in it ('name'; a name
 * refused only for profanity is logged but is not a strike), or a blocked line that reads as a
 * self-harm statement ('selfharm': NOT a strike — the host should alert a moderator instead of punishing).
 */
export type StrikeReason = 'language' | 'threat' | 'name' | 'selfharm';

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
   * A line was blocked for language (or an offensive name refused). Returns an optional private notice for the
   * pilot, e.g. when this strike triggered an automatic mute.
   */
  onStrike(user: ModUser, reason: StrikeReason): string | null | void;
  /** Server-side moderator check. Non-moderators never learn that the moderator commands exist. */
  isAdmin(user: ModUser): boolean;
  /** A moderator chat command (`cmd` lowercased, without the slash; `args` split on whitespace). */
  adminCommand(user: ModUser, cmd: string, args: string[]): ReplyLines;
  /** `/report <target> <reason>` from any pilot. */
  report(reporter: ModUser, target: string, reason: string, ctx: ReportContext): ReplyLines;
  /**
   * Optional (v0.4): a line that was withheld anyway — the pilot is muted, or it was a repeat flood — read as a
   * self-harm statement or a threat. Not a strike; the host should make sure a moderator hears about it.
   */
  alert?(user: ModUser, kind: AlertKind): void;
}

/** What ModerationHook.alert is about. */
export type AlertKind = 'selfharm' | 'threat';

/** Chat commands that exist only for moderators (anyone else gets the ordinary "Unknown command" line). */
export const MOD_COMMANDS: ReadonlySet<string> = new Set([
  'ban', 'ipban', 'mute', 'unmute', 'unban', 'kick', 'warn', 'log', 'reports', 'whois', 'confirm', 'modhelp',
]);

/** The player command every pilot has. */
export const REPORT_COMMAND = 'report';

export const MSG_BLOCKED = 'Message blocked (language).';
/** Sent instead of MSG_BLOCKED when the only reason is a self-harm statement (no strike). */
export const MSG_CARE = "Message not sent. If you're having a hard time, please talk to a teacher or another adult you trust.";
export const MSG_SPAM = "Message not sent — please don't repeat the same thing.";
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
