// LAN edition §3.7: what an unexpected close means to the player, and the 60 s auto-retry after one.
// The rules are pure (reconnect.test.ts); main.ts wires SessionRetry to the GameClient and the Title screen.
import { WS_CLOSE_KICKED } from '../../shared/net/closeCodes';
import { isLocalOrLan, isSessionExpiredMessage } from './accounts';
import { ConnectSuperseded } from './GameClient';

/** Shown when a LAN host went away: the host PC slept, stopped or changed address. */
export const HOST_LOST_TEXT = 'Lost the host PC (asleep, stopped or moved) — tell your teacher';
/** The same for a server on the internet (a VPS, a tunnel): there is no teacher to tell. */
export const SERVER_LOST_TEXT = 'Lost the connection to the server';
/** A planned restart (a restore, a port change). The server sends this as the close reason. */
export const RESTART_TEXT = 'Server restarting — back in about 20 s';
/** The standard WebSocket close code for "Service Restart" (RFC 6455 registry). */
export const WS_CLOSE_SERVICE_RESTART = 1012;
/** How long the client keeps trying after an unexpected close. */
export const RETRY_WINDOW_MS = 60_000;
/** Wait before each attempt: quick at first (a blip), then every 5 s until the window ends. */
export const RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 3000, 5000];
/**
 * Each wait is spread by up to ±20 %, so a class of 30+ clients dropped by one restart doesn't knock on the
 * ConnectionGate at the same instants.
 */
export const RETRY_JITTER = 0.2;

export type CloseKind =
  /** The server ended this session on purpose (ws close 4001): never retried. */
  | 'kicked'
  /** A planned restart: retried, with the "back in about 20 s" text. */
  | 'restart'
  /** Anything else (the host slept, stopped, crashed or moved; the Wi-Fi dropped): retried. */
  | 'lost';

/** A close reason that announces a planned restart ("Server restarting — back in about 20 s", any wording after it). */
export function isRestartReason(reason: string): boolean {
  return /^\s*server restarting\b/i.test(reason);
}

export function classifyClose(reason: string, code?: number): CloseKind {
  if (code === WS_CLOSE_KICKED) return 'kicked';
  if (code === WS_CLOSE_SERVICE_RESTART || isRestartReason(reason)) return 'restart';
  return 'lost';
}

function hostnameOf(serverUrl: string): string {
  try { return new URL(serverUrl.trim()).hostname; } catch { return ''; }
}

/**
 * The line the player sees after an unexpected close. A restart shows the server's own restart reason when it sent
 * one (it may name another delay), else RESTART_TEXT. A lost LAN host gets HOST_LOST_TEXT: a private or local
 * address, a computer name ("room136-pc"), `<name>.local` or `.lan` (accounts.isLocalOrLan; this picks the wording
 * only and trusts nothing). A lost server on an internet name gets SERVER_LOST_TEXT. Both retry the same way.
 */
