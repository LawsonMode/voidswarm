// T-CL-6 (LAN edition §3.7): an unexpected close shows the host-lost text and retries for 60 s; the planned-restart
// reason shows "back in about 20 s". The rules and the Reconnector's clock run on fake timers; the last block runs a
// real GameClient over a real WebSocket (Node's global WebSocket → a `ws` server on an ephemeral port).
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { WS_CLOSE_KICKED } from '../../shared/net/closeCodes';
import { ConnectSuperseded, GameClient } from './GameClient';
import {
  classifyClose, closeNoticeText, HOST_LOST_TEXT, Reconnector, redial, redialAllowed, RESTART_TEXT, RETRY_JITTER,
  RETRY_WINDOW_MS, retryDelayMs, retryStatusLine, retryStatusParts, SERVER_LOST_TEXT, SessionRetry,
  WS_CLOSE_SERVICE_RESTART, type AttemptResult, type ReconnectStatus, type RedialClient, type RedialSession,
} from './reconnect';
import { SILENT_CLOSE_REASON } from './silence';

const MISMATCH = 'Protocol mismatch: server v5, client v4. Please refresh.';

describe('T-CL-6: close reasons', () => {
  it('tells a kick, a planned restart and a lost host apart', () => {
    expect(classifyClose('Session ended — please log in again', WS_CLOSE_KICKED)).toBe('kicked');
    expect(classifyClose('Server restarting — back in about 20 s', 1001)).toBe('restart');
    expect(classifyClose('', WS_CLOSE_SERVICE_RESTART)).toBe('restart');
    expect(classifyClose('server shutting down', 1001)).toBe('lost');
    expect(classifyClose('Connection lost (code 1006)', 1006)).toBe('lost');
    expect(classifyClose('Connection lost', undefined)).toBe('lost');
  });

  it('a lost LAN host says so (and to tell the teacher); an internet server does not', () => {
    for (const url of [
      'wss://10.0.0.5:7779', 'ws://192.168.1.50:7779', 'ws://localhost:7777', 'wss://[::1]:7779', 'ws://bat-computer.local:7779',
      // §3.2: the computer name (any case) and a router's .lan name reach a LAN host on the game port too
      'ws://room136-pc:7779', 'wss://ROOM136-PC:7779', 'ws://host.lan:7779',
    ]) {
      expect(closeNoticeText('lost', 'server shutting down', url), url).toBe(HOST_LOST_TEXT);
    }
    expect(HOST_LOST_TEXT).toBe('Lost the host PC (asleep, stopped or moved) — tell your teacher');
    expect(closeNoticeText('lost', 'Connection lost (code 1006)', 'wss://play.example.com')).toBe(SERVER_LOST_TEXT);
    // an IT hostname looks like any internet name from the client (the known gap: see the report)
    expect(closeNoticeText('lost', '', 'wss://voidswarm.caldwellschools.org')).toBe(SERVER_LOST_TEXT);
    expect(closeNoticeText('lost', '', 'not a url')).toBe(SERVER_LOST_TEXT);
  });

  it('the planned-restart reason shows "back in about 20 s"', () => {
    expect(RESTART_TEXT).toBe('Server restarting — back in about 20 s');
    expect(closeNoticeText('restart', 'Server restarting — back in about 20 s', 'ws://10.0.0.5:7779')).toContain('back in about 20 s');
    // a bare 1012 without the text still gets it; the server's own wording (another delay) is kept
    expect(closeNoticeText('restart', '', 'ws://10.0.0.5:7779')).toBe(RESTART_TEXT);
    expect(closeNoticeText('restart', 'Server restarting — back in about 45 s', 'ws://10.0.0.5:7779')).toBe('Server restarting — back in about 45 s');
    expect(closeNoticeText('kicked', 'Banned', 'ws://10.0.0.5:7779')).toBe('Banned');
  });

  it('the status line counts down (the seconds apart from the announced text)', () => {
    expect(retryStatusLine(HOST_LOST_TEXT, 59.2)).toBe(`${HOST_LOST_TEXT} · Reconnecting… 60 s`);
    expect(retryStatusLine(RESTART_TEXT, -3)).toBe(`${RESTART_TEXT} · Reconnecting… 0 s`);
    expect(retryStatusParts(HOST_LOST_TEXT, 41.5)).toEqual({ text: `${HOST_LOST_TEXT} · Reconnecting…`, countdown: '42 s' });
    expect([0, 1, 2, 3, 4, 10].map((n) => retryDelayMs(n))).toEqual([1000, 2000, 3000, 5000, 5000, 5000]);
  });

  it('each wait is spread by ±20 % (a class does not reconnect in lockstep)', () => {
    expect(RETRY_JITTER).toBe(0.2);
    expect(retryDelayMs(0, () => 0)).toBe(800);
    expect(retryDelayMs(0, () => 0.5)).toBe(1000);
    expect(retryDelayMs(0, () => 1)).toBe(1200);
    expect(retryDelayMs(3, () => 0)).toBe(4000);
    expect(retryDelayMs(3, () => 1)).toBe(6000);
    // a broken source stays inside the band
    expect(retryDelayMs(1, () => 7)).toBe(2400);
    expect(retryDelayMs(1, () => Number.NaN)).toBe(1600);
  });
});

