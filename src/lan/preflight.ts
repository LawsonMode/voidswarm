// LAN edition: host preflight checks, cached in data\preflight.json (§2.2 step 9, §3.5, §3.8, §5.16).
//
// - the network category (Public means loopback only);
// - firewall BLOCK rules for this node.exe, and a policy that ignores local rules;
// - the sleep timeouts on AC and battery, and the power source;
// - free disk space (fs.statfs; always fresh, it is cheap).
//
// Refreshed at first run, after an update (version or node.exe changed), on a network change
// (a different primary address), after 5 minutes with no LAN device (the caller forces it), and
// once a day as a safety net. Also caches Get-Volume for the location check (paths.ts).
//
// The Windows facts come from ONE fixed PowerShell script (values in VS_* env vars, no double
// quotes, output as JSON with non-ASCII escaped so the console code page can't mangle it). Every
// section has its own try/catch, so one failing cmdlet loses only its own section. If the firewall
// cmdlets fail, `netsh advfirewall firewall show rule` (English output) is the fallback.

import fs from 'node:fs';
import path from 'node:path';
import { execTool, envGet, runPowerShell, systemTool, type Env, type ExecFn, type Platform, type Preset, type VolumeInfo } from './paths';

export type PreflightReason = 'first-run' | 'update' | 'network-change' | 'no-device' | 'expired' | 'manual';

export type NetworkCategory = 'Public' | 'Private' | 'DomainAuthenticated' | (string & {});

export interface NetProfile {
  alias: string;
  index: number;
  /** The network's name (SSID or "Network 2"). */
  name: string;
  category: NetworkCategory;
  ipv4: string[];
}

export interface FirewallRule {
  program: string;
  name: string;
  enabled: boolean;
  direction: 'Inbound' | 'Outbound' | (string & {});
  action: 'Allow' | 'Block' | (string & {});
  /** 'Any', 'Private', 'Domain, Private', … */
  profiles: string;
}

export interface FirewallProfile {
  name: 'Domain' | 'Private' | 'Public' | (string & {});
  enabled: boolean;
  defaultInbound: string;
  /** False when policy (GPO) ignores local rules: the Windows prompt and our .cmd can't help then. */
  allowLocalRules: boolean;
}

export interface PreflightReport {
  v: 1;
  at: number;
  reason: PreflightReason;
  version: string;
  platform: Platform;
  nodeExe: string;
  primary: string | null;
  /** `addressesError`: the profiles were read but not which addresses belong to them. */
  network: { profiles: NetProfile[]; error?: string; addressesError?: string } | null;
  /** `rulesRead` is false when neither PowerShell nor netsh could list the rules (then `rules` is empty, not "none"). */
  firewall: { source: 'powershell' | 'netsh'; rulesRead: boolean; rules: FirewallRule[]; profiles: FirewallProfile[]; error?: string } | null;
  power: { acSleepSec: number | null; dcSleepSec: number | null; hasBattery: boolean | null; onBattery: boolean | null; error?: string } | null;
  disk: { path: string; freeBytes: number; totalBytes: number; error?: string } | null;
}

export interface VolumeCacheEntry {
  at: number;
  version: string;
  info: VolumeInfo | null;
}

export interface PreflightFile {
  v: 1;
  report: PreflightReport | null;
  /** Keyed by `<drive>|<root lowercased>`. */
  volumes: Record<string, VolumeCacheEntry>;
}

export const PREFLIGHT_MAX_AGE_MS = 24 * 3600_000;
export const VOLUME_MAX_AGE_MS = 7 * 24 * 3600_000;
export const DISK_LOW_BYTES = 2 * 1024 ** 3;
export const DISK_CRITICAL_BYTES = 500 * 1024 ** 2;

// --- the PowerShell probe --------------------------------------------------------------------

export type ProbeSection = 'network' | 'firewall' | 'battery' | 'volume';

