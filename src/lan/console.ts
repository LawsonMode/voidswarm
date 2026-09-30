// LAN edition: the quiet console and the redacted host log (docs/LAN-EDITION-proposal.md §5.1, §6.4, T-LAN-10).
//
// Two processes, one rule: nothing the game depends on ever waits for the console window.
//  - The CHILD (the server) never writes to its stdio. installChildLogging() sends every log line, and anything
//    printed with console.*, to data\logs\host-YYYY-MM-DD.log, written asynchronously. Measured on Windows (Node
//    24.16): a write to a child's stdout PIPE is synchronous, so a parent that stops reading (its own console write
//    held by a QuickEdit selection) stalls the child's event loop for as long as the selection lasts (2.5 s of
//    parent stall = a 2.5 s gap in the child's loop). IPC sends stay asynchronous (worst gap 36 ms under load).
//  - The PARENT (the launcher) prints the banner once, then only fatal errors and rare one-line notices
//    (HostConsole). A QuickEdit selection can then pause only the parent's own output, never the game.
//
// Log hygiene (both presets; §5.1): no chat text, no names, no room names, no wellbeing lines, no tokens, codes or
// links. Players appear as #<playerId> and rooms as r<id>; connect lines keep ip:port. The server's log lines were
// written for a console, so redactLogLine() rewrites the known shapes that carry a name, a room name or free text,
// drops the wellbeing lines, and scrubs links, emails, tokens and codes from everything else. A room's name is
// mapped to its id from the "room open: <name> (r<id>, …)" line (the Redactor keeps that map).
//
// Files: host-YYYY-MM-DD.log (local date), rotated daily, kept LOG_RETAIN_DAYS days. Parent and child append to the
// same file (each write is one whole line, opened for append). The parent's own lines carry "[launcher]".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { format } from 'node:util';
import { consoleSafe, noticeLine } from './banner';

export const LOG_FILE_PREFIX = 'host-';
export const LOG_FILE_SUFFIX = '.log';
/** Host logs are kept this many days (§5.1). */
export const LOG_RETAIN_DAYS = 14;
/** Lines waiting for the disk beyond this are dropped, oldest first (a stalled disk must not grow memory). */
export const LOG_MAX_PENDING_BYTES = 2 * 1024 * 1024;
/** A single logged line is cut here (a stack trace keeps its first lines). */
export const LOG_MAX_LINE_CHARS = 8 * 1024;
/** Retry delay after a failed write (disk full, antivirus lock). */
const RETRY_MS = 1000;

// ------------------------------------------------------------------------------------------
// Redaction
// ------------------------------------------------------------------------------------------

/**
 * Tags the server puts in front of its lines (always lower case). A room's name is the player's choice, so a room
 * can be called "Zone", "auth" or even "mod] x": the BODY of a bracketed line decides whether it is a room line
 * (ROOM_JOIN_RE / ROOM_BODY_RE), and only then the tag. Anything else in leading brackets is a room name too.
 */
const KNOWN_TAGS = new Set([
  'auth', 'mod', 'profile', 'profiles', 'settings', 'launcher', 'server', 'maint', 'backup', 'tls', 'net', 'admin', 'db',
  'lan', 'mail', 'setup', 'restore', 'update', 'import', 'preflight', 'netwatch', 'worker', 'room', 'zone',
]);

/** Room.ts: "[<room>] + Alice (3 humans)" / "[<room>] - Alice (2 humans)". */
const ROOM_JOIN_RE = /^([+-]) .+ \((\d+) humans?\)$/;
/** Room.ts's other lines, after "[<room>] " (none of them carries a name). */
const ROOM_BODY_RE = new RegExp('^(?:'
  + '(?:cosmetics unavailable|loot grant failed|takeCarried failed|onFloorChange failed|sim call failed|tick error): '
  + '|(?:leave grant|no grant for) '
  + '|match (?:start seed=|end winnerTeam=|stopped: no humans for )'
  + '|settings reset to defaults \\(room empty\\)$'
  + ')');