describe('T-CL-6: the Reconnector retries for 60 s', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  function harness(results: (() => AttemptResult)[] | (() => AttemptResult), random: () => number = () => 0.5) {
    const statuses: ReconnectStatus[] = [];
    const starts: number[] = [];
    let n = 0;
    const r = new Reconnector({
      attempt: async () => {
        starts.push(Date.now());
        const f = Array.isArray(results) ? results[Math.min(n, results.length - 1)]! : results;
        n++;
        return f();
      },
      onStatus: (s) => statuses.push(s),
      random,
    });
    return { r, statuses, starts };
  }

  it('keeps trying for 60 s, never starts an attempt after it, then gives up with the host-lost text', async () => {
    const { r, statuses, starts } = harness(() => 'retry');
    r.start(HOST_LOST_TEXT);
    expect(r.active).toBe(true);
    expect(statuses[0]).toMatchObject({ state: 'waiting', text: `${HOST_LOST_TEXT} · Reconnecting… 60 s`, attempts: 0 });
    await vi.advanceTimersByTimeAsync(RETRY_WINDOW_MS + 10_000);
    // 1, 3, 6, 11, 16 ... 56 s: quick at first, then every 5 s; nothing at or after 60 s
    expect(starts.slice(0, 5)).toEqual([1000, 3000, 6000, 11_000, 16_000]);
    expect(Math.max(...starts)).toBeLessThan(RETRY_WINDOW_MS);
    expect(starts.length).toBe(13);
    const last = statuses[statuses.length - 1]!;
    expect(last).toMatchObject({ state: 'gaveUp', text: HOST_LOST_TEXT });
    expect(statuses.filter((s) => s.state === 'gaveUp')).toHaveLength(1);
    expect(r.active).toBe(false);
    // the countdown ticked every second while waiting
    const waiting = statuses.filter((s) => s.state === 'waiting').map((s) => Math.ceil(s.secondsLeft));
    expect(waiting).toContain(45);
    expect(waiting).toContain(30);
    expect(statuses.every((s) => s.notice === HOST_LOST_TEXT)).toBe(true);
    // and then nothing more runs
    const count = statuses.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(statuses.length).toBe(count);
  });

  it('jittered waits stay in the ±20 % band, differ between clients, and never start an attempt after 60 s', async () => {
    const seq = (values: number[]) => { let i = 0; return () => values[i++ % values.length]!; };
    const a = harness(() => 'retry', seq([0.1, 0.9, 0.3, 0.7]));
    const b = harness(() => 'retry', seq([0.8, 0.2, 0.6, 0.4]));
    const fast = harness(() => 'retry', () => 0); // the shortest waits: the most attempts
    a.r.start(HOST_LOST_TEXT); b.r.start(HOST_LOST_TEXT); fast.r.start(HOST_LOST_TEXT);
    await vi.advanceTimersByTimeAsync(RETRY_WINDOW_MS + 10_000);
    expect(a.starts.slice(0, 3)).not.toEqual(b.starts.slice(0, 3));
    for (const h of [a, b, fast]) {
      const gaps = h.starts.map((t, i) => t - (i === 0 ? 0 : h.starts[i - 1]!));
      gaps.forEach((g, i) => {
        const base = retryDelayMs(i);
        expect(g).toBeGreaterThanOrEqual(Math.floor(base * (1 - RETRY_JITTER)));
        expect(g).toBeLessThanOrEqual(Math.ceil(base * (1 + RETRY_JITTER)));
      });
      expect(Math.max(...h.starts)).toBeLessThan(RETRY_WINDOW_MS);
      expect(h.statuses[h.statuses.length - 1]!.state).toBe('gaveUp');
    }
    expect(fast.starts.length).toBeGreaterThan(a.starts.length);
  });

  it('the countdown keeps counting while an attempt is in flight (a sleeping host: 7 s connect timeout + 8 s hello wait)', async () => {
    const statuses: ReconnectStatus[] = [];
    let n = 0;
    const r = new Reconnector({
      // the first attempt hangs for 15 s before it fails, like a dial to a PC that is asleep
      attempt: () => new Promise<AttemptResult>((res) => setTimeout(() => res(n++ === 0 ? 'retry' : 'ok'), n === 0 ? 15_000 : 10)),
      onStatus: (st) => statuses.push(st),
      random: () => 0.5,
    });
    r.start(HOST_LOST_TEXT);
    await vi.advanceTimersByTimeAsync(1000); // the first attempt starts
    const from = statuses.length;
    await vi.advanceTimersByTimeAsync(14_000);
    const during = statuses.slice(from);
    expect(during.length).toBeGreaterThanOrEqual(13); // one a second, not frozen
    expect(during.every((st) => st.state === 'trying')).toBe(true);
    const secs = during.map((st) => Math.ceil(st.secondsLeft));
    for (let i = 1; i < secs.length; i++) expect(secs[i]!).toBeLessThan(secs[i - 1]!);
    expect(during[during.length - 1]!.text).toBe(retryStatusLine(HOST_LOST_TEXT, during[during.length - 1]!.secondsLeft));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statuses[statuses.length - 1]!.state).toBe('connected');
    // and nothing ticks once it is done
    const count = statuses.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(statuses.length).toBe(count);
  });

  it('stops at the first success', async () => {
    const { r, statuses, starts } = harness([() => 'retry', () => 'retry', () => 'ok']);
    r.start(HOST_LOST_TEXT);
    await vi.advanceTimersByTimeAsync(RETRY_WINDOW_MS);
    expect(starts).toEqual([1000, 3000, 6000]);
    expect(statuses[statuses.length - 1]).toMatchObject({ state: 'connected', text: '', attempts: 3 });
    expect(r.active).toBe(false);
  });

  it('a planned restart shows its reason while it waits, and comes back', async () => {
    const { r, statuses } = harness([() => 'retry', () => 'retry', () => 'retry', () => 'retry', () => 'ok']);
    r.start(RESTART_TEXT);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statuses.some((s) => s.state === 'waiting' && s.text.startsWith('Server restarting — back in about 20 s'))).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(statuses[statuses.length - 1]!.state).toBe('connected');
  });

  it("'stop' ends it with a 'stopped' status; cancel() ends it silently; a late result from a cancelled run is ignored", async () => {
    const a = harness(() => 'stop');
    a.r.start(HOST_LOST_TEXT);
    await vi.advanceTimersByTimeAsync(5000);
    expect(a.starts).toEqual([1000]);
    expect(a.statuses.some((s) => s.state === 'gaveUp' || s.state === 'connected')).toBe(false);
    expect(a.statuses[a.statuses.length - 1]).toMatchObject({ state: 'stopped', text: '' });
    expect(a.r.active).toBe(false);

    let release: (v: AttemptResult) => void = () => {};
    const statuses: ReconnectStatus[] = [];
    const b = new Reconnector({ attempt: () => new Promise<AttemptResult>((res) => { release = res; }), onStatus: (s) => statuses.push(s) });
    b.start(HOST_LOST_TEXT);
    await vi.advanceTimersByTimeAsync(1200); // the first wait is 0.8–1.2 s with the default jitter
    expect(b.active).toBe(true);
    b.cancel();
    expect(b.active).toBe(false);
    const count = statuses.length;
    release('ok');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(statuses.length).toBe(count);
  });
});

