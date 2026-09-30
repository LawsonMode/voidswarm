// LAN edition: the port pair and the busy probe (§2.2 step 11, T-LAN-1).
//
// The game port P (default 7777) and the admin port A = P+1 are chosen once and stored in the config.
// - Home, first run: if 7777/7778 is busy, take the first free pair up to 7797 (7779/7780, 7781/7782, …).
// - School, or any later run: never pick a port by itself; refuse with the name of the process
//   holding it (netstat -ano + tasklist) and "change the port in Settings".
// - The busy probe connects to 127.0.0.1:P, [::1]:P and primary:P (anything that answers means
//   busy), then binds 127.0.0.1 and ::1 only. The connect catches a server holding only
//   127.0.0.1:P, which Windows would otherwise let us shadow on another address (the owner's live
//   server does exactly that). The primary (LAN) address is NEVER bound here: the parent opens no
//   network port (§2.2), and a listen on a LAN address by runtime\node.exe raises the Windows
//   Firewall prompt before the first-run Network check has explained it (§3.5). Anything already
//   bound on primary answers the connect; reserved ranges (EACCES) cover every address, so the
//   loopback binds find them.
// - Advanced: "standard ports" (443 plus 80, admin stays on its own port).

import net from 'node:net';
import { execTool, systemTool, type ExecFn, type Platform, type Preset } from './paths';

export const DEFAULT_GAME_PORT = 7777;
/** The last game port Home's first-run auto-pick may use (its admin port is one higher). */
export const AUTO_PICK_LAST_GAME_PORT = 7797;
export const STANDARD_HTTPS_PORT = 443;
export const STANDARD_HTTP_PORT = 80;

export interface PortPlan {
  game: number;
  admin: number;
  /** Standard ports only: the plain-http port (80) beside the game's 443. */
  http?: number;
}

export function pairFor(game: number): PortPlan {
  return { game, admin: game + 1 };
}

/** Candidate pairs for the Home first-run pick: P, P+2, … up to `last` (defaults 7777 … 7797). */
export function candidatePairs(first = DEFAULT_GAME_PORT, last = AUTO_PICK_LAST_GAME_PORT): PortPlan[] {
  const out: PortPlan[] = [];
  for (let p = first; p <= last; p += 2) out.push(pairFor(p));
  return out;
}

export function isValidPort(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535;
}

export function planPorts(plan: PortPlan): number[] {
  return [plan.game, plan.admin, ...(plan.http ? [plan.http] : [])];
}

// --- the probe -------------------------------------------------------------------------------

export interface PortProbe {
  port: number;
  busy: boolean;
  /** Addresses where something accepted a connection. */
  answeredOn: string[];
  /** Addresses where our own bind failed, with the error code (EADDRINUSE, EACCES, …). */
  bindFailed: { host: string; code: string }[];
}

export type ConnectOutcome = 'answered' | 'refused' | 'absent' | 'timeout';

export interface ProbeOptions {
  /** Loopback addresses to connect to and bind (default 127.0.0.1 and ::1). */
  hosts?: string[];
  /** The LAN address: connect-probed only, never bound. */
  primary?: string | null;
  /** Per-connect timeout (default 400 ms). */
  timeoutMs?: number;
  /** Also try to bind the loopback addresses (default true). */
  bind?: boolean;
  /** Injectable for tests. */
  connectFn?: (host: string, port: number, timeoutMs: number) => Promise<ConnectOutcome>;
  /** Injectable for tests: resolves the bind error code, or null when the bind worked. */
  bindFn?: (host: string, port: number) => Promise<string | null>;
}

/** Codes that mean "this address isn't on this PC" rather than "busy". */
const ABSENT = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENETUNREACH', 'EHOSTUNREACH', 'EINVAL', 'ENOTFOUND', 'EPROTONOSUPPORT']);

function tryConnect(host: string, port: number, timeoutMs: number): Promise<ConnectOutcome> {
  return new Promise((resolve) => {
    let done = false;
    const sock = net.connect({ host, port });
    const finish = (r: ConnectOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    sock.once('connect', () => finish('answered'));
    sock.once('error', (e: NodeJS.ErrnoException) => finish(e.code && ABSENT.has(e.code) ? 'absent' : 'refused'));
  });
}

function tryBind(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'ERROR'));
    srv.listen({ host, port, exclusive: true, ipv6Only: host.includes(':') }, () => srv.close(() => resolve(null)));
  });
}

const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];

/** The addresses the probe connects to: loopback, plus the primary LAN address. */
export function probeHosts(opts: Pick<ProbeOptions, 'hosts' | 'primary'> = {}): string[] {
  const hosts = opts.hosts ?? LOOPBACK_HOSTS;
  return opts.primary && !hosts.includes(opts.primary) ? [...hosts, opts.primary] : hosts;
}

