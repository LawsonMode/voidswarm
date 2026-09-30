// T-CL-6 (LAN edition §3.7, §13 O-M15): a host that goes silent (asleep, unplugged) sends no close, so the client
// must notice on its own. SilenceWatch is the rule; GameClient runs it on its ping timer (client.test.ts, and over a
// real socket in reconnect.test.ts).
import { describe, expect, it } from 'vitest';
import { LATE_TICK_SLACK_MS, PING_INTERVAL_MS, SILENCE_MS, SilenceWatch } from './silence';

/** Ticks every `every` ms from `from` to `to` (inclusive); returns the first time tick() said "silent", or null. */
function run(w: SilenceWatch, from: number, to: number, every = PING_INTERVAL_MS, answer?: (t: number) => boolean): number | null {
  for (let t = from; t <= to; t += every) {
    if (w.tick(t)) return t;
    if (answer?.(t)) w.received();
  }
  return null;
}

describe('T-CL-6: SilenceWatch (a host that stops answering)', () => {
  it('the defaults: ping every 2 s, give up after 8 s without an answer', () => {
    expect(PING_INTERVAL_MS).toBe(2000);
    expect(SILENCE_MS).toBe(8000);
    expect(LATE_TICK_SLACK_MS).toBe(2000);
  });

  it('a host that answers every ping is never dropped', () => {
    const w = new SilenceWatch();
    expect(run(w, 0, 3_600_000, PING_INTERVAL_MS, () => true)).toBeNull();
  });

  it('a host that never answers is dropped 8 s after the first unanswered ping', () => {
    expect(run(new SilenceWatch(), 0, 60_000)).toBe(8000);
  });

  it('a host that goes quiet mid-session is dropped 8 to 10 s later', () => {
    // quiet just before the 20 s ping: that ping is the probe
    expect(run(new SilenceWatch(), 0, 60_000, PING_INTERVAL_MS, (t) => t < 20_000)).toBe(28_000);
    // quiet just after the 20 s pong: the 22 s ping is the probe
    expect(run(new SilenceWatch(), 0, 60_000, PING_INTERVAL_MS, (t) => t <= 20_000)).toBe(30_000);
  });

  it('timer jitter: the tick due 8 s after a probe that ran a few ms late still counts (not one interval later)', () => {
    const w = new SilenceWatch();
    expect(w.tick(0)).toBe(false);
    w.received();
    expect(w.tick(2005)).toBe(false); // the probe: its tick started 5 ms late
    expect([4000, 6000, 8000, 10_000, 12_000].find((t) => w.tick(t))).toBe(10_000); // 7.995 s after the probe
    // but a tick well short of 8 s never does
    const e = new SilenceWatch();
    expect(e.tick(0)).toBe(false);
    expect(e.tick(7400)).toBe(false); // (a late tick: the probe restarts here)
    const f = new SilenceWatch();
    expect(f.tick(0)).toBe(false);
    expect([2000, 4000, 6000, 7400].some((t) => f.tick(t))).toBe(false);
  });

  it('anything at all counts as an answer (snapshots during a match, not only pongs)', () => {
    const w = new SilenceWatch();
    // no pong ever, but something arrives between each pair of ticks
    for (let t = 0; t <= 120_000; t += 2000) {
      expect(w.tick(t)).toBe(false);
      w.received();
    }
  });

  it('a background tab: a ping sent 60 s late and answered at once is no alarm', () => {
    const w = new SilenceWatch();
    expect(w.tick(0)).toBe(false);
    w.received(); // the pong, milliseconds later
    for (const t of [60_000, 120_000, 180_000, 240_000]) { // intensive throttling: one wake-up a minute
      expect(w.tick(t)).toBe(false);
      w.received();
    }
    // and back in the foreground on the normal cadence
    expect(run(w, 242_000, 300_000, PING_INTERVAL_MS, () => true)).toBeNull();
  });

  it('a frozen page (the pong still queued when the late tick runs) is no alarm', () => {
    const w = new SilenceWatch();
    expect(w.tick(0)).toBe(false); // ping sent, then the tab froze (or the Chromebook lid closed)
    expect(w.tick(100_000)).toBe(false); // thawed: the timer ran before the queued pong
    w.received();
    expect(run(w, 102_000, 200_000, PING_INTERVAL_MS, () => true)).toBeNull();
  });

  it('a late tick restarts the probe, but a host that is really gone is still dropped 8 s after it', () => {
    const w = new SilenceWatch();
    expect(w.tick(0)).toBe(false);
    expect(w.tick(60_000)).toBe(false); // late: the probe restarts here
    expect(run(w, 62_000, 120_000)).toBe(68_000);
  });

  it('only a tick more than the slack behind is late: normal background throttling (1 s alignment) still detects', () => {
    const w = new SilenceWatch();
    // Chrome aligns background timers to whole seconds: a 2 s interval runs every 2 to 3 s
    expect([0, 3000, 5000, 8000, 10_000, 13_000].find((t) => w.tick(t))).toBe(8000);
    // exactly at the edge (interval + slack) is still on time
    const e = new SilenceWatch();
    expect(e.tick(0)).toBe(false);
    expect(e.tick(PING_INTERVAL_MS + LATE_TICK_SLACK_MS)).toBe(false);
    expect(e.tick(2 * (PING_INTERVAL_MS + LATE_TICK_SLACK_MS))).toBe(true);
  });

  it('custom timings (the tests shorten them)', () => {
    const w = new SilenceWatch(1000, 200);
    expect(run(w, 0, 5000, 200)).toBe(1000);
  });
});