/** A fake GameClient for redial / SessionRetry: `script` runs inside connectOnline (emit errors, hang, fail). */
type FakeClient = RedialClient & {
  disconnects: number; dials: { url: string; name: string; token?: string }[];
  emitError(msg: string): void;
};
function fakeClient(over: {
  fail?: unknown; closeKicked?: boolean; account?: unknown;
  /** Runs inside connectOnline; resolve = welcomed; a pending promise = still waiting for welcome. */
  script?: (c: FakeClient) => Promise<void>;
} = {}): FakeClient {
  const errorFns = new Set<(m: string) => void>();
  let abort: ((e: Error) => void) | null = null;
  const c: FakeClient = {
    disconnects: 0, dials: [], closeKicked: over.closeKicked ?? false, account: over.account ?? null, welcomed: false,
    async connectOnline(url, name, token) {
      c.dials.push({ url, name, token });
      (c as { welcomed: boolean }).welcomed = false;
      if (over.fail !== undefined) throw over.fail;
      // like GameClient: disconnect() supersedes the wait for welcome (armed before the script runs)
      const aborted = new Promise<never>((_res, rej) => { abort = rej; });
      try {
        await Promise.race([aborted, over.script ? over.script(c) : Promise.resolve()]);
      } finally {
        abort = null;
      }
      (c as { welcomed: boolean }).welcomed = true;
    },
    disconnect() {
      c.disconnects++;
      (c as { welcomed: boolean }).welcomed = false;
      const a = abort; abort = null;
      a?.(new ConnectSuperseded());
    },
    on(_ev, fn) { errorFns.add(fn); return () => errorFns.delete(fn); },
    emitError(msg) { for (const f of [...errorFns]) f(msg); },
  };
  return c;
}