const PS_SECTIONS: Record<ProbeSection, string[]> = {
  network: [
    'try { $o.network = @(Get-NetConnectionProfile | ForEach-Object { [pscustomobject]@{ alias = [string]$_.InterfaceAlias; index = [int]$_.InterfaceIndex; name = [string]$_.Name; category = [string]$_.NetworkCategory } }) } catch { $o.networkError = [string]$_.Exception.Message }',
    'try { $o.addresses = @(Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object { [pscustomobject]@{ index = [int]$_.InterfaceIndex; ip = [string]$_.IPAddress } }) } catch { $o.addressesError = [string]$_.Exception.Message }',
  ],
  firewall: [
    // Rules whose program ends with our file name; the exact path (after %VAR% expansion) is matched in JS.
    "try { $leaf = $env:VS_PROGRAM_LEAF; $o.rules = @(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore | Where-Object { $_.Program -like ('*\\' + $leaf) } | ForEach-Object { $f = $_; $f | Get-NetFirewallRule | ForEach-Object { [pscustomobject]@{ program = [string]$f.Program; name = [string]$_.DisplayName; enabled = [string]$_.Enabled; direction = [string]$_.Direction; action = [string]$_.Action; profile = [string]$_.Profile } } }) } catch { $o.rulesError = [string]$_.Exception.Message }",
    'try { $o.profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; enabled = [string]$_.Enabled; inbound = [string]$_.DefaultInboundAction; allowLocal = [string]$_.AllowLocalFirewallRules } }) } catch { $o.profilesError = [string]$_.Exception.Message }',
  ],
  battery: [
    'try { $o.battery = @(Get-CimInstance -ClassName Win32_Battery | ForEach-Object { [int]$_.BatteryStatus }) } catch { $o.batteryError = [string]$_.Exception.Message }',
  ],
  volume: [
    'try { $v = Get-Volume -DriveLetter $env:VS_DRIVE; $o.volume = [pscustomobject]@{ fileSystem = [string]$v.FileSystemType; driveType = [string]$v.DriveType } } catch { $o.volumeError = [string]$_.Exception.Message }',
  ],
};

/** The fixed script for these sections (no double quotes; values come from VS_* env vars). */
export function hostProbeScript(sections: readonly ProbeSection[]): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$o = [ordered]@{}',
    // Escape non-ASCII so the console code page can't mangle names (Constrained Language Mode safe).
    "function VsEsc([string]$s) { $r = ''; foreach ($c in $s.ToCharArray()) { $n = [int]$c; if ($n -gt 126) { $r += '\\u' + $n.ToString('x4') } else { $r += $c } }; return $r }",
    ...sections.flatMap((s) => PS_SECTIONS[s]),
    '$j = ConvertTo-Json -InputObject $o -Compress -Depth 5',
    "'VSJSON:' + (VsEsc $j)",
  ].join('\n');
}

export interface HostProbe {
  network?: { alias?: unknown; index?: unknown; name?: unknown; category?: unknown }[];
  networkError?: string;
  addresses?: { index?: unknown; ip?: unknown }[];
  addressesError?: string;
  rules?: { program?: unknown; name?: unknown; enabled?: unknown; direction?: unknown; action?: unknown; profile?: unknown }[];
  rulesError?: string;
  profiles?: { name?: unknown; enabled?: unknown; inbound?: unknown; allowLocal?: unknown }[];
  profilesError?: string;
  battery?: unknown[];
  batteryError?: string;
  volume?: { fileSystem?: unknown; driveType?: unknown };
  volumeError?: string;
}

export function parseHostProbe(stdout: string): HostProbe | null {
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('VSJSON:'));
  if (!line) return null;
  try {
    const v = JSON.parse(line.slice(7)) as unknown;
    return v && typeof v === 'object' ? (v as HostProbe) : null;
  } catch {
    return null;
  }
}

export async function runHostProbe(
  sections: readonly ProbeSection[],
  opts: { exec?: ExecFn; env?: Env; program?: string; drive?: string; timeoutMs?: number } = {},
): Promise<{ probe: HostProbe | null; error?: string }> {
  const vars: Record<string, string> = {};
  if (opts.program) vars.VS_PROGRAM_LEAF = path.win32.basename(opts.program);
  if (opts.drive) vars.VS_DRIVE = opts.drive.replace(/[^a-z]/gi, '').slice(0, 1).toUpperCase();
  const r = await runPowerShell(hostProbeScript(sections), vars, { exec: opts.exec, env: opts.env, timeoutMs: opts.timeoutMs });
  const probe = parseHostProbe(r.stdout ?? '');
  if (!probe) return { probe: null, error: (r.error ?? r.stderr ?? '').trim().slice(0, 300) || `PowerShell exit ${r.code}` };
  return { probe };
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));