const isRoomBody = (body: string): boolean => ROOM_JOIN_RE.test(body) || ROOM_BODY_RE.test(body);
/** Room names remembered at most (a room that never logs "room closed" must not grow memory for ever). */
const MAX_ROOMS = 4096;
/** Control characters other than \n and \t never reach the log file (it may be printed in a console later). */
const LOG_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Lines never logged in LAN mode: wellbeing (self-harm) lines, and anything that carries a reset link. */
const DROP_PATTERNS: readonly RegExp[] = [
  /self[\s-]?harm/i,
  /\bwellbeing\b/i,
  /\bsuicid/i,
  /\[auth\] DEV reset link/i,
];
/**
 * A stack frame Node printed ("    at isSelfHarmRow (file:///C:/…/server.mjs:4242:9)"). Its function name is code, not
 * user data, so DROP_PATTERNS skip it: a crash whose stack passes through such a function is still logged (the
 * supervisor's gave-up message points the host at data\logs). Strict shape: a location in parentheses, or a bare one.
 */
const STACK_FRAME_RE = /^\s+at (?:(?:async |new )?[\w$.<>[\]]+(?: \[as [\w$]+\])? \((?:file:\/\/\/|node:|[A-Za-z]:\\|\/)[^()\n]*\)|(?:async )?(?:file:\/\/\/|node:|[A-Za-z]:\\|\/)[^\s()]*)$/;
const dropLine = (line: string): boolean => !STACK_FRAME_RE.test(line) && DROP_PATTERNS.some((re) => re.test(line));