/** The addresses the probe may bind: loopback only (never the primary, see the header). */
export function bindHosts(opts: Pick<ProbeOptions, 'hosts' | 'primary'> = {}): string[] {
  return (opts.hosts ?? LOOPBACK_HOSTS).filter((h) => h !== opts.primary && isLoopback(h));
}

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === '::1' || h === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** Is anything on this port, on any of our addresses? */
export async function probePort(port: number, opts: ProbeOptions = {}): Promise<PortProbe> {
  const hosts = probeHosts(opts);
  const timeoutMs = opts.timeoutMs ?? 400;
  const connect = opts.connectFn ?? tryConnect;
  const bind = opts.bindFn ?? tryBind;
  const answeredOn: string[] = [];
  const bindFailed: { host: string; code: string }[] = [];
  const results = await Promise.all(hosts.map((h) => connect(h, port, timeoutMs)));
  hosts.forEach((h, i) => {
    if (results[i] === 'answered') answeredOn.push(h);
  });
  if (!answeredOn.length && opts.bind !== false) {
    for (const h of bindHosts(opts)) {
      const code = await bind(h, port);
      if (code && !ABSENT.has(code)) bindFailed.push({ host: h, code });
    }
  }
  return { port, busy: answeredOn.length > 0 || bindFailed.length > 0, answeredOn, bindFailed };
}

// --- who holds a port ------------------------------------------------------------------------

export interface NetstatRow {
  proto: 'TCP' | 'UDP';
  address: string;
  port: number;
  pid: number;
  listening: boolean;
}

/**
 * Parses `netstat -ano`. The State column is localized, so "listening" is read from the foreign
 * address instead (0.0.0.0:0 / [::]:0), which is the same in every language.
 */
export function parseNetstat(text: string): NetstatRow[] {
  const rows: NetstatRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const f = raw.trim().split(/\s+/);
    if (f.length < 4 || !/^(TCP|UDP)$/i.test(f[0])) continue;
    const proto = f[0].toUpperCase() as 'TCP' | 'UDP';
    const local = f[1];
    const foreign = f[2];
    const pid = Number(f[f.length - 1]);
    const m = /^(.*):(\d+)$/.exec(local);
    if (!m || !Number.isInteger(pid)) continue;
    rows.push({
      proto,
      address: m[1].replace(/^\[|\]$/g, '').replace(/%\d+$/, ''),
      port: Number(m[2]),
      pid,
      listening: proto === 'TCP' ? /^(0\.0\.0\.0|\[::\]):0$/.test(foreign) : false,
    });
  }
  return rows;
}

/** Parses `tasklist /fo csv /nh` into pid → image name. */
export function parseTasklist(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(raw.trim());
    if (m) out.set(Number(m[2]), m[1]);
  }
  return out;
}

export interface PortHolder {
  port: number;
  address: string;
  pid: number | null;
  /** node.exe, System, … (null when unknown). */
  process: string | null;
}