export function profilesFromProbe(p: HostProbe): NetProfile[] {
  const addrs = (p.addresses ?? []).map((a) => ({ index: num(a.index), ip: str(a.ip) }));
  return (p.network ?? []).map((n) => {
    const index = num(n.index);
    return { alias: str(n.alias), index, name: str(n.name), category: str(n.category), ipv4: addrs.filter((a) => a.index === index).map((a) => a.ip) };
  });
}

/** Expands %VAR% the way firewall rules store paths, then compares case-insensitively. */
export function sameProgram(rulePath: string, program: string, env: Env = process.env): boolean {
  const expanded = rulePath.replace(/%([^%]+)%/g, (m, name: string) => envGet(env, name) ?? m);
  return path.win32.normalize(expanded).toLowerCase() === path.win32.normalize(program).toLowerCase();
}

export function rulesFromProbe(p: HostProbe, program: string, env: Env = process.env): FirewallRule[] {
  return (p.rules ?? [])
    .map((r) => ({
      program: str(r.program),
      name: str(r.name),
      enabled: /^true$/i.test(str(r.enabled)),
      direction: str(r.direction),
      action: str(r.action),
      profiles: str(r.profile) || 'Any',
    }))
    .filter((r) => sameProgram(r.program, program, env));
}

export function firewallProfilesFromProbe(p: HostProbe): FirewallProfile[] {
  return (p.profiles ?? []).map((f) => ({
    name: str(f.name),
    enabled: /^true$/i.test(str(f.enabled)),
    defaultInbound: str(f.inbound),
    // NotConfigured in the active store means the default: local rules apply.
    allowLocalRules: !/^false$/i.test(str(f.allowLocal)),
  }));
}

/** Win32_Battery.BatteryStatus: 1, 4, 5 = discharging (on battery); none = no battery (a desktop). */
export function batteryFromProbe(p: HostProbe): { hasBattery: boolean | null; onBattery: boolean | null } {
  if (p.batteryError || !Array.isArray(p.battery)) return { hasBattery: null, onBattery: null };
  const statuses = p.battery.map(num).filter((n) => Number.isFinite(n));
  if (!statuses.length) return { hasBattery: false, onBattery: false };
  return { hasBattery: true, onBattery: statuses.every((s) => s === 1 || s === 4 || s === 5) };
}

export function volumeFromProbe(p: HostProbe): VolumeInfo | null {
  if (!p.volume || p.volumeError) return null;
  return { fileSystem: str(p.volume.fileSystem), driveType: str(p.volume.driveType) };
}

// --- netsh fallback (English output only) ----------------------------------------------------

/** Parses `netsh advfirewall firewall show rule name=all verbose` for one program's rules. */
export function parseNetshRules(text: string, program: string, env: Env = process.env): FirewallRule[] | null {
  const blocks = text.split(/\r?\n\s*\r?\n/);
  const out: FirewallRule[] = [];
  let sawEnglish = false;
  for (const b of blocks) {
    const fields = new Map<string, string>();
    for (const line of b.split(/\r?\n/)) {
      const m = /^([A-Za-z][A-Za-z ]*?):\s*(.*)$/.exec(line.trim());
      if (m) fields.set(m[1].toLowerCase(), m[2].trim());
    }
    if (fields.has('rule name')) sawEnglish = true;
    const prog = fields.get('program');
    if (!prog || !sameProgram(prog, program, env)) continue;
    const dir = fields.get('direction') ?? '';
    out.push({
      program: prog,
      name: fields.get('rule name') ?? '',
      enabled: /^yes$/i.test(fields.get('enabled') ?? ''),
      direction: /^in$/i.test(dir) ? 'Inbound' : /^out$/i.test(dir) ? 'Outbound' : dir,
      action: fields.get('action') ?? '',
      profiles: (fields.get('profiles') ?? 'Any').replace(/,/g, ', ').replace(/\s+/g, ' '),
    });
  }
  return sawEnglish || out.length ? out : null;
}

// --- powercfg ---------------------------------------------------------------------------------

