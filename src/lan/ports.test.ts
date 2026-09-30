import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTO_PICK_LAST_GAME_PORT, candidatePairs, choosePorts, DEFAULT_GAME_PORT, findPortHolders, parseNetstat, parseTasklist, probePort,
  type PortProbe,
} from './ports';

const FORBIDDEN = new Set([7777, 7778, 5173, 5621]);
const servers: net.Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
  }
});

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT'));
    s.listen({ host, port }, () => s.close(() => resolve(true)));
  });
}

/** A base port P (even) with P … P+count-1 free on 127.0.0.1 and ::1, far from the owner's ports. */
async function freeBase(count: number): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const p = 20000 + 2 * Math.floor(Math.random() * 10000);
    let ok = true;
    for (let i = 0; i < count && ok; i++) {
      if (FORBIDDEN.has(p + i)) ok = false;
      else ok = (await canBind(p + i, '127.0.0.1')) && (await canBind(p + i, '::1'));
    }
    if (ok) return p;
  }
  throw new Error('no free port range');
}

function hold(port: number, host = '127.0.0.1'): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer((c) => c.destroy());
    s.once('error', reject);
    s.listen({ host, port }, () => {
      servers.push(s);
      resolve(s);
    });
  });
}

describe('port pairs', () => {
  it('Home\'s first-run candidates are 7777/7778, 7779/7780 … 7797/7798', () => {
    const c = candidatePairs();
    expect(c[0]).toEqual({ game: DEFAULT_GAME_PORT, admin: DEFAULT_GAME_PORT + 1 });
    expect(c[1]).toEqual({ game: 7779, admin: 7780 });
    expect(c.at(-1)).toEqual({ game: AUTO_PICK_LAST_GAME_PORT, admin: AUTO_PICK_LAST_GAME_PORT + 1 });
    expect(c).toHaveLength(11);
  });
});

describe('netstat / tasklist parsing', () => {
  it('reads listeners from the foreign address, not the localized State column', () => {
    const text = [
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4',
      '  TCP    127.0.0.1:7777         0.0.0.0:0              ABHÖREN         9120',
      '  TCP    192.168.1.50:7777      192.168.1.77:51234     ESTABLISHED     9120',
      '  TCP    [::]:7778              [::]:0                 LISTENING       9120',
      '  TCP    [fe80::1%12]:7779      [::]:0                 LISTENING       300',
      '  UDP    0.0.0.0:5353           *:*                                    2200',
    ].join('\r\n');
    const rows = parseNetstat(text);
    expect(rows.filter((r) => r.listening).map((r) => [r.address, r.port, r.pid])).toEqual([
      ['0.0.0.0', 445, 4],
      ['127.0.0.1', 7777, 9120],
      ['::', 7778, 9120],
      ['fe80::1', 7779, 300],
    ]);
    expect(rows.find((r) => r.address === '192.168.1.50')?.listening).toBe(false);
  });

  it('reads tasklist CSV', () => {
    const m = parseTasklist('"node.exe","9120","Console","1","61,204 K"\r\n"System","4","Services","0","144 K"\r\n');
    expect(m.get(9120)).toBe('node.exe');
    expect(m.get(4)).toBe('System');
    expect(parseTasklist('INFO: No tasks are running which match the specified criteria.').size).toBe(0);
  });
});

describe('the busy probe', () => {
  it('a server on 127.0.0.1 only is found by the connect probe (no shadowing on ::1 or the LAN address)', async () => {
    const p = await freeBase(2);
    await hold(p, '127.0.0.1');
    const r = await probePort(p);
    expect(r.busy).toBe(true);
    expect(r.answeredOn).toContain('127.0.0.1');
    const free = await probePort(p + 1);
    expect(free).toMatchObject({ busy: false, answeredOn: [], bindFailed: [] });
  });

  it('connects to the primary LAN address but never binds it (no firewall prompt from the parent)', async () => {
    const connected: string[] = [];
    const bound: string[] = [];
    const opts = {
      primary: '192.168.1.50',
      connectFn: async (h: string) => (connected.push(h), 'refused' as const),
      bindFn: async (h: string) => (bound.push(h), null),
    };
    const r = await probePort(7777, opts);
    expect(r.busy).toBe(false);
    expect(connected.sort()).toEqual(['127.0.0.1', '192.168.1.50', '::1']);
    expect(bound.sort()).toEqual(['127.0.0.1', '::1']);

    // A holder on the primary only is still found, by the connect.
    const onPrimary = await probePort(7777, { ...opts, connectFn: async (h: string) => (h === '192.168.1.50' ? 'answered' : 'refused') });
    expect(onPrimary).toMatchObject({ busy: true, answeredOn: ['192.168.1.50'] });

    // A non-loopback address passed in `hosts` is never bound either.
    bound.length = 0;
    const r2 = await probePort(7777, { primary: '10.0.0.8', hosts: ['127.0.0.1', '10.0.0.8'], connectFn: async () => 'refused', bindFn: async (h) => (bound.push(h), null) });
    expect(r2.busy).toBe(false);
    expect(bound).toEqual(['127.0.0.1']);
  });

  it('the real probe with a primary address only connects to it (no listen on non-loopback)', async () => {
    const p = await freeBase(2);
    const listens: string[] = [];
    const orig = net.Server.prototype.listen;
    net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
      const o = args[0] as { host?: string } | undefined;
      if (o && typeof o === 'object') listens.push(String(o.host));
      return (orig as (...a: unknown[]) => net.Server).apply(this, args);
    } as typeof orig;
    try {
      // 192.0.2.1 (TEST-NET-1) is not on this PC: the connect fails fast or times out; it must never be bound.
      const r = await probePort(p, { primary: '192.0.2.1', timeoutMs: 300 });
      expect(r.busy).toBe(false);
      // And through choosePorts' default probe.
      const c = await choosePorts({ preset: 'home', stored: null, primary: '192.0.2.1', firstGamePort: p, lastGamePort: p });
      expect(c).toMatchObject({ ok: true, plan: { game: p, admin: p + 1 } });
    } finally {
      net.Server.prototype.listen = orig;
    }
    expect(listens.every((h) => h === '127.0.0.1' || h === '::1')).toBe(true);
    expect(listens.length).toBe(6); // P alone, then P and P+1 through choosePorts; two loopback binds each
  });
});

