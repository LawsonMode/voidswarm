// LAN edition §3.7 / §13 O-M15: a host that goes silent (the PC slept, was unplugged or lost its Wi-Fi) sends no
// close. The TCP connection just stops answering, and a Chromebook or Android device can keep it "open" for about
// 15 minutes. GameClient pings every PING_INTERVAL_MS; SilenceWatch says when nothing at all (no pong, message or
// snapshot) has come back for SILENCE_MS since a ping went out. GameClient then drops the connection as lost, and
// the 60 s auto-retry (reconnect.ts) starts with the host-lost text.
//
// The silence is measured from the outstanding ping's send time, not from the last message. A background tab whose
// timers the browser delays sends its ping late, and the pong still comes back within milliseconds of it. A tick
// that itself ran late (throttled, frozen, the device slept, a long task) restarts the probe, so time the page
// spent not running is never counted as the host's silence.

/** How often GameClient pings the server. */
export const PING_INTERVAL_MS = 2000;
/** Nothing received for this long after a ping: the host is gone (detected about 8 to 10 s after it went quiet). */
export const SILENCE_MS = 8000;
/** A ping tick more than this much later than its interval ran late: the probe restarts from it. */
export const LATE_TICK_SLACK_MS = 2000;
/** The close reason GameClient reports for a silent host (classified 'lost': retried with the host-lost text). */
export const SILENT_CLOSE_REASON = 'Connection lost (no answer from the host)';

export class SilenceWatch {
  /** Send time of the first ping nothing has answered yet (null = everything so far was answered). */
  private probeAt: number | null = null;
  private lastTickAt: number | null = null;

  constructor(
    readonly silenceMs = SILENCE_MS,
    readonly intervalMs = PING_INTERVAL_MS,
    readonly lateSlackMs = LATE_TICK_SLACK_MS,
  ) {}

  /** Something arrived from the server (any message or snapshot): the host is there. */
  received(): void {
    this.probeAt = null;
  }

  /**
   * A ping tick at `now` (ms, monotonic), just before its ping is sent. Returns true when the host has not answered
   * for `silenceMs` since the probe ping: give up on this connection. Otherwise this tick's ping becomes the probe
   * if none is outstanding. The tick due `silenceMs` after the probe counts even when it runs a little early against
   * it (up to a quarter interval: the probe's own tick may have started a few ms late), so a silent host is caught
   * on that tick and not one interval later.
   */
  tick(now: number): boolean {
    const late = this.lastTickAt !== null && now - this.lastTickAt > this.intervalMs + this.lateSlackMs;
    this.lastTickAt = now;
    if (late) this.probeAt = null; // the page was not running: its missing answers prove nothing
    if (this.probeAt !== null && now - this.probeAt >= this.silenceMs - this.intervalMs / 4) return true;
    if (this.probeAt === null) this.probeAt = now;
    return false;
  }
}