/** Which processes listen on these ports (Windows: netstat + tasklist; elsewhere: unknown). */
export async function findPortHolders(ports: number[], opts: { exec?: ExecFn; platform?: Platform } = {}): Promise<PortHolder[]> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return [];
  const exec = opts.exec ?? execTool;
  const [v4, v6] = await Promise.all([
    exec(systemTool('netstat'), ['-ano', '-p', 'TCP'], { timeoutMs: 15_000 }),
    exec(systemTool('netstat'), ['-ano', '-p', 'TCPv6'], { timeoutMs: 15_000 }),
  ]);
  const want = new Set(ports);
  const rows = [...parseNetstat(v4.stdout ?? ''), ...parseNetstat(v6.stdout ?? '')].filter((r) => r.listening && want.has(r.port));
  const names = new Map<number, string>();
  for (const pid of new Set(rows.map((r) => r.pid))) {
    const t = await exec(systemTool('tasklist'), ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], { timeoutMs: 15_000 });
    const name = parseTasklist(t.stdout ?? '').get(pid);
    if (name) names.set(pid, name);
  }
  const seen = new Set<string>();
  const out: PortHolder[] = [];
  for (const r of rows) {
    const k = `${r.port}|${r.pid}|${r.address}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ port: r.port, address: r.address, pid: r.pid, process: names.get(r.pid) ?? null });
  }
  return out;
}

export function holderText(h: PortHolder): string {
  if (h.pid === 4) return 'Windows itself (System, often the HTTP service or IIS)';
  if (h.process) return `${h.process} (PID ${h.pid})`;
  if (h.pid !== null) return `a program with PID ${h.pid}`;
  return 'another program';
}

// --- the choice ------------------------------------------------------------------------------

export interface ChoosePortsOptions {
  preset: Preset;
  /** The pair stored in the config; null on the first run. */
  stored: PortPlan | null;
  /** Settings → Network → standard ports (443 + 80). */
  standardPorts?: boolean;
  primary?: string | null;
  /** Home first-run candidates (defaults 7777 … 7797); tests pass ephemeral ranges. */
  firstGamePort?: number;
  lastGamePort?: number;
  probe?: (port: number) => Promise<PortProbe>;
  holders?: (ports: number[]) => Promise<PortHolder[]>;
}

export interface BusyPort {
  port: number;
  role: 'game' | 'admin' | 'http';
  holders: PortHolder[];
  /** EACCES on Windows usually means a reserved range (Hyper-V / WSL). */
  reserved: boolean;
}

export type ChoosePortsResult =
  | {
      ok: true;
      plan: PortPlan;
      /** True when the caller must store `plan` in the config (first run, or an auto-pick). */
      persist: boolean;
      /** Set when Home's first run moved off the default pair. */
      note: string | null;
    }
  | { ok: false; busy: BusyPort[]; message: string };

async function busyPorts(plan: PortPlan, probe: (port: number) => Promise<PortProbe>): Promise<{ port: number; role: BusyPort['role']; probe: PortProbe }[]> {
  const roles: [number, BusyPort['role']][] = [[plan.game, 'game'], [plan.admin, 'admin']];
  if (plan.http) roles.push([plan.http, 'http']);
  const out: { port: number; role: BusyPort['role']; probe: PortProbe }[] = [];
  for (const [port, role] of roles) {
    const r = await probe(port);
    if (r.busy) out.push({ port, role, probe: r });
  }
  return out;
}

function busyMessage(busy: BusyPort[], preset: Preset, reason: 'fixed' | 'exhausted', range?: [number, number]): string {
  const lines = busy.map((b) => {
    const who = b.holders.length ? b.holders.map(holderText).filter((v, i, a) => a.indexOf(v) === i).join(', ') : b.reserved ? 'Windows (a reserved port range, often Hyper-V or WSL)' : 'another program';
    return `  - Port ${b.port} (${b.role === 'admin' ? 'control panel' : b.role === 'http' ? 'plain http' : 'game'}) is in use by ${who}.`;
  });
  if (reason === 'exhausted' && range) {
    return [
      `Every port pair from ${range[0]} to ${range[1] + 1} is in use, so Voidswarm can't start.`,
      ...lines.slice(0, 4),
      'Stop the program holding the port, or change the port in Settings → Network.',
    ].join('\n');
  }
  return [
    "Voidswarm can't start: its port is in use.",
    ...lines,
    preset === 'school'
      ? 'School mode never picks another port by itself (IT rules and bookmarks name it). Stop that program, or change the port in Settings → Network.'
      : 'Stop that program, or change the port in Settings → Network (players will need the new address).',
  ].join('\n');
}

/**
 * Picks the ports for this start. Home's first run may move to the next free pair; everything else
 * uses the stored (or default) pair and refuses, naming the holder, when it is busy.
 */
export async function choosePorts(opts: ChoosePortsOptions): Promise<ChoosePortsResult> {
  const probe = opts.probe ?? ((port: number) => probePort(port, { primary: opts.primary }));
  const holders = opts.holders ?? ((ports: number[]) => findPortHolders(ports));
  const toBusy = async (list: { port: number; role: BusyPort['role']; probe: PortProbe }[]): Promise<BusyPort[]> => {
    const found = list.length ? await holders(list.map((b) => b.port)) : [];
    return list.map((b) => ({
      port: b.port,
      role: b.role,
      holders: found.filter((h) => h.port === b.port),
      reserved: !b.probe.answeredOn.length && b.probe.bindFailed.some((f) => f.code === 'EACCES'),
    }));
  };

  let plan: PortPlan;
  if (opts.standardPorts) {
    plan = { game: STANDARD_HTTPS_PORT, http: STANDARD_HTTP_PORT, admin: opts.stored?.admin ?? DEFAULT_GAME_PORT + 1 };
  } else if (opts.stored && isValidPort(opts.stored.game) && isValidPort(opts.stored.admin)) {
    plan = { game: opts.stored.game, admin: opts.stored.admin };
  } else {
    plan = pairFor(opts.firstGamePort ?? DEFAULT_GAME_PORT);
  }
  const firstRun = !opts.stored;
  const busy = await busyPorts(plan, probe);
  // The pair is chosen once: the first run stores it even when the default was free.
  if (!busy.length) return { ok: true, plan, persist: firstRun && !opts.standardPorts, note: null };

  const autoPick = firstRun && opts.preset === 'home' && !opts.standardPorts;
  if (!autoPick) {
    const b = await toBusy(busy);
    return { ok: false, busy: b, message: busyMessage(b, opts.preset, 'fixed') };
  }
  const first = opts.firstGamePort ?? DEFAULT_GAME_PORT;
  const last = opts.lastGamePort ?? AUTO_PICK_LAST_GAME_PORT;
  for (const cand of candidatePairs(first, last)) {
    if (cand.game === plan.game) continue;
    const b = await busyPorts(cand, probe);
    if (!b.length) {
      return {
        ok: true,
        plan: cand,
        persist: true,
        note: `Port ${plan.game} was in use, so Voidswarm uses ${cand.game} (control panel ${cand.admin}) and will keep using it.`,
      };
    }
  }
  const b = await toBusy(busy);
  return { ok: false, busy: b, message: busyMessage(b, opts.preset, 'exhausted', [first, last]) };
}