describe('T-LAN-1: choosing the pair', () => {
  it('Home, first run: 127.0.0.1:P busy → the next free pair, persisted', async () => {
    const p = await freeBase(6);
    await hold(p, '127.0.0.1');
    const r = await choosePorts({ preset: 'home', stored: null, firstGamePort: p, lastGamePort: p + 4 });
    expect(r).toMatchObject({ ok: true, plan: { game: p + 2, admin: p + 3 }, persist: true });
    if (r.ok) expect(r.note).toContain(String(p));
  });

  it('Home, first run: a busy admin port (P+1) also moves the pair', async () => {
    const p = await freeBase(4);
    await hold(p + 1, '127.0.0.1');
    const r = await choosePorts({ preset: 'home', stored: null, firstGamePort: p, lastGamePort: p + 2 });
    expect(r).toMatchObject({ ok: true, plan: { game: p + 2, admin: p + 3 } });
  });

  it('Home, first run with the default free: the default is stored', async () => {
    const p = await freeBase(2);
    const r = await choosePorts({ preset: 'home', stored: null, firstGamePort: p, lastGamePort: p + 2 });
    expect(r).toMatchObject({ ok: true, plan: { game: p, admin: p + 1 }, persist: true, note: null });
  });

  it('School refuses with the holder\'s process name and "change the port in Settings"', async () => {
    const p = await freeBase(4);
    await hold(p, '127.0.0.1');
    const r = await choosePorts({ preset: 'school', stored: null, firstGamePort: p, lastGamePort: p + 2 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/change the port in Settings/);
    expect(r.message).toMatch(/never picks another port/);
    expect(r.busy[0]).toMatchObject({ port: p, role: 'game' });
    if (process.platform === 'win32') {
      expect(r.busy[0].holders.some((h) => h.pid === process.pid && /^node(\.exe)?$/i.test(h.process ?? ''))).toBe(true);
      expect(r.message).toMatch(/node\.exe \(PID \d+\)/i);
    }
  });

  it('Home after the first run never moves a stored pair', async () => {
    const p = await freeBase(4);
    await hold(p, '127.0.0.1');
    const r = await choosePorts({ preset: 'home', stored: { game: p, admin: p + 1 }, firstGamePort: p, lastGamePort: p + 2 });
    expect(r.ok).toBe(false);
    const ok = await choosePorts({ preset: 'school', stored: { game: p + 2, admin: p + 3 } });
    expect(ok).toMatchObject({ ok: true, plan: { game: p + 2, admin: p + 3 }, persist: false });
  });

  it('every pair busy, a reserved range, and standard ports (mocked probe)', async () => {
    const busy = (port: number): PortProbe => ({ port, busy: true, answeredOn: ['127.0.0.1'], bindFailed: [] });
    const all = await choosePorts({ preset: 'home', stored: null, probe: async (port) => busy(port), holders: async () => [] });
    expect(all.ok).toBe(false);
    if (!all.ok) expect(all.message).toMatch(/Every port pair from 7777 to 7798/);

    const reserved = await choosePorts({
      preset: 'school', stored: { game: 7777, admin: 7778 },
      probe: async (port) => (port === 7777 ? { port, busy: true, answeredOn: [], bindFailed: [{ host: '127.0.0.1', code: 'EACCES' }] } : { port, busy: false, answeredOn: [], bindFailed: [] }),
      holders: async () => [],
    });
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) {
      expect(reserved.busy[0].reserved).toBe(true);
      expect(reserved.message).toMatch(/reserved port range/);
    }

    const probed: number[] = [];
    const std = await choosePorts({
      preset: 'school', stored: { game: 7777, admin: 7778 }, standardPorts: true,
      probe: async (port) => (probed.push(port), { port, busy: false, answeredOn: [], bindFailed: [] }),
    });
    expect(std).toMatchObject({ ok: true, plan: { game: 443, http: 80, admin: 7778 }, persist: false });
    expect(probed.sort((a, b) => a - b)).toEqual([80, 443, 7778]);

    const sys = await choosePorts({
      preset: 'school', stored: { game: 7777, admin: 7778 }, standardPorts: true,
      probe: async (port) => (port === 80 ? busy(80) : { port, busy: false, answeredOn: [], bindFailed: [] }),
      holders: async () => [{ port: 80, address: '0.0.0.0', pid: 4, process: 'System' }],
    });
    if (!sys.ok) expect(sys.message).toMatch(/Port 80 \(plain http\) is in use by Windows itself/);
    else throw new Error('expected a refusal');
  });

  it.skipIf(process.platform !== 'win32')('finds a real holder with netstat + tasklist', async () => {
    const p = await freeBase(2);
    await hold(p, '127.0.0.1');
    const h = await findPortHolders([p]);
    expect(h).toEqual([expect.objectContaining({ port: p, address: '127.0.0.1', pid: process.pid })]);
  });
});