// Every pattern below runs on the server's game thread once installChildLogging is in place, on lines of up to
// LOG_MAX_LINE_CHARS: each must stay linear in the line's length. A match may start only where its run of characters
// starts (a lookbehind or \b), so a long unbroken run is scanned once, not once per position (console.test.ts times it).
const LINK_RE = /\b(?:https?|wss?|ftp):\/\/[^\s"'<>)\]]+/gi;
const EMAIL_RE = /(?<![A-Za-z0-9._%+*-])[A-Za-z0-9._%+*-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const BEARER_RE = /\bBearer\s+\S+/gi;
/**
 * key=value, key: value and JSON "key":"value" for secret-looking keys, also with a prefix (SMTP_PASS, MAIL_SMTP_PASSWORD).
 * Node's JSON.parse errors quote a snippet of their input, so a request body can reach a logged stack.
 */
const SECRET_KV_RE = /\b((?:[a-z0-9]+_)*(?:token|password|passwd|pass|pwd|passphrase|secret|pepper|cookie|authorization|apikey|api[_-]key))("?\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;
/** JSON keys in camelCase or ending in "key" ("apiKey", "smtpPass", "accessToken", "key"). */
const SECRET_JSON_RE = /"(\w*(?:key|token|secret|pass|password|pwd))"(\s*:\s*)("(?:[^"\\\n]|\\.)*"|[^\s,}\]]+)/gi;
/** Setup / reset codes: 8 Crockford base32 characters in two groups of four (K7QP-4MXD). */
const GROUPED_CODE_RE = /(?<![0-9A-Za-z-])[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}(?![0-9A-Za-z-])/gi;
/**
 * The same code written as one word next to the word "code" ("setup code K7QP4MXD", "code=K7QP4MXD", "code is …").
 * Upper case only (codes are minted upper case), so an ordinary lower-case word after "code" stays readable.
 */
const BARE_CODE_RE = /\b(code|CODE|Code)\b(\s{0,4}[:=#]?\s{0,4}(?:is\s{1,4})?["']?)([0-9A-HJKMNP-TV-Z]{8})(?![0-9A-Za-z])/g;
/** The longest "[<room name>] " a room line can start with (Room names are at most 32 characters; ROOM_NAME_MAX_LEN). */
const ROOM_TAG_MAX = 48;
/** Long hex (session hashes, keys) and long base64url (tokens). */
const LONG_HEX_RE = /\b[0-9a-f]{32,}\b/gi;
const LONG_B64_RE = /(?<![\w/\\.-])[A-Za-z0-9_-]{32,}={0,2}(?![\w/\\.-])/g;
/** Digits next to the word "code" (a 6-digit verification code), but never "exit code 2". */
const CODE_DIGITS_RE = /\b(code|otp|pin)\b([^\d\n]{0,16})(\d{4,10})\b/gi;

export interface RedactorOptions {
  /** The Windows account's home folder, replaced by %USERPROFILE% (default os.homedir()). '' = off. */
  homeDir?: string;
}

/**
 * Rewrites log lines for the host log. Stateful only for room names (room open → r<id>, room closed forgets it);
 * everything else is per line. Returns null for a line that must not be logged at all.
 */
export class Redactor {
  private readonly rooms = new Map<string, string>();
  /** The room names, longest first (a name may contain "] "; the longest match wins). null = rebuild. */
  private byLength: [string, string][] | null = null;
  private readonly homeRe: RegExp | null;

  constructor(opts: RedactorOptions = {}) {
    let home = opts.homeDir ?? safeHomedir();
    home = home.replace(/[\\/]+$/, '');
    this.homeRe = home.length >= 3 ? new RegExp(`${escapeRe(home).replace(/\\\\|\//g, '[\\\\/]')}(?![A-Za-z0-9_.-])`, 'gi') : null;
  }

  /** How many room names are mapped (tests). */
  get roomCount(): number { return this.rooms.size; }

  redact(input: string): string | null {
    if (typeof input !== 'string') input = String(input);
    let text = input.length > LOG_MAX_LINE_CHARS ? `${input.slice(0, LOG_MAX_LINE_CHARS)} …(cut)` : input;
    text = text.replace(/\r/g, '').replace(LOG_CONTROL_RE, '');
    if (!text.trim()) return null;
    // Every line of the entry is checked except Node's stack frames, whose function names are code.
    if (text.split('\n').some(dropLine)) return null;
    const nl = text.indexOf('\n');
    const first = nl < 0 ? text : text.slice(0, nl);
    const rest = nl < 0 ? '' : text.slice(nl);
    const shaped = this.shape(first);
    if (shaped === null) return null;
    return this.scrub(shaped + rest);
  }

  private roomRef(name: string): string {
    return this.rooms.get(name.trim()) ?? 'a room';
  }

  private learnRoom(name: string, id: string): void {
    this.rooms.delete(name);
    this.rooms.set(name, id);
    while (this.rooms.size > MAX_ROOMS) this.rooms.delete(this.rooms.keys().next().value!);
    this.byLength = null;
  }

  private forgetRoom(name: string): void {
    if (this.rooms.delete(name)) this.byLength = null;
  }

  /**
   * A line Room.ts wrote ("[<room>] <body>"), whatever the room is called: a room this log saw open, by its exact
   * name (longest first); otherwise the LAST "] " followed by a room body, so a crafted name stays inside the tag.
   * The room becomes r<id> (or "a room"), and a join / leave line loses the pilot's name. null: not a room line.
   */
  private roomLine(line: string): string | null {
    if (!this.byLength) this.byLength = [...this.rooms.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [name, id] of this.byLength) {
      if (line.length > name.length + 3 && line.startsWith(`[${name}] `)) {
        const body = line.slice(name.length + 3);
        if (isRoomBody(body)) return `[${id}] ${this.roomBody(body)}`;
      }
    }
    // Only a "] " within the longest possible room tag: a line with thousands of "] " must not be tested thousands of
    // times (each test scans the rest of the line).
    for (let i = line.lastIndexOf('] ', ROOM_TAG_MAX); i > 0; i = line.lastIndexOf('] ', i - 1)) {
      const body = line.slice(i + 2);
      if (isRoomBody(body)) return `[${this.roomRef(line.slice(1, i))}] ${this.roomBody(body)}`;
    }
    return null;
  }

  /** The known line shapes that carry a player name, a room name or free text. */
  private shape(line: string): string | null {
    let m: RegExpExecArray | null;

    // Zone: "+ Alice (#3, guest) — 4 online", "- Alice (#3) — 3 online"
    if ((m = /^\+ .+ \(#(\d+)(, account|, guest)?\) — (\d+) online$/.exec(line))) return `+ #${m[1]}${m[2] ?? ''} — ${m[3]} online`;
    if ((m = /^- .+ \(#(\d+)\) — (\d+) online$/.exec(line))) return `- #${m[1]} — ${m[2]} online`;

    // Zone: "room open: <name> (r3, arena/dm, ffa, bots 4, house)"
    if (line.startsWith('room open: ')) {
      const at = roomOpenParts(line.slice('room open: '.length));
      if (!at) return 'room open: a room';
      if (at.name.trim()) this.learnRoom(at.name.trim(), at.id);
      return `room open: ${at.id}${at.tail ? ` (${at.tail})` : ''}`;
    }
    if (line.startsWith('room closed: ')) {
      const name = line.slice('room closed: '.length).trim();
      const ref = this.roomRef(name);
      this.forgetRoom(name);
      return `room closed: ${ref}`;
    }
    if (line.startsWith('quick play overflow: ')) return `quick play overflow: ${this.roomRef(line.slice('quick play overflow: '.length))}`;
    if ((m = /^announcement to (.+) \((\d+ pilots?)\)$/.exec(line))) {
      return `announcement to ${m[1] === 'all rooms' ? 'all rooms' : this.roomRef(m[1])} (${m[2]})`;
    }
    if ((m = /^profile (attach|\w+) failed for .+ \(#(\d+)\): (.*)$/.exec(line))) return `profile ${m[1]} failed for #${m[2]}: ${m[3]}`;

    // Bracketed lines. Room lines first ("[<room name>] + Alice (3 humans)" and friends), by their body: a room may
    // be named like a tag ("Zone", "auth", "mod] x"). Then the server's own tags; anything else is a room too.
    if (line.startsWith('[')) {
      const room = this.roomLine(line);
      if (room !== null) return room;
      const close = line.indexOf('] ');
      if (close > 0) {
        const tag = line.slice(1, close);
        const body = line.slice(close + 2);
        if (tag === 'auth') return this.authLine(body);
        if (tag === 'mod') return this.modLine(body);
        if (!KNOWN_TAGS.has(tag)) return `[${this.roomRef(tag)}] ${body}`;
      }
    }
    return line;
  }

  private roomBody(body: string): string {
    let m: RegExpExecArray | null;
    if ((m = /^\+ .+ \((\d+) humans?\)$/.exec(body))) return `+ a pilot (${m[1]} humans)`;
    if ((m = /^- .+ \((\d+) humans?\)$/.exec(body))) return `- a pilot (${m[1]} humans)`;
    return body;
  }

  private authLine(body: string): string {
    let m: RegExpExecArray | null;
    if (/^registered /.test(body)) return '[auth] registered an account';
    if ((m = /^password reset for .+? (\(all other sessions revoked\))$/.exec(body))) return `[auth] password reset for an account ${m[1]}`;
    if (/^password reset for /.test(body)) return '[auth] password reset for an account';
    if (/^reset issued for /.test(body)) return '[auth] reset issued for an account';
    if (/^upgraded password hash for /.test(body)) return '[auth] upgraded password hash for an account';
    if ((m = /^password rehash for .+? failed: (.*)$/.exec(body))) return `[auth] password rehash for an account failed: ${m[1]}`;
    if ((m = /^reset mail to \S+ failed: ?(.*)$/.exec(body))) return `[auth] reset mail to an account failed: ${m[1]}`;
    if ((m = /^SMTP mail enabled via (\S+)( \(TLS\))?( as .+)?$/.exec(body))) return `[auth] SMTP mail enabled via ${m[1]}${m[2] ?? ''}`;
    return `[auth] ${body}`;
  }

  private modLine(body: string): string {
    let m: RegExpExecArray | null;
    if ((m = /^report #(\d+):/.exec(body))) return `[mod] report #${m[1]} filed`;
    if ((m = /^refused sign-in of .+ \(ban #(\d+)\)$/.exec(body))) return `[mod] refused a sign-in (ban #${m[1]})`;
    if ((m = /^auto-mute of .+? (failed: .*|enforced in memory .*)$/.exec(body))) return `[mod] auto-mute of a pilot ${m[1]}`;
    if ((m = /^threat from .+ \(#(\d+)[^)]*\)(.*)$/.exec(body))) return `[mod] threat flagged (#${m[1]}, line withheld)${m[2].includes('chat log') ? ' — see the chat log' : ''}`;
    if ((m = /^admin API refused for .+ (\(not a moderator\))$/.exec(body))) return `[mod] admin API refused for an account ${m[1]}`;
    // "<actor>: kick <target> — <reason>", "<actor>: ban <target> [scope] 1 day — <reason>", "<actor>: lifted #3, #4"
    if ((m = /^[^:[\]]{1,60}: (kick|ban|mute|warn|unban|unmute|lifted|promote|demote)\b(.*)$/.exec(body))) {
      const verb = m[1];
      if (verb === 'lifted') return `[mod] a moderator: lifted ${(m[2].match(/#\d+/g) ?? []).join(', ') || 'a ban'}`;
      const scope = /\[([a-z-]+)\]/.exec(m[2]);
      const dur = /\] ([^—]+?) —/.exec(m[2]);
      const kicked = /\((\d+) disconnected\)/.exec(m[2]);
      return `[mod] a moderator: ${verb} a pilot${scope ? ` [${scope[1]}]` : ''}${dur ? ` ${dur[1].trim()}` : ''}${kicked ? ` (${kicked[1]} disconnected)` : ''}`;
    }
    return `[mod] ${body}`;
  }

  /** Always: links, emails, tokens, codes, the account's home folder. */
  private scrub(s: string): string {
    let out = s;
    if (this.homeRe) out = out.replace(this.homeRe, '%USERPROFILE%');
    out = out
      .replace(LINK_RE, '<link>')
      .replace(EMAIL_RE, '<email>')
      .replace(BEARER_RE, 'Bearer <token>')
      .replace(SECRET_KV_RE, (_a, k: string, sep: string) => `${k}${sep}<redacted>`)
      .replace(SECRET_JSON_RE, (_a, k: string, sep: string) => `"${k}"${sep}<redacted>`)
      .replace(GROUPED_CODE_RE, '<code>')
      .replace(BARE_CODE_RE, (_a, w: string, sep: string) => `${w}${sep}<code>`)
      .replace(LONG_HEX_RE, '<hex>')
      .replace(LONG_B64_RE, '<token>')
      .replace(CODE_DIGITS_RE, (_a, w: string, mid: string) => `${w}${mid}<code>`);
    return out;
  }
}

/** One-shot redaction with a fresh Redactor (no room map). */
export function redactLogLine(line: string, opts: RedactorOptions = {}): string | null {
  return new Redactor(opts).redact(line);
}

/** "<name> (r3, arena/dm, …)" → name, id, details. The name may itself contain " (r1, …": the LAST id wins. */
function roomOpenParts(body: string): { name: string; id: string; tail: string } | null {
  let best: { name: string; id: string; tail: string } | null = null;
  // Room names are short (ROOM_TAG_MAX): an id further in is not the room's (and each test scans the rest of the line).
  for (let i = body.indexOf(' (r'); i >= 0 && i <= ROOM_TAG_MAX; i = body.indexOf(' (r', i + 1)) {
    const m = /^ \((r\d+)((?:, [^]*)?)\)$/.exec(body.slice(i));
    if (m) best = { name: body.slice(0, i), id: m[1], tail: m[2].replace(/^, /, '') };
  }
  return best;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeHomedir(): string {
  try { return os.homedir(); } catch { return ''; }
}

// ------------------------------------------------------------------------------------------
// The host log file
// ------------------------------------------------------------------------------------------

/** host-2026-09-28.log for a local date. */
export function logFileName(at: Date | number): string {
  const d = at instanceof Date ? at : new Date(at);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${LOG_FILE_PREFIX}${y}-${mo}-${da}${LOG_FILE_SUFFIX}`;
}

/** HH:MM:SS.mmm, local time (the file already carries the date). */
export function logStamp(at: Date | number): string {
  const d = at instanceof Date ? at : new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

const LOG_NAME_RE = /^host-(\d{4})-(\d{2})-(\d{2})\.log$/;

/**
 * Deletes host-YYYY-MM-DD.log files older than `retainDays` (by the date in the name). Only files with exactly that
 * name shape are ever touched. Returns the deleted names. Never throws.
 */
export function pruneLogs(dir: string, now: Date | number = Date.now(), retainDays = LOG_RETAIN_DAYS): string[] {
  const deleted: string[] = [];
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return deleted; }
  const today = new Date(now instanceof Date ? now.getTime() : now);
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - retainDays).getTime();
  for (const n of names) {
    const m = LOG_NAME_RE.exec(n);
    if (!m) continue;
    const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (!(day < cutoff)) continue;
    try {
      const st = fs.lstatSync(path.join(dir, n));
      if (!st.isFile()) continue;
      fs.unlinkSync(path.join(dir, n));
      deleted.push(n);
    } catch { /* in use or gone: next time */ }
  }
  return deleted;
}

export interface HostLogOptions {
  /** data\logs */
  dir: string;
  /** Put in front of every line of this writer ("launcher" → "[launcher] …"). */
  tag?: string;
  now?: () => number;
  retainDays?: number;
  /** false = write lines as they are (default: redact). */
  redact?: boolean;
  redactor?: Redactor;
  maxPendingBytes?: number;
}

export interface HostLog {
  /** Queue one line (redacted, time-stamped). Never throws, never blocks on the disk. */
  write(line: string): void;
  /** `write` bound, for startServer's `logSink`. */
  readonly sink: (line: string) => void;
  /** Resolves when everything queued so far is on disk (or failed). */
  flush(): Promise<void>;
  /** Write what is queued synchronously (process 'exit'). Never throws. */
  flushSync(): void;
  /** Flush, then refuse further lines. */
  close(): Promise<void>;
  /** Today's file. */
  readonly file: string;
  readonly dir: string;
  /** Lines lost: dropped by the queue cap or failed writes (redaction drops are not counted here). */
  readonly lost: number;
  /** Lines the redactor withheld entirely (wellbeing lines, reset links). */
  readonly withheld: number;
}

interface Pending { file: string; text: string }

export function createHostLog(opts: HostLogOptions): HostLog {
  const now = opts.now ?? Date.now;
  const retainDays = opts.retainDays ?? LOG_RETAIN_DAYS;
  const redactor = opts.redact === false ? null : (opts.redactor ?? new Redactor());
  const maxPending = opts.maxPendingBytes ?? LOG_MAX_PENDING_BYTES;
  const tag = opts.tag ? `[${opts.tag}] ` : '';
  const dir = opts.dir;
  const queue: Pending[] = [];
  let queuedBytes = 0;
  let lost = 0;
  let lostReported = 0;
  let withheld = 0;
  /** The chunk an async append is writing right now (flushSync writes it too: a duplicate beats a loss at exit). */
  let inflight: Pending | null = null;
  /** The write pump: one drain at a time, chained. */
  let pump: Promise<void> = Promise.resolve();
  let pumpQueued = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let dirReady = false;
  let currentName = logFileName(now());
  pruneLogs(dir, now(), retainDays);

  const enqueue = (text: string, at: number): void => {
    const name = logFileName(at);
    if (name !== currentName) {
      currentName = name;
      pruneLogs(dir, at, retainDays);
    }
    queue.push({ file: path.join(dir, name), text });
    queuedBytes += text.length;
    while (queuedBytes > maxPending && queue.length > 1) {
      const old = queue.shift()!;
      queuedBytes -= old.text.length;
      lost++;
    }
  };

  /** The next run of lines for one file (up to 256 KB). */
  const take = (): Pending | null => {
    if (!queue.length) return null;
    const file = queue[0].file;
    let text = '';
    while (queue.length && queue[0].file === file && text.length < 256 * 1024) {
      const p = queue.shift()!;
      queuedBytes -= p.text.length;
      text += p.text;
    }
    return { file, text };
  };

  const scheduleRetry = (): void => {
    if (retry || closed) return;
    dirReady = false;
    retry = setTimeout(() => { retry = null; kick(); }, RETRY_MS);
    retry.unref?.();
  };

  const drain = async (): Promise<void> => {
    if (!dirReady) {
      try { await fs.promises.mkdir(dir, { recursive: true }); dirReady = true; } catch { scheduleRetry(); return; }
    }
    for (;;) {
      if (lost > lostReported) {
        const n = lost - lostReported;
        lostReported = lost;
        const at = now();
        queue.unshift({ file: path.join(dir, logFileName(at)), text: `${logStamp(at)} ${tag}${n} log line(s) were lost (the disk was busy or full)\n` });
        queuedBytes += 80;
      }
      const chunk = take();
      if (!chunk) return;
      inflight = chunk;
      try {
        await fs.promises.appendFile(chunk.file, chunk.text, 'utf8');
        inflight = null;
      } catch {
        inflight = null;
        // Back in front, and try again later; the cap keeps memory bounded.
        queue.unshift(chunk);
        queuedBytes += chunk.text.length;
        scheduleRetry();
        return;
      }
    }
  };

  /** Queue one drain after the current one (at most one waiting). */
  const kick = (): void => {
    if (pumpQueued || retry) return;
    pumpQueued = true;
    pump = pump
      .then(() => new Promise<void>((r) => { setImmediate(r); }))
      .then(() => { pumpQueued = false; return drain(); })
      .catch(() => { pumpQueued = false; });
  };

  const write = (line: string): void => {
    if (closed) return;
    try {
      const at = now();
      const r = redactor ? redactor.redact(String(line)) : String(line);
      if (r === null) { withheld++; return; }
      const stamp = logStamp(at);
      const body = r.split('\n').map((l, i) => (i === 0 ? `${stamp} ${tag}${l}` : `    ${l}`)).join('\n');
      enqueue(`${body}\n`, at);
      kick();
    } catch {
      lost++;
    }
  };

  const flushSync = (): void => {
    if (retry) { clearTimeout(retry); retry = null; }
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* reported by the append */ }
    const chunks: Pending[] = [];
    if (inflight) { chunks.push(inflight); inflight = null; }
    for (let c = take(); c; c = take()) chunks.push(c);
    for (const c of chunks) {
      try { fs.appendFileSync(c.file, c.text, 'utf8'); } catch { lost++; }
    }
  };

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      await pump;
      if (!queue.length || retry) return; // done, or the disk is failing (flushSync is the last resort)
      kick();
    }
  };

  const log: HostLog = {
    write,
    sink: write,
    flush,
    flushSync,
    async close() {
      await flush();
      flushSync();
      closed = true;
    },
    get file() { return path.join(dir, currentName); },
    dir,
    get lost() { return lost; },
    get withheld() { return withheld; },
  };
  return log;
}

// ------------------------------------------------------------------------------------------
// The child: a quiet console
// ------------------------------------------------------------------------------------------

export interface ChildLogging {
  log: HostLog;
  /** startServer's logSink. */
  sink: (line: string) => void;
  /** Put console.* back (tests). */
  uninstall(): void;
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace';
const CONSOLE_METHODS: readonly ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug', 'trace'];

/**
 * The server child's logging (§5.1: "the child writes data\logs\host-YYYY-MM-DD.log asynchronously"): a redacted
 * host log in `<dataDir>\logs`, console.* routed into it, and a synchronous flush on process exit. After this the
 * child writes nothing to stdout / stderr itself (Node's own fatal output still goes to stderr, which the launcher
 * reads). The LAN child boot (src/server/index.ts lanBoot) calls it with the launcher's dataDir and passes `sink`
 * to startServer as `logSink`.
 */
export function installChildLogging(opts: { dataDir: string; now?: () => number; homeDir?: string } | { log: HostLog }): ChildLogging {
  const log = 'log' in opts ? opts.log : createHostLog({
    dir: path.join(opts.dataDir, 'logs'),
    now: opts.now,
    redactor: new Redactor({ homeDir: opts.homeDir }),
  });
  const saved = new Map<ConsoleMethod, (...a: unknown[]) => void>();
  for (const m of CONSOLE_METHODS) {
    saved.set(m, console[m] as (...a: unknown[]) => void);
    (console as unknown as Record<string, (...a: unknown[]) => void>)[m] = (...args: unknown[]) => {
      try { log.write(format(...args)); } catch { /* never throw from a log call */ }
    };
  }
  const onExit = (): void => log.flushSync();
  process.on('exit', onExit);
  return {
    log,
    sink: log.sink,
    uninstall() {
      for (const [m, fn] of saved) (console as unknown as Record<string, unknown>)[m] = fn;
      process.off('exit', onExit);
    },
  };
}

// ------------------------------------------------------------------------------------------
// The parent: the console window
// ------------------------------------------------------------------------------------------

export interface ConsoleOut {
  write(text: string): void;
  /** The console window's title (process.title on Windows sets it). */
  setTitle?(title: string): void;
}

/** The real console: stdout (a closed console is ignored) and process.title. */
export function processConsole(stream: NodeJS.WriteStream = process.stdout): ConsoleOut {
  // A console (or pipe) that went away reports EPIPE as an 'error' event: without a listener that is an uncaught
  // exception in the launcher, which must keep supervising the server whether or not anyone can read its window.
  try { if (!stream.listenerCount('error')) stream.on('error', () => undefined); } catch { /* not a stream */ }
  return {
    write(text) {
      try { stream.write(text); } catch { /* the console is gone (EPIPE): nothing to tell */ }
    },
    setTitle(title) {
      try { process.title = title; } catch { /* not supported */ }
    },
  };
}

/**
 * The launcher's console. Everything it prints also goes to the host log (redacted), except the banner, which
 * carries the setup code: the log gets a summary line instead.
 */
export class HostConsole {
  private out: ConsoleOut;
  private log: HostLog | null;
  private lastTitle = '';
  private readonly now: () => number;

  constructor(opts: { out?: ConsoleOut; log?: HostLog | null; now?: () => number } = {}) {
    this.out = opts.out ?? processConsole();
    this.log = opts.log ?? null;
    this.now = opts.now ?? Date.now;
  }

  setLog(log: HostLog | null): void { this.log = log; }

  // Every console write goes through consoleSafe: a notice or an error message may come from the server child, and
  // an escape sequence in it must never clear the window or fake the banner.

  /** A block of text, line breaks kept (the banner; a refusal's full message). Not logged. */
  print(text: string): void {
    const t = consoleSafe(text, true);
    this.out.write(t.endsWith('\n') ? t : `${t}\n`);
  }

  /** One line with the time (a restart, an address change, a stop). Also logged. */
  notice(text: string): void {
    this.out.write(`${noticeLine(text, this.now())}\n`);
    this.log?.write(text);
  }

  /** A refusal or fatal error: printed in full (it was written for the host), and logged. */
  fatal(text: string): void {
    this.print(`\n${String(text).trim()}\n`);
    this.log?.write(`FATAL: ${text}`);
  }

  /** Logged only (the console stays quiet). */
  quiet(text: string): void {
    this.log?.write(text);
  }

  title(t: string): void {
    if (t === this.lastTitle) return;
    this.lastTitle = t;
    this.out.setTitle?.(t);
  }
}