describe('T-CL-6: redial outcomes', () => {
  it('ok / retry / kicked / superseded', async () => {
    expect(await redial(fakeClient(), { url: 'ws://10.0.0.5:7779', name: 'NovaPilot' })).toEqual({ result: 'ok', tokenAccepted: true });
    expect(await redial(fakeClient(), { url: 'ws://10.0.0.5:7779', name: 'NovaPilot', token: 't' })).toEqual({ result: 'ok', tokenAccepted: false });
    expect(await redial(fakeClient({ account: { username: 'NovaPilot' } }), { url: 'ws://x', name: 'n', token: 't' }))
      .toEqual({ result: 'ok', tokenAccepted: true });
    const down = fakeClient({ fail: new Error('Could not connect to ws://10.0.0.5:7779') });
    expect(await redial(down, { url: 'ws://10.0.0.5:7779', name: 'n' })).toEqual({ result: 'retry', error: 'Could not connect to ws://10.0.0.5:7779' });
    expect(down.disconnects).toBe(1);
    expect(await redial(fakeClient({ fail: new Error('Banned'), closeKicked: true }), { url: 'ws://x', name: 'n' })).toEqual({ result: 'stop', kicked: 'Banned' });
    expect(await redial(fakeClient({ fail: new ConnectSuperseded() }), { url: 'ws://x', name: 'n' })).toEqual({ result: 'stop', kicked: null });
  });

  it('an error before welcome (a protocol mismatch after an update) stops at once with that message', async () => {
    const c = fakeClient({ script: (cl) => { cl.emitError(MISMATCH); return new Promise<void>(() => { /* no welcome ever */ }); } });
    const t0 = Date.now();
    expect(await redial(c, { url: 'ws://10.0.0.5:7779', name: 'n' })).toEqual({ result: 'stop', kicked: MISMATCH });
    expect(Date.now() - t0).toBeLessThan(1000); // not the 8 s hello timeout
    expect(c.disconnects).toBe(1);
  });

  it('"Session expired" before welcome is not a refusal: welcome (as a guest) follows it', async () => {
    const c = fakeClient({ script: async (cl) => { cl.emitError('Session expired — please log in again'); } });
    expect(await redial(c, { url: 'ws://x', name: 'n', token: 'old' })).toEqual({ result: 'ok', tokenAccepted: false });
    expect(c.disconnects).toBe(0);
  });

  it('an error after welcome is left to the normal handlers', async () => {
    const c = fakeClient();
    expect((await redial(c, { url: 'ws://x', name: 'n' })).result).toBe('ok');
    c.emitError('That room is full.'); // the listener is gone
    expect(c.disconnects).toBe(0);
  });
});