/**
 * `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE`: the labels are localized, but the last
 * two hex values are always the current AC and DC indexes (seconds; 0 = never).
 */
export function parsePowercfg(text: string): { acSleepSec: number | null; dcSleepSec: number | null } {
  const hex = [...text.matchAll(/0x([0-9a-f]{1,8})\s*$/gim)].map((m) => Number.parseInt(m[1], 16));
  if (hex.length < 2) return { acSleepSec: null, dcSleepSec: null };
  return { acSleepSec: hex[hex.length - 2], dcSleepSec: hex[hex.length - 1] };
}

// --- running and caching ----------------------------------------------------------------------

export interface PreflightOptions {
  /** data\ (preflight.json lives here; disk space is measured here). */
  dataDir: string;
  /** The app version (build-info.json): a change means "after an update". */
  version: string;
  /** runtime\node.exe (the firewall rules are matched against it). */
  nodeExe: string;
  primary?: string | null;
  platform?: Platform;
  exec?: ExecFn;
  env?: Env;
  now?: () => number;
  maxAgeMs?: number;
  /** Measures free space (default fs.promises.statfs). */
  statfs?: (p: string) => Promise<{ bavail: number; bsize: number; blocks: number }>;
}

/** `data/preflight.json`: a real file, so always the native path module (never a simulated platform's). */
export function preflightFilePath(dataDir: string): string {
  return path.join(dataDir, 'preflight.json');
}

export function readPreflightFile(file: string): PreflightFile {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PreflightFile>;
    if (v && v.v === 1) {
      return {
        v: 1,
        report: v.report && typeof v.report === 'object' && (v.report as PreflightReport).v === 1 ? (v.report as PreflightReport) : null,
        volumes: v.volumes && typeof v.volumes === 'object' ? (v.volumes as Record<string, VolumeCacheEntry>) : {},
      };
    }
  } catch {
    /* missing or broken: start over */
  }
  return { v: 1, report: null, volumes: {} };
}

/** Atomic write: temp file, fsync, rename. Returns false when the folder isn't writable. */
export function writePreflightFile(file: string, data: PreflightFile): boolean {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(data, null, 1) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return false;
  }
}

/** Why a cached report must be refreshed, or null when it is still good. */
export function staleReason(
  report: PreflightReport | null,
  ctx: { version: string; nodeExe: string; primary?: string | null; now: number; maxAgeMs?: number },
): PreflightReason | null {
  if (!report) return 'first-run';
  if (report.version !== ctx.version || report.nodeExe.toLowerCase() !== ctx.nodeExe.toLowerCase()) return 'update';
  if (ctx.primary !== undefined && (report.primary ?? null) !== (ctx.primary ?? null)) return 'network-change';
  if (ctx.now - report.at > (ctx.maxAgeMs ?? PREFLIGHT_MAX_AGE_MS) || report.at > ctx.now + 60_000) return 'expired';
  return null;
}