export function closeNoticeText(kind: CloseKind, reason: string, serverUrl: string): string {
  if (kind === 'kicked') return reason;
  if (kind === 'restart') return isRestartReason(reason) ? clip(reason.trim(), 120) : RESTART_TEXT;
  const host = hostnameOf(serverUrl);
  return host && isLocalOrLan(host) ? HOST_LOST_TEXT : SERVER_LOST_TEXT;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * The status line while retrying, in two parts: `text` (the notice and "Reconnecting…", announced once) and
 * `countdown` (the seconds left, which change every second and so stay out of the live region).
 */
export function retryStatusParts(notice: string, secondsLeft: number): { text: string; countdown: string } {
  return { text: `${notice} · Reconnecting…`, countdown: `${Math.max(0, Math.ceil(secondsLeft))} s` };
}

/** The status line while retrying: the notice, then the time left. */
export function retryStatusLine(notice: string, secondsLeft: number): string {
  const p = retryStatusParts(notice, secondsLeft);
  return `${p.text} ${p.countdown}`;
}

/**
 * Delay before attempt `n` (0-based). With `random` (0..1, e.g. Math.random) it is spread by ±RETRY_JITTER;
 * without it, the plain schedule.
 */
export function retryDelayMs(n: number, random?: () => number): number {
  const base = RETRY_DELAYS_MS[Math.min(Math.max(0, n), RETRY_DELAYS_MS.length - 1)]!;
  if (!random) return base;
  const r = Math.min(1, Math.max(0, Number(random()) || 0));
  return Math.round(base * (1 - RETRY_JITTER + 2 * RETRY_JITTER * r));
}

export type ReconnectState =
  /** Waiting for the next attempt (the countdown ticks every second). */
  | 'waiting'
  /** An attempt is in flight (reported when it starts, then every second while it lasts). */
  | 'trying'
  /** An attempt got back in: done. */
  | 'connected'
  /** The window ran out without getting back in: done. */
  | 'gaveUp'
  /** An attempt said 'stop' (refused on purpose, superseded, or no longer wanted): done, nothing more to show. */
  | 'stopped';

export interface ReconnectStatus {
  state: ReconnectState;
  /** What to show: retryStatusLine while waiting / trying, the bare notice once it gave up, '' when connected / stopped. */
  text: string;
  /** The notice the retry was started with (HOST_LOST_TEXT, RESTART_TEXT, ...). */
  notice: string;
  secondsLeft: number;
  /** Attempts started so far. */
  attempts: number;
}

/**
 * One reconnect attempt's outcome: 'ok' = back in; 'retry' = failed, try again while the window lasts;
 * 'stop' = give up quietly (the attempt was superseded by the player, or the server refused us on purpose and the
 * caller already showed why).
 */
export type AttemptResult = 'ok' | 'retry' | 'stop';

export interface ReconnectorOptions {
  attempt(): Promise<AttemptResult>;
  onStatus(s: ReconnectStatus): void;
  /** Clock (ms). Default Date.now. */
  now?(): number;
  windowMs?: number;
  /** 0..1 source for the ±20 % jitter on each wait. Default Math.random (tests pass a fixed one). */
  random?(): number;
}

/**
 * Retries a lost connection for RETRY_WINDOW_MS: an attempt after about 1, 2, 3, then every 5 s (each ±20 %), never
 * starting one after the window ends (one still in flight may finish). start() again restarts the window; cancel()
 * stops everything (the player pressed Play / Quit, or a newer session began). Nothing runs while idle.
 */
export class Reconnector {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** Bumped by start() / cancel(): an attempt that resolves for an older run is ignored. */
  private run = 0;
  private startedAt = 0;
  private attempts = 0;
  private notice = '';
  private trying = false;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly random: () => number;

  constructor(private readonly opts: ReconnectorOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.windowMs = opts.windowMs ?? RETRY_WINDOW_MS;
    this.random = opts.random ?? (() => Math.random());
  }

  /** A retry run is in progress (waiting or trying). */
  get active(): boolean { return this.timer !== null || this.trying; }

  start(notice: string): void {
    this.cancel();
    const run = ++this.run;
    this.notice = notice;
    this.startedAt = this.now();
    this.attempts = 0;
    // Every second, attempt in flight or not: an attempt at a sleeping host can take the 7 s connect timeout plus
    // the 8 s hello wait, and the seconds left must keep counting down meanwhile.
    this.ticker = setInterval(() => { if (run === this.run) this.report(this.trying ? 'trying' : 'waiting'); }, 1000);
    this.report('waiting');
    this.schedule(run);
  }

  cancel(): void {
    this.run++;
    this.trying = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
  }

  private secondsLeft(): number {
    return Math.max(0, (this.startedAt + this.windowMs - this.now()) / 1000);
  }

  private report(state: ReconnectState): void {
    const left = this.secondsLeft();
    const text = state === 'gaveUp' ? this.notice
      : state === 'connected' || state === 'stopped' ? '' : retryStatusLine(this.notice, left);
    try {
      this.opts.onStatus({ state, text, notice: this.notice, secondsLeft: left, attempts: this.attempts });
    } catch (e) {
      console.error('[voidswarm] reconnect status failed', e);
    }
  }

  private finish(state: 'connected' | 'gaveUp' | 'stopped'): void {
    this.cancel();
    this.report(state);
  }

  private schedule(run: number): void {
    const elapsed = this.now() - this.startedAt;
    const delay = retryDelayMs(this.attempts, this.random);
    if (elapsed + delay > this.windowMs) {
      // No attempt may start after the window: wait out the rest, then give up.
      this.timer = setTimeout(() => { if (run === this.run) this.finish('gaveUp'); }, Math.max(0, this.windowMs - elapsed));
      return;
    }
    this.timer = setTimeout(() => void this.tryOnce(run), delay);
  }

  private async tryOnce(run: number): Promise<void> {
    if (run !== this.run) return;
    this.timer = null;
    this.trying = true;
    this.attempts++;
    this.report('trying');
    let result: AttemptResult;
    try { result = await this.opts.attempt(); } catch { result = 'retry'; }
    if (run !== this.run) return; // cancelled (or restarted) meanwhile
    this.trying = false;
    if (result === 'ok') { this.finish('connected'); return; }
    if (result === 'stop') { this.finish('stopped'); return; }
    if (this.now() - this.startedAt >= this.windowMs) { this.finish('gaveUp'); return; }
    this.report('waiting');
    this.schedule(run);
  }
}

/** The session an auto-reconnect dials again: the same server, callsign and (accepted) token. */
export interface RedialSession { url: string; name: string; token?: string }

/** The parts of GameClient redial uses. */
export interface RedialClient {
  connectOnline(url: string, name: string, token?: string): Promise<void>;
  disconnect(silent?: boolean): void;
  /** Server 'error' messages; returns the unsubscribe. */
  on(ev: 'error', fn: (msg: string) => void): () => void;
  readonly closeKicked: boolean;
  readonly welcomed: boolean;
  readonly account: unknown;
}

export type RedialOutcome =
  /** Back in. `tokenAccepted` false = the token was refused and this is a guest session now. */
  | { result: 'ok'; tokenAccepted: boolean }
  /** Not reachable (yet): try again while the window lasts. */
  | { result: 'retry'; error: string }
  /**
   * Stop retrying: `kicked` = the server refused us on purpose with this message (ws close 4001: banned, session
   * revoked, guests off...; or an 'error' before welcome, such as a protocol mismatch after a server update); null =
   * the attempt was superseded (the player connected or quit meanwhile).
   */
  | { result: 'stop'; kicked: string | null };

/**
 * One reconnect attempt: GameClient.connectOnline again, told apart into ok / retry / stop. Never throws.
 * An 'error' message before welcome turns us away for good (the Zone answers a protocol mismatch that way and keeps
 * the socket open): the attempt stops at once with that message, instead of waiting out the hello timeout and
 * trying again for the rest of the window. The one exception is "Session expired": welcome (as a guest) follows it.
 */
export async function redial(client: RedialClient, s: RedialSession): Promise<RedialOutcome> {
  const turnedAway: { msg: string | null } = { msg: null };
  const off = client.on('error', (msg) => {
    if (turnedAway.msg !== null || client.welcomed || isSessionExpiredMessage(msg)) return;
    turnedAway.msg = msg;
    client.disconnect(true); // ends the wait for welcome now (connectOnline rejects as superseded)
  });
  try {
    await client.connectOnline(s.url, s.name, s.token);
  } catch (e) {
    if (turnedAway.msg !== null) return { result: 'stop', kicked: turnedAway.msg };
    if (e instanceof ConnectSuperseded) return { result: 'stop', kicked: null };
    const error = e instanceof Error ? e.message : String(e);
    const kicked = client.closeKicked;
    client.disconnect(true); // no half-open transport between attempts
    return kicked ? { result: 'stop', kicked: error } : { result: 'retry', error };
  } finally {
    off();
  }
  return { result: 'ok', tokenAccepted: !s.token || !!client.account };
}

/**
 * May this session still be dialled? An account session only while the Title still holds its token: after a Log out
 * (the token is gone, or another account's is there) a retry must never bring the old account back, e.g. on a shared
 * school PC. A guest session always may.
 */
export function redialAllowed(s: RedialSession, currentToken: string | null): boolean {
  return !s.token || s.token === currentToken;
}

export interface SessionRetryOptions {
  client: RedialClient;
  /** The session token the Title holds now (null once logged out). */
  currentToken(): string | null;
  /** False while the player's own connect is in flight: the attempt stands down. Default: always true. */
  canAttempt?(): boolean;
  onStatus(s: ReconnectStatus): void;
  /** Back in on `s` (`tokenAccepted` false = the token was refused: a guest session now). */
  onReconnected(s: RedialSession, tokenAccepted: boolean): void;
  /** The server turned us away on purpose (redial's `kicked` message). The retry is over. */
  onRefused(message: string): void;
  now?(): number;
  windowMs?: number;
  random?(): number;
}

/**
 * The auto-reconnect of one lost online session (main.ts): a Reconnector dialling `redial` with the same server,
 * callsign and token, under two rules: an account session is never dialled once its token is gone (redialAllowed),
 * and stop() also aborts an attempt in flight, so nothing it started can land on Command afterwards.
 */
export class SessionRetry {
  private session: RedialSession | null = null;
  private readonly reconnector: Reconnector;

  constructor(private readonly opts: SessionRetryOptions) {
    this.reconnector = new Reconnector({
      attempt: () => this.attemptOnce(),
      onStatus: (st) => {
        if (st.state === 'gaveUp' || st.state === 'stopped') this.session = null;
        opts.onStatus(st);
      },
      now: opts.now, windowMs: opts.windowMs, random: opts.random,
    });
  }

  /** A retry is waiting or trying. */
  get active(): boolean { return this.reconnector.active; }

  start(session: RedialSession, notice: string): void {
    this.session = session;
    this.reconnector.start(notice);
  }

  /**
   * Stop retrying (the player chose what happens next, or logged out). An attempt in flight is aborted too: the
   * client is disconnected silently, which supersedes its connect. Returns whether a retry was running.
   */
  stop(): boolean {
    const was = this.reconnector.active;
    this.reconnector.cancel();
    this.session = null;
    if (was) this.opts.client.disconnect(true);
    return was;
  }

  private async attemptOnce(): Promise<AttemptResult> {
    const s = this.session;
    if (!s || (this.opts.canAttempt && !this.opts.canAttempt())) return 'stop';
    if (!redialAllowed(s, this.opts.currentToken())) return 'stop';
    const out = await redial(this.opts.client, s);
    if (this.session !== s) {
      // Stopped meanwhile: an attempt that got in anyway is dropped, never kept.
      if (out.result === 'ok') this.opts.client.disconnect(true);
      return 'stop';
    }
    if (out.result === 'retry') return 'retry';
    this.session = null;
    if (out.result === 'stop') {
      if (out.kicked !== null) this.opts.onRefused(out.kicked);
      return 'stop';
    }
    this.opts.onReconnected(s, out.tokenAccepted);
    return 'ok';
  }
}