describe('T-CL-6: SessionRetry (the main.ts wiring): a logout ends the retry', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  const account: RedialSession = { url: 'ws://10.0.0.5:7779', name: 'NovaPilot', token: 'tok-1' };

  function harness(client: FakeClient, token: { current: string | null }, extra: { canAttempt?: () => boolean } = {}) {
    const statuses: ReconnectStatus[] = [];
    const reconnected: { s: RedialSession; accepted: boolean }[] = [];
    const refused: string[] = [];
    const retry = new SessionRetry({
      client, currentToken: () => token.current, canAttempt: extra.canAttempt,
      onStatus: (s) => statuses.push(s),
      onReconnected: (s, accepted) => reconnected.push({ s, accepted }),
      onRefused: (m) => refused.push(m),
      random: () => 0.5,
    });
    return { retry, statuses, reconnected, refused };
  }

  it('redialAllowed: an account session needs the same token; a guest session always may', () => {
    expect(redialAllowed(account, 'tok-1')).toBe(true);
    expect(redialAllowed(account, null)).toBe(false);
    expect(redialAllowed(account, 'tok-2')).toBe(false); // someone else logged in on this PC
    expect(redialAllowed({ url: 'ws://x', name: 'Guest' }, null)).toBe(true);
  });

  it('a logout while waiting: no redial with the old token, ever', async () => {
    const c = fakeClient({ account: { username: 'NovaPilot' } });
    const token = { current: 'tok-1' as string | null };
    const h = harness(c, token);
    h.retry.start(account, HOST_LOST_TEXT);
    token.current = null; // Title: Log out (clearSession) during the countdown
    await vi.advanceTimersByTimeAsync(RETRY_WINDOW_MS + 5000);
    expect(c.dials).toEqual([]);
    expect(h.reconnected).toEqual([]);
    expect(h.statuses[h.statuses.length - 1]).toMatchObject({ state: 'stopped' });
    expect(h.retry.active).toBe(false);
  });

  it('another account on the Title: the old one is not redialled', async () => {
    const c = fakeClient({ account: { username: 'NovaPilot' } });
    const h = harness(c, { current: 'tok-2' });
    h.retry.start(account, HOST_LOST_TEXT);
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.dials).toEqual([]);
  });

  it('stop() (main.ts onLogout) aborts an attempt in flight: the account never lands on Command', async () => {
    let welcome: () => void = () => {};
    const c = fakeClient({ account: { username: 'NovaPilot' }, script: () => new Promise<void>((res) => { welcome = res; }) });
    const h = harness(c, { current: 'tok-1' });
    h.retry.start(account, HOST_LOST_TEXT);
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.dials).toEqual([{ url: account.url, name: 'NovaPilot', token: 'tok-1' }]); // the hello is on its way
    expect(h.retry.stop()).toBe(true);
    welcome(); // too late: the attempt was superseded
    await vi.advanceTimersByTimeAsync(RETRY_WINDOW_MS);
    expect(c.disconnects).toBeGreaterThanOrEqual(1);
    expect(c.welcomed).toBe(false);
    expect(h.reconnected).toEqual([]);
    expect(c.dials).toHaveLength(1);
    expect(h.retry.active).toBe(false);
  });

  it('a guest session retries whatever the Title holds; back in once, then done', async () => {
    let n = 0;
    const c = fakeClient({ script: async () => { if (++n < 3) throw new Error('Could not connect'); } });
    const h = harness(c, { current: null });
    h.retry.start({ url: 'ws://10.0.0.5:7779', name: 'Guest7' }, HOST_LOST_TEXT);
    await vi.advanceTimersByTimeAsync(RETRY_WINDOW_MS);
    expect(c.dials).toHaveLength(3);
    expect(h.reconnected).toEqual([{ s: { url: 'ws://10.0.0.5:7779', name: 'Guest7' }, accepted: true }]);
    expect(h.statuses[h.statuses.length - 1]!.state).toBe('connected');
  });

  it('a refusal ends it through onRefused; the player connecting (canAttempt false) stands it down', async () => {
    const kicked = fakeClient({ fail: new Error('Banned'), closeKicked: true });
    const a = harness(kicked, { current: null });
    a.retry.start({ url: 'ws://x', name: 'n' }, HOST_LOST_TEXT);
    await vi.advanceTimersByTimeAsync(5000);
    expect(a.refused).toEqual(['Banned']);
    expect(kicked.dials).toHaveLength(1);

    const busy = fakeClient();
    const b = harness(busy, { current: null }, { canAttempt: () => false });
    b.retry.start({ url: 'ws://x', name: 'n' }, HOST_LOST_TEXT);
    await vi.advanceTimersByTimeAsync(5000);
    expect(busy.dials).toEqual([]);
    expect(b.statuses[b.statuses.length - 1]!.state).toBe('stopped');
  });
});