async function measureDisk(dataDir: string, opts: PreflightOptions): Promise<PreflightReport['disk']> {
  const api = path; // the real filesystem
  let p = api.resolve(dataDir);
  for (let i = 0; i < 32 && !fs.existsSync(p); i++) {
    const up = api.dirname(p);
    if (up === p) break;
    p = up;
  }
  try {
    const s = await (opts.statfs ?? ((q: string) => fs.promises.statfs(q)))(p);
    return { path: p, freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch (e) {
    return { path: p, freeBytes: -1, totalBytes: -1, error: String((e as Error).message ?? e) };
  }
}

/** The firewall section of a report from a PowerShell probe that read the rules. */
function firewallFromProbe(probe: HostProbe, program: string, env: Env): NonNullable<PreflightReport['firewall']> {
  return {
    source: 'powershell',
    rulesRead: true,
    rules: rulesFromProbe(probe, program, env),
    profiles: firewallProfilesFromProbe(probe),
    ...(probe.profilesError ? { error: probe.profilesError } : {}),
  };
}

/** The startup firewall re-read's time limit (it takes about a second; the full preflight's PowerShell gets 30 s). */
export const FIREWALL_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Re-reads only the firewall section (read-only PowerShell, about a second, no administrator rights): the launcher
 * runs it at every start when the rest of the preflight came from the cache, so a rule IT added (or a Block rule from
 * a cancelled Windows prompt) shows at the next start, not a day later. Null when it couldn't be read (keep the
 * cached section then); never the netsh fallback (that one is slow).
 */
export async function readFirewall(
  opts: { nodeExe: string; platform?: Platform; exec?: ExecFn; env?: Env; timeoutMs?: number },
): Promise<PreflightReport['firewall']> {
  if ((opts.platform ?? process.platform) !== 'win32') return null;
  const env = opts.env ?? process.env;
  const { probe } = await runHostProbe(['firewall'], { exec: opts.exec, env, program: opts.nodeExe, timeoutMs: opts.timeoutMs ?? FIREWALL_REFRESH_TIMEOUT_MS });
  if (!probe || probe.rulesError) return null;
  return firewallFromProbe(probe, opts.nodeExe, env);
}

/** Runs every check now (no cache). */
export async function runPreflight(opts: PreflightOptions & { reason?: PreflightReason }): Promise<PreflightReport> {
  const platform = opts.platform ?? process.platform;
  const now = (opts.now ?? Date.now)();
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? execTool;
  const report: PreflightReport = {
    v: 1,
    at: now,
    reason: opts.reason ?? 'manual',
    version: opts.version,
    platform,
    nodeExe: opts.nodeExe,
    primary: opts.primary ?? null,
    network: null,
    firewall: null,
    power: null,
    disk: null,
  };
  const diskP = measureDisk(opts.dataDir, opts);
  if (platform === 'win32') {
    const [ps, pc] = await Promise.all([
      runHostProbe(['network', 'firewall', 'battery'], { exec, env, program: opts.nodeExe }),
      exec(systemTool('powercfg', env), ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE'], { timeoutMs: 15_000 }),
    ]);
    const probe = ps.probe;
    if (probe) {
      report.network = {
        profiles: profilesFromProbe(probe),
        ...(probe.networkError ? { error: probe.networkError } : {}),
        ...(probe.addressesError ? { addressesError: probe.addressesError } : {}),
      };
    } else {
      report.network = { profiles: [], error: ps.error ?? 'PowerShell failed' };
    }

    if (probe && !probe.rulesError) {
      report.firewall = firewallFromProbe(probe, opts.nodeExe, env);
    } else {
      const ns = await exec(systemTool('netsh', env), ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'verbose'], { timeoutMs: 30_000 });
      const rules = parseNetshRules(ns.stdout ?? '', opts.nodeExe, env);
      report.firewall = {
        source: 'netsh',
        rulesRead: rules !== null,
        rules: rules ?? [],
        profiles: probe ? firewallProfilesFromProbe(probe) : [],
        error: rules ? probe?.rulesError : `could not read the firewall rules (${probe?.rulesError ?? ps.error ?? 'netsh output not understood'})`,
      };
    }

    const sleep = pc.code === 0 ? parsePowercfg(pc.stdout ?? '') : { acSleepSec: null, dcSleepSec: null };
    const bat = probe ? batteryFromProbe(probe) : { hasBattery: null, onBattery: null };
    report.power = {
      ...sleep,
      ...bat,
      ...(pc.code !== 0 ? { error: (pc.stderr || pc.error || `powercfg exit ${pc.code}`).trim().slice(0, 200) } : {}),
    };
  }
  report.disk = await diskP;
  return report;
}

/**
 * The cache-aware entry point: returns the cached report when it is still good (with fresh disk
 * numbers), otherwise runs the checks and stores them. `force` runs them anyway (a network change
 * noticed by netwatch, 5 minutes with no LAN device, the panel's Re-check).
 */
export async function getPreflight(
  opts: PreflightOptions & { force?: PreflightReason },
): Promise<{ report: PreflightReport; ran: boolean; reason: PreflightReason | null }> {
  const file = preflightFilePath(opts.dataDir);
  const cache = readPreflightFile(file);
  const now = (opts.now ?? Date.now)();
  const reason = opts.force ?? staleReason(cache.report, { version: opts.version, nodeExe: opts.nodeExe, primary: opts.primary, now, maxAgeMs: opts.maxAgeMs });
  if (!reason && cache.report) {
    return { report: { ...cache.report, disk: await measureDisk(opts.dataDir, opts) }, ran: false, reason: null };
  }
  const report = await runPreflight({ ...opts, reason: reason ?? 'manual' });
  const latest = readPreflightFile(file); // keep volume entries another call may have added meanwhile
  writePreflightFile(file, { v: 1, report, volumes: latest.volumes });
  return { report, ran: true, reason };
}

/**
 * A cached Get-Volume for paths.ts's location check: `checkLocation(root, data, { volume: volumeLookup(…) })`.
 * The cache lives in preflight.json (when data\ is writable) and is refreshed after an update or a week.
 */
export function volumeLookup(opts: { dataDir: string; root: string; version: string; exec?: ExecFn; env?: Env; now?: () => number }) {
  const file = preflightFilePath(opts.dataDir);
  return async (drive: string): Promise<VolumeInfo | null> => {
    const key = `${drive.toUpperCase()}|${opts.root.toLowerCase()}`;
    const now = (opts.now ?? Date.now)();
    const cache = readPreflightFile(file);
    const hit = cache.volumes[key];
    if (hit && hit.version === opts.version && now - hit.at < VOLUME_MAX_AGE_MS && hit.info) return hit.info;
    const { probe } = await runHostProbe(['volume'], { exec: opts.exec, env: opts.env, drive });
    const info = probe ? volumeFromProbe(probe) : null;
    if (info && fs.existsSync(path.dirname(file))) {
      const latest = readPreflightFile(file);
      latest.volumes[key] = { at: now, version: opts.version, info };
      writePreflightFile(file, latest);
    }
    return info;
  };
}

// --- what the report means --------------------------------------------------------------------

/**
 * The network category of the adapter that holds `ip` (null when unknown). When the addresses
 * can't be matched it doesn't fail open: a PC with one connection profile uses that one, and when
 * the address list itself is missing (Get-NetIPAddress failed) any Public profile counts.
 */
export function categoryFor(report: PreflightReport, ip: string | null | undefined): NetworkCategory | null {
  const net = report.network;
  if (!net || !net.profiles.length) return null;
  const prof = ip ? net.profiles.find((p) => p.ipv4.includes(ip)) : undefined;
  if (prof) return prof.category;
  if (net.profiles.length === 1) return net.profiles[0].category;
  const addressesUnknown = !!net.addressesError || net.profiles.every((p) => !p.ipv4.length);
  if (addressesUnknown && net.profiles.some((p) => p.category === 'Public')) return 'Public';
  return null;
}

/** Public means loopback only (§2.2 step 9, T-NET-5 uses a mocked report). */
export function lanServingAllowed(report: PreflightReport | null, primary: string | null | undefined): { allowed: boolean; category: NetworkCategory | null } {
  if (!report) return { allowed: true, category: null };
  const category = categoryFor(report, primary ?? report.primary);
  return { allowed: category !== 'Public', category };
}

function profileName(category: NetworkCategory | null): string | null {
  if (category === 'Public') return 'Public';
  if (category === 'Private') return 'Private';
  if (category === 'DomainAuthenticated') return 'Domain';
  return null;
}

function ruleApplies(rule: FirewallRule, profile: string | null): boolean {
  if (!profile) return true;
  const p = rule.profiles.toLowerCase();
  return p === '' || p.includes('any') || p.includes(profile.toLowerCase());
}

/** Why other devices are probably blocked (inboundVerdict). */
export type InboundBlockReason = 'block-rule' | 'policy-ignores-local' | 'no-allow-rule';

export interface InboundVerdict {
  inboundLikelyBlocked: boolean;
  reason: InboundBlockReason | null;
  /** The firewall profile of the active network ('Domain' | 'Private' | 'Public'), null when unknown. */
  profile: string | null;
  /** No firewall rule at all for this node.exe yet (the Windows prompt was never answered). */
  noRules: boolean;
}

/**
 * Can other devices reach this node.exe through Windows Firewall on the active network? A pure reading of the
 * preflight's firewall section and the active network category; it claims "likely blocked" only on evidence:
 *  - an enabled inbound Block rule for this node.exe covering the active profile ('block-rule': Block wins in Windows
 *    Firewall, whatever Allow rules exist);
 *  - the active profile's firewall is on and a policy ignores local rules (AllowLocalFirewallRules False), with no
 *    Allow rule for it in the active policy ('policy-ignores-local': neither the Windows prompt nor a local rule helps;
 *    an Allow rule IT pushed by policy shows in the active store and is believed);
 *  - the active profile's firewall is on, its default inbound action is Block (NotConfigured means Block), and no
 *    enabled inbound Allow rule for this node.exe covers it ('no-allow-rule').
 * Unknown or unreadable (no report, an unknown or Public category, rules not read, the profile's state not read for the
 * last two) makes no claim: no crying wolf. Public is left to the network-public notice (the game stays on this PC).
 * A port-only rule (no program) is not seen, hence "likely".
 */
export function inboundVerdict(fw: PreflightReport['firewall'], category: NetworkCategory | null): InboundVerdict {
  const profile = profileName(category);
  const noRules = !!fw && fw.rulesRead && fw.rules.length === 0;
  const none: InboundVerdict = { inboundLikelyBlocked: false, reason: null, profile, noRules };
  if (!fw || !fw.rulesRead || !profile || profile === 'Public') return none;
  const active = fw.profiles.find((p) => p.name.toLowerCase() === profile.toLowerCase()) ?? null;
  if (active && !active.enabled) return none; // the firewall is off on this network
  const inbound = fw.rules.filter((r) => r.enabled && /^in/i.test(r.direction) && ruleApplies(r, profile));
  const allowed = inbound.some((r) => /^allow$/i.test(r.action));
  const blocked = inbound.some((r) => /^block$/i.test(r.action));
  const claim = (reason: InboundBlockReason): InboundVerdict => ({ inboundLikelyBlocked: true, reason, profile, noRules });
  if (blocked) return claim('block-rule');
  if (!active || allowed) return none;
  if (!active.allowLocalRules) return claim('policy-ignores-local');
  if (/^(block|notconfigured)$/i.test(active.defaultInbound.trim())) return claim('no-allow-rule');
  return none;
}

/** The IT file (scripts/lan/templates): adds the inbound rule for runtime\node.exe on the Domain and Private profiles. */
export const IT_FIREWALL_FILE = 'Allow Voidswarm (for IT).cmd';

const ON_THIS_PC = 'or keep using Voidswarm on this PC only: the host PC can always play and use this panel.';

/** The panel banner for a likely-blocked verdict (at most 500 characters: lan:start banners are cut there). */
export function firewallBlockedText(v: InboundVerdict): string {
  const where = v.profile ? `this network (the ${v.profile} profile)` : 'this network';
  const askIt = `ask IT to run "${IT_FIREWALL_FILE}" once (it is in the Voidswarm LAN folder; see FOR SCHOOL IT.txt), ${ON_THIS_PC}`;
  if (v.reason === 'block-rule') {
    return `Other devices probably can't connect: Windows Firewall has a Block rule for Voidswarm on ${where}, usually from `
      + `Cancel on the Windows prompt. Removing it needs an administrator, so either ${askIt}`;
  }
  if (v.reason === 'policy-ignores-local') {
    return `Other devices probably can't connect: this PC's firewall policy (set by IT) ignores local rules on ${where}, `
      + `so only IT can let Voidswarm in. Either ask IT to add the rule to that policy (FOR SCHOOL IT.txt), ${ON_THIS_PC}`;
  }
  return `Other devices probably can't connect: Windows Firewall has no rule allowing Voidswarm on ${where}. Adding one `
    + `needs an administrator, so either ${askIt}`
    + (v.noRules ? ' (If Windows asks about "Node.js JavaScript Runtime" and you can approve it, choose Allow.)' : '');
}

/**
 * The one console line for a likely-blocked verdict: a note under the console banner, so at most NOTE_MAX_CHARS (110,
 * banner.ts) or it is cut; the panel banner has the whole story.
 */
export function firewallBlockedConsole(v: InboundVerdict): string {
  if (v.reason === 'policy-ignores-local') return "Firewall: IT's policy blocks other devices. Ask IT to add the rule (FOR SCHOOL IT.txt), or play on this PC.";
  const why = v.reason === 'block-rule' ? 'a Block rule stops other devices' : 'no rule lets other devices in';
  return `Firewall: ${why}. Ask IT to run "${IT_FIREWALL_FILE}", or play on this PC.`;
}

function duration(sec: number): string {
  if (sec < 90) return `${sec} seconds`;
  const min = Math.round(sec / 60);
  if (min < 120) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  return `${h} hours`;
}

function sizeText(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;
}

export type PreflightNoticeCode =
  | 'network-public'
  | 'firewall-blocked'
  | 'firewall-prompt'
  | 'sleep-ac'
  | 'sleep-battery'
  | 'on-battery'
  | 'disk-low'
  | 'disk-critical'
  | 'check-failed';

export interface PreflightNotice {
  code: PreflightNoticeCode;
  level: 'info' | 'warn' | 'error';
  text: string;
  /** A shorter line for the console (default: `text`). */
  console?: string;
}

/**
 * The console / panel lines for a report (the panel banners and the first-run Network check). `thisPcOnly`: the game
 * listens on this PC only (--this-pc-only), so the firewall doesn't matter and nothing is said about it.
 */
export function preflightNotices(report: PreflightReport, opts: { preset?: Preset; thisPcOnly?: boolean } = {}): PreflightNotice[] {
  const out: PreflightNotice[] = [];
  const category = categoryFor(report, report.primary);
  const profile = profileName(category);

  if (category === 'Public') {
    out.push({ code: 'network-public', level: 'warn', text: "Other devices can't connect: this network is set to Public. Set it to Private (Settings → Network & internet → your connection → Private network)." });
  }

  const fw = report.firewall;
  if (fw && !opts.thisPcOnly) {
    const verdict = inboundVerdict(fw, category);
    const inbound = fw.rules.filter((r) => r.enabled && /^in/i.test(r.direction) && ruleApplies(r, profile));
    const blocked = inbound.some((r) => /^block$/i.test(r.action));
    const allowed = inbound.some((r) => /^allow$/i.test(r.action));
    const active = fw.profiles.find((p) => profile && p.name.toLowerCase() === profile.toLowerCase());
    if (verdict.inboundLikelyBlocked) {
      out.push({ code: 'firewall-blocked', level: 'warn', text: firewallBlockedText(verdict), console: firewallBlockedConsole(verdict) });
    } else if (category !== 'Public' && fw.rulesRead && !blocked && !allowed && (!active || active.enabled)) {
      out.push({
        code: 'firewall-prompt',
        level: 'info',
        text:
          opts.preset === 'school' && profile === 'Domain'
            ? `No firewall rule lets players reach runtime\\node.exe on the school (Domain) network yet: IT must add it ("${IT_FIREWALL_FILE}", or FOR SCHOOL IT.txt).`
            : 'Windows may ask about "Node.js JavaScript Runtime": that is Voidswarm\'s engine. Choose Allow on Private networks.',
      });
    }
    if (!fw.rulesRead) out.push({ code: 'check-failed', level: 'info', text: `The firewall check couldn't run (${(fw.error ?? 'unknown error').slice(0, 120)}).` });
  }

  const pw = report.power;
  if (pw) {
    if (pw.acSleepSec && pw.acSleepSec > 0) {
      out.push({ code: 'sleep-ac', level: 'warn', text: `This PC sleeps after ${duration(pw.acSleepSec)} when plugged in. Set Sleep to Never while hosting.` });
    }
    if (pw.hasBattery && pw.dcSleepSec && pw.dcSleepSec > 0) {
      out.push({
        code: 'sleep-battery',
        level: 'warn',
        text: `This PC sleeps after ${duration(pw.dcSleepSec)} on battery. Plug it in and set Sleep to Never while hosting; don't close the lid.`,
      });
    }
    if (pw.onBattery) out.push({ code: 'on-battery', level: 'warn', text: 'This PC is running on battery. Plug it in while hosting.' });
  }

  const d = report.disk;
  if (d && d.freeBytes >= 0) {
    if (d.freeBytes < DISK_CRITICAL_BYTES) {
      out.push({ code: 'disk-critical', level: 'error', text: `Only ${sizeText(d.freeBytes)} free on the data drive: chat may stop being logged. Free some space.` });
    } else if (d.freeBytes < DISK_LOW_BYTES) {
      out.push({ code: 'disk-low', level: 'warn', text: `Only ${sizeText(d.freeBytes)} free on the data drive: backups are skipped below 2 GB.` });
    }
  }
  return out;
}