// ---------------------------------------------------------------------------------------------------- real sockets

interface FakeZone {
  server: Server; wss: WebSocketServer; url: string; accepting: boolean; hellos: number; sockets: Set<WsSocket>;
  /** Answer hello the way the Zone answers a protocol mismatch: an 'error' message, the socket left open. */
  mismatch: boolean;
  /** Hold each welcome this long (an attempt stays in flight). */
  welcomeDelayMs: number;
  /** The host went quiet (asleep, unplugged) with the TCP connection still up: nothing is answered, nothing closes. */
  silent: boolean;
}

/** A minimal game server: answers `hello` with `welcome`; while `accepting` is false it drops every upgrade. */
async function fakeZone(): Promise<FakeZone> {
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const z: FakeZone = { server, wss, url: '', accepting: true, hellos: 0, sockets: new Set(), mismatch: false, welcomeDelayMs: 0, silent: false };
  server.on('upgrade', (req, socket: Socket, head) => {
    if (!z.accepting) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      z.sockets.add(ws);
      ws.on('close', () => z.sockets.delete(ws));
      ws.on('message', (data) => {
        if (z.silent) return;
        let m: { type?: string; name?: string; t?: number };
        try { m = JSON.parse(String(data)) as typeof m; } catch { return; }
        if (m.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', t: m.t ?? 0 })); return; }
        if (m.type !== 'hello') return;
        z.hellos++;
        if (z.mismatch) { ws.send(JSON.stringify({ type: 'error', message: MISMATCH })); return; }
        const welcome = JSON.stringify({ type: 'welcome', playerId: z.hellos, name: m.name ?? 'Pilot', serverVersion: 'test', motd: '', account: null });
        if (z.welcomeDelayMs > 0) setTimeout(() => { if (ws.readyState === ws.OPEN) ws.send(welcome); }, z.welcomeDelayMs);
        else ws.send(welcome);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  z.url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return z;
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(typeof WebSocket === 'undefined')('T-CL-6 over a real WebSocket: GameClient + SessionRetry (main.ts wiring)', () => {
  let zone: FakeZone | null = null;
  let client: GameClient | null = null;
  let retry: SessionRetry | null = null;
  afterEach(async () => {
    retry?.stop();
    client?.disconnect(true);
    if (zone) {
      for (const s of zone.sockets) s.terminate();
      zone.wss.close();
      await new Promise<void>((r) => zone!.server.close(() => r()));
    }
    zone = null; client = null; retry = null;
  });

  /** Wires a GameClient the way main.ts does: a close of a live session starts the SessionRetry with its notice. */
  async function session(opts: { windowMs?: number; token?: string; pingIntervalMs?: number; silenceMs?: number } = {}) {
    zone = await fakeZone();
    const c = new GameClient(null);
    if (opts.pingIntervalMs) c.pingIntervalMs = opts.pingIntervalMs;
    if (opts.silenceMs) c.silenceMs = opts.silenceMs;
    client = c;
    const statuses: ReconnectStatus[] = [];
    const closes: { reason: string; code: number | undefined; kind: string; notice: string }[] = [];
    const refused: string[] = [];
    const reconnected: RedialSession[] = [];
    const s: RedialSession = { url: zone.url, name: 'NovaPilot', token: opts.token };
    const titleToken = { current: opts.token ?? null };
    const r = new SessionRetry({
      client: c,
      currentToken: () => titleToken.current,
      onStatus: (st) => statuses.push(st),
      onReconnected: (rs) => reconnected.push(rs),
      onRefused: (m) => refused.push(m),
      windowMs: opts.windowMs,
      random: () => 0.5,
    });
    retry = r;
    c.on('close', (reason) => {
      if (r.active) return;
      const kind = classifyClose(reason, c.closeCode);
      const notice = closeNoticeText(kind, reason, s.url);
      closes.push({ reason, code: c.closeCode, kind, notice });
      if (kind !== 'kicked') r.start(s, notice);
    });
    await c.connectOnline(zone.url, s.name, s.token);
    expect(c.welcomed).toBe(true);
    return { c, r, statuses, closes, refused, reconnected, titleToken, z: zone };
  }

  it('the host stops: host-lost text, failed retries while it is down, back in once it is up', async () => {
    const { c, r, statuses, closes, reconnected, z } = await session();
    z.accepting = false;
    for (const s of z.sockets) s.close(1001, 'server shutting down');
    await until(() => closes.length === 1);
    expect(closes[0]).toMatchObject({ reason: 'server shutting down', code: 1001, kind: 'lost', notice: HOST_LOST_TEXT });
    expect(c.connected).toBe(false);
    expect(statuses[0]).toMatchObject({ state: 'waiting', text: `${HOST_LOST_TEXT} · Reconnecting… 60 s` });
    await until(() => statuses.some((s) => s.state === 'trying')); // the 1 s attempt, refused
    await until(() => statuses.some((s) => s.state === 'waiting' && s.attempts === 1));
    expect(c.welcomed).toBe(false);
    z.accepting = true; // the host is back: the 3 s attempt gets in
    await until(() => statuses.some((s) => s.state === 'connected'));
    expect(c.welcomed).toBe(true);
    expect(z.hellos).toBe(2);
    expect(r.active).toBe(false);
    expect(reconnected).toHaveLength(1);
    expect(statuses.filter((s) => s.state === 'trying').length).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it('the host goes silent (TCP still up, no close ever): noticed, host-lost text, retried, back in once it answers', async () => {
    // the ping cadence and silence window shortened 10x (the defaults: silence.test.ts, client.test.ts)
    const { c, statuses, closes, reconnected, z } = await session({ pingIntervalMs: 200, silenceMs: 1000 });
    await new Promise((res) => setTimeout(res, 600)); // a few answered pings first
    expect(closes).toEqual([]);
    const quietAt = Date.now();
    z.silent = true;
    await until(() => closes.length === 1, 5000);
    const noticedMs = Date.now() - quietAt;
    expect(noticedMs).toBeGreaterThanOrEqual(800);
    expect(noticedMs).toBeLessThan(3000); // silence 1 s + at most one ping interval, with CI headroom
    expect(closes[0]).toMatchObject({ reason: SILENT_CLOSE_REASON, code: undefined, kind: 'lost', notice: HOST_LOST_TEXT });
    expect(statuses[0]).toMatchObject({ state: 'waiting', text: `${HOST_LOST_TEXT} · Reconnecting… 60 s` });
    expect(c.connected).toBe(false);
    await until(() => z.sockets.size === 0); // the dead connection was closed, not left open
    z.silent = false; // the host woke up
    await until(() => statuses.some((s) => s.state === 'connected'));
    expect(c.welcomed).toBe(true);
    expect(reconnected).toHaveLength(1);
    expect(z.hellos).toBe(2);
    // and the new session is watched too: a quiet spell short of the window is no alarm
    z.silent = true;
    await new Promise((res) => setTimeout(res, 500));
    z.silent = false;
    await new Promise((res) => setTimeout(res, 1200));
    expect(closes).toHaveLength(1);
    expect(c.connected).toBe(true);
  }, 20_000);

  it('a refused attempt rejects with its own error and is not reported as a lost session (WsTransport)', async () => {
    const { c, closes, z } = await session();
    c.disconnect(true);
    z.accepting = false;
    await expect(c.connectOnline(z.url, 'NovaPilot')).rejects.toThrow(/^Could not connect to ws:\/\/127\.0\.0\.1:/);
    await new Promise((res) => setTimeout(res, 100));
    expect(closes).toHaveLength(0);
    expect(c.closeKicked).toBe(false);
  }, 20_000);

  it('a planned restart: the server\'s reason reaches the player, then it reconnects', async () => {
    const { c, statuses, closes, z } = await session();
    for (const s of z.sockets) s.close(WS_CLOSE_SERVICE_RESTART, 'Server restarting — back in about 20 s');
    await until(() => closes.length === 1);
    expect(closes[0]).toMatchObject({ code: WS_CLOSE_SERVICE_RESTART, kind: 'restart', notice: RESTART_TEXT });
    expect(statuses[0]!.text).toContain('back in about 20 s');
    await until(() => statuses.some((s) => s.state === 'connected'));
    expect(c.welcomed).toBe(true);
  }, 20_000);

  it('a kick (4001) is never retried', async () => {
    const { r, closes, z } = await session();
    for (const s of z.sockets) s.close(WS_CLOSE_KICKED, 'Session ended — please log in again');
    await until(() => closes.length === 1);
    expect(closes[0]).toMatchObject({ kind: 'kicked', code: WS_CLOSE_KICKED });
    expect(r.active).toBe(false);
    await new Promise((res) => setTimeout(res, 1500));
    expect(z.hellos).toBe(1);
  }, 20_000);

  it('gives up when the window ends with the host still down', async () => {
    const { c, statuses, z } = await session({ windowMs: 2500 });
    z.accepting = false;
    for (const s of z.sockets) s.close(1001, 'server shutting down');
    await until(() => statuses.some((s) => s.state === 'gaveUp'));
    expect(statuses[statuses.length - 1]).toMatchObject({ state: 'gaveUp', text: HOST_LOST_TEXT, attempts: 1 });
    expect(c.connected).toBe(false);
  }, 20_000);

  it('the server came back on a new protocol: one clear refusal, no 8 s waits, no more attempts', async () => {
    const { c, statuses, refused, z } = await session();
    z.mismatch = true;
    for (const s of z.sockets) s.close(1001, 'server shutting down');
    await until(() => refused.length === 1, 5000); // well inside the 8 s hello timeout
    expect(refused).toEqual([MISMATCH]);
    expect(statuses[statuses.length - 1]!.state).toBe('stopped');
    expect(c.connected).toBe(false);
    await new Promise((res) => setTimeout(res, 2500));
    expect(z.hellos).toBe(2); // the first session's hello and the one refused attempt
  }, 20_000);

  it('Log out during the countdown: the host comes back, the old account is not redialled', async () => {
    const { c, statuses, reconnected, titleToken, z } = await session({ token: 'tok-1' });
    z.accepting = false;
    for (const s of z.sockets) s.close(1001, 'server shutting down');
    await until(() => statuses.some((s) => s.state === 'waiting'));
    titleToken.current = null; // TitleScreen.logout → clearSession (and main.ts onLogout → stop, tested above)
    z.accepting = true;
    await until(() => statuses.some((s) => s.state === 'stopped'));
    await new Promise((res) => setTimeout(res, 1500));
    expect(z.hellos).toBe(1);
    expect(reconnected).toEqual([]);
    expect(c.welcomed).toBe(false);
  }, 20_000);

  it('Log out while an attempt is in flight: stop() aborts it, and the late welcome is not kept', async () => {
    const { c, r, statuses, reconnected, z } = await session({ token: 'tok-1' });
    z.welcomeDelayMs = 600;
    for (const s of z.sockets) s.close(1001, 'server shutting down');
    await until(() => z.hellos === 2); // the retry's hello reached the server; its welcome is 600 ms away
    expect(statuses[statuses.length - 1]!.state).toBe('trying');
    expect(r.stop()).toBe(true); // main.ts onLogout
    await new Promise((res) => setTimeout(res, 1200));
    expect(c.welcomed).toBe(false);
    expect(c.connected).toBe(false);
    expect(reconnected).toEqual([]);
    expect(z.sockets.size).toBe(0); // the attempt's socket was closed
  }, 20_000);
});
