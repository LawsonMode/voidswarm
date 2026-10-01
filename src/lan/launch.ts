// LAN edition: the launcher, app\launch.mjs (docs/LAN-EDITION-proposal.md §2.2, §5.1, §4.10, T-LAN-16).
//
// The parent process, the "host agent". It runs every OS integration (read-only PowerShell, icacls, whoami,
// powercfg, explorer, the browser), prints the banner, holds the named-pipe lock and supervises the server child. It
// opens no network port. In order (§2.2):
//   1. location (refuse synced / shared / temporary / removable places)   2. elevation   3. permissions
//   4. Mark-of-the-Web (listed, never stripped)   5. the single-instance pipe lock (a second launch opens the panel)
//   6. moved data (MOVED-TO.json)   7. config (created and env-seeded on the first run) and data\secrets\
//   8. staged work (restore.ts applyStagedRestore; the settings are read again after it)   9. preflight (cached) and the
//      primary address; the other copies' data folders for the first-run "Bring in data from another copy" (§2.5)
//  11. the port pair   12. the sandboxed child, secrets over IPC   13. the banner and the browser
//  14. supervise: restart after a crash, at most 3 times in 10 minutes.
// (Step 10, the migration and the FTS tidy, runs in the child before it listens.)
//
// Players join only after first-run setup (§3.1). On the first run setup is pending by definition; on a later run the
// launcher reads the host admin's state from data\voidswarm.db before the first child (readSetupState: read-only, on
// a protected connection, since the sandboxed child can write that file), so a host that closed Voidswarm before
// finishing setup gets a loopback-only child at once. When the database can't tell (locked, damaged), a child that
// reports `setupPending` (setupKind 'first') while listening beyond loopback is still replaced
// (Supervisor.respawn) by one on loopback, and the banner never prints an address while setup is pending. The way
// back: once the child says setup is done ({type:'setup-done'}, or setupPending false in 'ready' or 'status'), the
// loopback child is replaced by one on the LAN address and one console line says where players join. A password
// reset (setupKind 'reset', Reset admin password.cmd) is not first-run setup: it never closes the game to players.
//
// Child → launcher messages besides ready / fatal / status (child.ts), each rate-limited: {type:'notice', text} (one
// console line), {type:'open-folder', which: backups|exports|logs|data} (answered with open-folder:done),
// {type:'setup-code', code, why: void|expired} (console only, never logged), {type:'setup-done'} (open to the LAN) and
// {type:'progress'} (still starting: re-arms the ready limit). Launcher → child: lan:start, stop, status, reload-admin,
// open-folder:done.
//
// The console is never read: the Start stub runs `call <nul …`, so stdin is always at end-of-input (§0 fact 15).
// Everything that needs an answer happens in the browser (first-run setup, bringing in data from another copy).
//
// Flags: --no-browser, --data <dir> (advanced), --fix-permissions, --this-pc-only (the game listens on this PC only: a
// solo try-out, and the M1 gate's run, with no firewall prompt); --skip-location-check is a test flag (T-PKG-5).
// Exit codes: LAUNCH_EXIT below. A nonzero exit leaves a message on the console for the stub to keep on screen.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GAME_VERSION } from '../shared/version';
import {
  BUNDLE_VERSION, KEY_BYTES, checkSecrets, openFileSecrets, prepareSecretsDir, SecretError, type SecretBundle, type SecretName,
} from '../server/secrets';
import { LAUNCHER_ACTOR, SettingsLoadError, SettingsService, readConfigFile, settingsFromRaw, isPrivateHost, type HostSettings, type Preset } from '../server/settings';
import { checkPermissions, fixPermissions, protectDir, type AclOptions, type AclReport } from './acl';
import { bannerLines, formatSetupCode, noticeLine, restartNotice, windowTitle, type NotServingReason } from './banner';
import {
  ServerChild, Supervisor, dataDirConflict, type ChildReady, type ChildStatus, type RestartInfo, type SupervisorEvent, type SupervisorResult,
} from './child';
import { HostConsole, Redactor, createHostLog, processConsole, type ConsoleOut, type HostLog } from './console';
import { decideElevation, readToken, type TokenInfo } from './elevation';
import { scanMotw, type MotwReport } from './motw';
import {
  LAN_FOLDER_NAME, checkLocation, envGet, execTool, isUnder, lanPaths, pathApi, rootFromLauncher, type Env, type ExecFn, type LanPaths, type LocationReport,
  type Platform,
} from './paths';
import { acquireLock, secondLaunch, validatePanelUrl, type HostLock } from './pipe';
import { choosePorts, type ChoosePortsOptions, type ChoosePortsResult, type PortPlan } from './ports';
import { getPreflight, lanServingAllowed, preflightNotices, readFirewall, volumeLookup, type PreflightOptions, type PreflightReport } from './preflight';
import { applyStagedRestore } from './restore';
import { MaintRelay, maintEntryBeside } from './maintRelay';
import { updateLeftoverNotes } from './update';
import { openProtectedDb } from '../server/db/guard';
import { hostAdminState } from '../server/moderation/hostAdmin';

export const LAUNCH_EXIT = {
  /** Stopped normally, or a second launch opened the running host's panel. */
  OK: 0,
  /** The server crashed and could not be restarted, or the launcher failed unexpectedly. */
  CRASH: 1,
  /** A port is busy (the launcher's probe, or the server's listen). */
  PORT: 2,
  /** The data folder: the database or the settings file can't be used, a secret is damaged, data\ can't be made. */
  DATA: 3,
  /** Bad flags. */
  USAGE: 4,
  /** A check refused to start: location, administrator (School), permissions (School), moved data, VPS settings. */
  REFUSED: 5,
} as const;

/** How often the window title is refreshed (§5.1: every 5 s). */
export const TITLE_INTERVAL_MS = 5000;
/** The secrets the child gets (pipe.key stays with the launcher: only it serves the pipe). */
export const CHILD_SECRETS: readonly SecretName[] = ['pepper.key', 'backup.key', 'smtp.secret', 'tls/issuing.key', 'tls/leaf.key'];
/** The ones it can't run without (the others, the SMTP password and the TLS keys, are left out when damaged). */
export const REQUIRED_CHILD_SECRETS: readonly SecretName[] = ['pepper.key', 'backup.key'];
/** The Crockford base32 alphabet (no I, L, O, U) of the setup code. */
export const SETUP_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A setup code as the child sends it ({type:'setup-code'}): 8 characters of that alphabet, upper case. */
export const SETUP_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
/**
 * Loopback → LAN switches after setup allowed per launcher run. A child that keeps saying "setup done" and then
 * "setup pending" can't make the host restart for ever: after this many the game stays on this PC only (the safe side).
 */
export const MAX_SETUP_SWITCHES = 3;
/** Child → launcher requests per minute (each is a console line or an Explorer window in the unsandboxed launcher). */
export const CHILD_NOTICES_PER_MIN = 10;
export const CHILD_OPEN_FOLDER_PER_MIN = 3;
export const CHILD_SETUP_CODES_PER_MIN = 5;
/** First run with PORT set: Home may auto-pick up to this many ports above it. */
const ENV_PORT_PICK_SPAN = 20;

// ------------------------------------------------------------------------------------------
// Small pure helpers
// ------------------------------------------------------------------------------------------

/** 8 Crockford base32 characters (40 bits), e.g. K7QP4MXD. Shown as K7QP-4MXD; the child stores only its hash. */
export function newSetupCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += SETUP_CODE_ALPHABET[randomInt(SETUP_CODE_ALPHABET.length)];
  return s;
}

export interface LaunchFlags {
  noBrowser: boolean;
  /** --data <dir>, resolved. */
  data: string | null;
  fixPermissions: boolean;
  /** Test flag (T-PKG-5): skip the location check. */
  skipLocationCheck: boolean;
  /** The game listens on this PC only (loopback), whatever the network (a try-out; no firewall prompt). */
  thisPcOnly?: boolean;
}

export const USAGE_TEXT = [
  'Usage: Start Voidswarm Host.cmd [--no-browser] [--fix-permissions] [--this-pc-only] [--data <folder>]',
  '  --no-browser        don\'t open the Host Control Panel in the browser',
  '  --fix-permissions   give only you, SYSTEM and Administrators access to this folder, then start',
  '  --data <folder>     (advanced) keep the data in another folder',
  '  --this-pc-only      players cannot join from other devices (a try-out on this PC; no firewall prompt)',
].join('\n');

export function parseLaunchArgs(argv: readonly string[], cwd = process.cwd()): LaunchFlags | { error: string } {
  const flags: LaunchFlags = { noBrowser: false, data: null, fixPermissions: false, skipLocationCheck: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-browser') flags.noBrowser = true;
    else if (a === '--fix-permissions') flags.fixPermissions = true;
    else if (a === '--skip-location-check') flags.skipLocationCheck = true;
    else if (a === '--this-pc-only') flags.thisPcOnly = true;
    else if (a === '--child') continue; // the Start stub's own re-call marker (§2.1)
    else if (a === '--data' || a.startsWith('--data=')) {
      const v = a === '--data' ? argv[++i] : a.slice('--data='.length);
      if (!v || v.startsWith('--')) return { error: '--data needs a folder.' };
      flags.data = path.resolve(cwd, v);
    } else return { error: `Unknown option: ${a.slice(0, 60)}` };
  }
  return flags;
}

/** RFC 1918 (10/8, 172.16/12, 192.168/16). Never 100.64/10, 169.254/16 or loopback. */
export function isRfc1918(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Adapters that are never the classroom network (virtual switches, VPNs). */
const VIRTUAL_ADAPTER_RE = /vethernet|wsl|hyper-v|virtualbox|vmware|vbox|docker|tailscale|zerotier|hamachi|loopback|npcap|bluetooth/i;

/**
 * The LAN address players use, WITHOUT opening a socket: the first RFC 1918 IPv4 address on a real adapter
 * (192.168/16 and 10/8 before 172.16/12, which Docker, WSL and Hyper-V favour). A stand-in until B12's primary.ts
 * (the default route's source address, the pin setting, netwatch) replaces it through LaunchDeps.primary.
 */
export function findPrimaryAddress(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string | null {
  const found: { ip: string; rank: number; order: number }[] = [];
  let order = 0;
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list || VIRTUAL_ADAPTER_RE.test(name)) continue;
    for (const a of list) {
      const fam = (a.family as unknown) === 4 ? 'IPv4' : a.family;
      if (fam !== 'IPv4' || a.internal || !isRfc1918(a.address)) continue;
      const rank = a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1 : 2;
      found.push({ ip: a.address, rank, order: order++ });
    }
  }
  found.sort((x, y) => x.rank - y.rank || x.order - y.order);
  return found[0]?.ip ?? null;
}

/** Opens a loopback http URL (only those) in the default browser, without a shell. */
export async function openInBrowser(url: string, opts: { exec?: ExecFn; platform?: Platform; env?: Env } = {}): Promise<void> {
  const base = url.split('#')[0];
  if (!validatePanelUrl(base)) throw new Error('Only this PC\'s control panel address is ever opened.');
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? execTool;
  if (platform === 'win32') {
    const sysRoot = envGet(opts.env ?? process.env, 'SystemRoot') ?? 'C:\\Windows';
    // explorer.exe hands the URL to the default browser (fragment included); it exits 1 even when it worked.
    const r = await exec(path.win32.join(sysRoot, 'explorer.exe'), [url], { timeoutMs: 15_000 });
    if (r.code === null && r.error) throw new Error(r.error);
    return;
  }
  const r = await exec(platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [url], { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error((r.stderr || r.error || `exit ${r.code}`).trim());
}

/** Opens a folder of the data folder in Explorer (the Server panel's buttons; §5.14). */
export async function openFolder(dir: string, opts: { exec?: ExecFn; platform?: Platform; env?: Env } = {}): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? execTool;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return false; }
  if (platform === 'win32') {
    const sysRoot = envGet(opts.env ?? process.env, 'SystemRoot') ?? 'C:\\Windows';
    const r = await exec(path.win32.join(sysRoot, 'explorer.exe'), [dir], { timeoutMs: 15_000 });
    return !(r.code === null && r.error);
  }
  const r = await exec(platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [dir], { timeoutMs: 15_000 });
  return r.code === 0;
}

/**
 * The launcher policy decides like a preset: 'refuse' behaves as School, 'warn' as Home, none (no settings yet) as the
 * preset. 'off' (the permission check only) is handled before this: it skips the check; should it get here (the fix
 * with --fix-permissions), it is the gentlest one (Home: warn, never refuse).
 */
const policyPreset = (policy: 'warn' | 'refuse' | 'off' | undefined, preset: Preset): Preset => {
  if (policy === 'refuse') return 'school';
  if (policy === 'warn' || policy === 'off') return 'home';
  return preset;
};

/** The host-log line for a start with the folder permission check off (launcher.permissions = 'off'). */
export const PERMISSIONS_OFF_LOG = "folder permission check skipped (launcher.permissions = 'off': the host chose \"Don't warn me again\")";

/** A VPS-only setting in the environment: the launcher refuses it (§3.2 "Refused combinations"). */
export function vpsSettingsRefusal(env: Env): string | null {
  const tp = envGet(env, 'TRUST_PROXY');
  if (tp && !/^(0|false|no|off)$/i.test(tp.trim())) {
    return 'TRUST_PROXY is set. The LAN edition never runs behind a proxy or a tunnel: that is the VPS kit (docs/DEPLOY-VPS.md). '
      + 'Remove the TRUST_PROXY environment variable and start Voidswarm again.';
  }
  const pu = envGet(env, 'PUBLIC_URL');
  if (pu) {
    let host = '';
    try { host = new URL(pu).hostname.replace(/^\[|\]$/g, ''); } catch { host = ''; }
    const lanName = host && (isPrivateHost(host) || host === '::1' || /^[a-z0-9-]{1,63}(\.local)?$/i.test(host));
    if (!lanName) {
      return `PUBLIC_URL is set to an internet address (${pu.slice(0, 80)}). The LAN edition serves this network only: that `
        + 'is the VPS kit (docs/DEPLOY-VPS.md). Remove the PUBLIC_URL environment variable and start Voidswarm again.';
    }
  }
  return null;
}

/** Another copy's data folder the first-run page can offer to bring in (§2.5 "Bring in data from another copy"). */
export interface ImportCandidate {
  /** The other copy's folder (…\Voidswarm LAN (old)). */
  root: string;
  /** Its data folder. */
  dataDir: string;
  /** It has a database (accounts, the chat log); without one there are only settings. */
  hasDb: boolean;
  /** The database's size in bytes (0 without one). */
  dbBytes: number;
  /** The last change of its database (or settings), ms since epoch. */
  modifiedAt: number | null;
}

/** Candidates offered at most (newest first). */
export const MAX_IMPORT_CANDIDATES = 10;

/**
 * The `…\Voidswarm LAN*\data` folders next to this copy and in the profile (§2.5), for the first-run page's
 * "Bring in data from another copy". The launcher lists them because the sandboxed server can read only its own
 * folder (--allow-fs-read=<root>). Read-only: a directory listing and a few stats. Skips this copy, links and
 * junctions, folders already moved elsewhere (MOVED-TO.json) and folders with neither a database nor settings.
 * Never throws.
 */
export function findImportCandidates(root: string, dataDir: string, opts: { env?: Env; platform?: Platform } = {}): ImportCandidate[] {
  const platform = opts.platform ?? process.platform;
  const api = pathApi(platform);
  const env = opts.env ?? process.env;
  const home = platform === 'win32' ? envGet(env, 'USERPROFILE') : envGet(env, 'HOME');
  const same = (a: string, b: string): boolean => isUnder(a, b, platform) && isUnder(b, a, platform);
  const places: string[] = [];
  for (const d of [api.dirname(api.resolve(root)), home ? api.resolve(home) : null]) {
    if (d && !places.some((p) => same(p, d))) places.push(d);
  }
  const prefix = LAN_FOLDER_NAME.toLowerCase();
  const found: ImportCandidate[] = [];
  for (const place of places) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(place, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.toLowerCase().startsWith(prefix)) continue;
      const otherRoot = api.join(place, e.name);
      const otherData = api.join(otherRoot, 'data');
      if (same(otherRoot, root) || same(otherData, dataDir) || isUnder(dataDir, otherRoot, platform)) continue;
      if (found.some((f) => same(f.dataDir, otherData))) continue;
      try {
        if (!fs.lstatSync(otherData).isDirectory()) continue;
        if (fs.existsSync(api.join(otherData, 'MOVED-TO.json'))) continue;
        const stat = (f: string): fs.Stats | null => { try { const s = fs.lstatSync(api.join(otherData, f)); return s.isFile() ? s : null; } catch { return null; } };
        const db = stat('voidswarm.db');
        const cfg = stat('voidswarm.config.json');
        if (!db && !cfg) continue;
        found.push({ root: otherRoot, dataDir: otherData, hasDb: !!db, dbBytes: db?.size ?? 0, modifiedAt: (db ?? cfg)?.mtimeMs ?? null });
      } catch { /* unreadable: not offered */ }
    }
  }
  found.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
  return found.slice(0, MAX_IMPORT_CANDIDATES);
}

/** data\MOVED-TO.json (written by "Bring in data from another copy", §2.5) → the refusal, or null. */
export function movedRefusal(file: string): string | null {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : 'This data folder was moved to another copy of Voidswarm (data\\MOVED-TO.json) — start that copy.';
  }
  let to = '';
  let when = '';
  try {
    const j = JSON.parse(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    const t = j.movedTo ?? j.to ?? j.path ?? j.root;
    if (typeof t === 'string') to = t.slice(0, 300);
    const at = j.at ?? j.movedAt ?? j.date;
    const d = typeof at === 'number' || typeof at === 'string' ? new Date(at) : null;
    if (d && !Number.isNaN(d.getTime())) when = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { /* an unreadable marker still refuses */ }
  return `This data was moved to ${to || 'another copy of Voidswarm'}${when ? ` on ${when}` : ''} — start that copy.`;
}

/** First-run setup as the database records it: 'first' (no host admin yet), 'reset' (a password reset), 'done'. */
export type SetupState = 'first' | 'reset' | 'done';

/**
 * The host admin's state in data\voidswarm.db, read before the first child starts (§3.1: loopback until setup). No
 * database, or one without the host admin table (a pre-LAN one the child will migrate), is 'first'. null = can't tell
 * (locked past the short busy wait, damaged): the child's 'ready' decides, as before. The file is written by the
 * sandboxed child, so it is opened read-only on a protected connection (trusted_schema OFF, the authorizer: no
 * ATTACH, no extension), and only one indexed row is read.
 */
export function readSetupState(dbPath: string): SetupState | null {
  if (!fs.existsSync(dbPath)) return 'first';
  let db: ReturnType<typeof openProtectedDb> | null = null;
  try {
    db = openProtectedDb(dbPath, { readOnly: true, busyTimeoutMs: 250, foreignKeys: false });
    const table = db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = 'host_admins'").get();
    if (!table) return 'first';
    const st = hostAdminState(db);
    return !st.setupPending ? 'done' : st.setupKind === 'reset' ? 'reset' : 'first';
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

// ------------------------------------------------------------------------------------------
// The launch
// ------------------------------------------------------------------------------------------

/** A launcher notice for the panel's banner row (lan:start `banners`). */
export interface LauncherBanner {
  code: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}

/** Where a child listens and whether players can join (lan:start bind / publicUrl / serveLan / notServing). */
interface ServeState {
  serveLan: boolean;
  notServing: NotServingReason | null;
  bind: string;
  publicUrl: string;
}

/** A child listening on loopback only (players can't reach it). */
export const isLoopbackBind = (bind: string | null | undefined): boolean =>
  !bind || bind === '127.0.0.1' || bind === '::1' || bind === 'localhost';

/** The first message to the child. src/server/app.ts parseLanStart reads the first block; the rest is for B2/B6/B9/B12+. */
export interface LanStartMessage {
  type: 'lan:start';
  dataDir: string;
  port: number;
  bind: string;
  serveDir?: string;
  adminPageDir?: string;
  publicUrl: string;
  primary: string | null;
  preset: Preset;
  // --- B4b additions (parseLanStart ignores them today) ---
  /** The admin listener's port (B6 binds it on loopback). */
  adminPort: number;
  /** Players may join (the game listener goes beyond loopback). */
  serveLan: boolean;
  /** Why not, when serveLan is false. */
  notServing: NotServingReason | null;
  /** data\secrets as base64 (never pipe.key): decodeBundle → memorySecrets. */
  secrets: SecretBundle;
  /** The first-run setup code (8 Crockford base32 characters). The child keeps only its hash; never log it. */
  setupCode: string;
  /** The projector page's folder (app\display). */
  displayDir?: string;
  /** The launcher relays a maintenance process ({type:'maint:*'}, src/lan/maintRelay.ts). */
  maint: boolean;
  /** Launcher findings for the panel's banners (elevated at Home, permissions at Home, marked files, preflight, …). */
  banners: LauncherBanner[];
  /** The cached host checks (network category, firewall, power, disk) for the Network check and the Server panel. */
  preflight: PreflightReport | null;
  /** Set after a supervised restart: "The server restarted after an error at 10:14". */
  restart: (RestartInfo & { notice: string }) | null;
  /**
   * Other copies' data folders for the first-run page's "Bring in data from another copy" (§2.5, T-LAN-16). The
   * child can't list or read them itself (its sandbox reads only this copy): the import runs through the launcher.
   */
  importCandidates: ImportCandidate[];
  launcher: { version: string; node: string; pid: number; startedAt: number; buildDate: string | null; root: string };
}

/** What the staged-work step gets (§2.2 step 8): no server is running on the data folder yet. */
export interface StagedWorkContext {
  paths: LanPaths;
  log: HostLog;
  settings: HostSettings;
}

export interface LaunchDeps {
  /** The install root (default: from the launcher file). */
  root?: string;
  /** Default: this module's file (app\launch.mjs). */
  launcherFile?: string;
  /** Default <root>\app\server.mjs. */
  serverEntry?: string;
  /** Default app\maint.mjs beside the server entry (the maintenance process, src/lan/maintRelay.ts); null = none. */
  maintEntry?: string | null;
  /** Default process.execPath (runtime\node.exe under the stub). */
  execPath?: string;
  env?: Env;
  platform?: Platform;
  cwd?: string;
  now?: () => number;
  /** The console (default stdout + process.title). */
  out?: ConsoleOut;
  /** Default openInBrowser. */
  openBrowser?: (url: string) => Promise<void>;
  /** Every OS tool the checks run (tests inject). */
  exec?: ExecFn;
  // Check overrides (tests; later tasks).
  checkLocation?: (root: string, dataDir: string) => Promise<LocationReport>;
  readToken?: () => Promise<TokenInfo>;
  checkPermissions?: (opts: AclOptions) => Promise<AclReport>;
  fixPermissions?: (opts: AclOptions) => Promise<{ report: AclReport; ran: string[]; errors: string[] }>;
  protectDir?: (dir: string, userSid: string) => Promise<string | null>;
  scanMotw?: (root: string) => MotwReport;
  /** `ran: false` = the report came from the cache (then the firewall section is read again: `readFirewall`). */
  preflight?: (opts: PreflightOptions) => Promise<{ report: PreflightReport; ran?: boolean }>;
  /** The startup firewall re-read (default preflight.ts readFirewall; null = couldn't read, keep the cached one). */
  readFirewall?: (opts: { nodeExe: string; platform: Platform; exec: ExecFn; env: Env }) => Promise<PreflightReport['firewall']>;
  /** The primary LAN address (B12's primary.ts plugs in here). */
  primary?: () => Promise<string | null> | string | null;
  choosePorts?: (opts: ChoosePortsOptions) => Promise<ChoosePortsResult>;
  /**
   * §2.2 step 8: apply a staged restore and clean update leftovers. Returns notes (banners). Default: restore.ts
   * applyStagedRestore. When it returns notes the settings are read again (a restore may have replaced them).
   */
  stagedWork?: (ctx: StagedWorkContext) => Promise<string[]> | string[];
  /** First-run setup on a later run, before the first child (default readSetupState on data\voidswarm.db). */
  setupState?: (dbPath: string) => SetupState | null;
  /** The other copies the first-run page offers to bring in (default findImportCandidates). */
  importCandidates?: (root: string, dataDir: string) => ImportCandidate[];
  /** The pipe path (tests). */
  pipe?: string;
  /** false = the child runs without --permission (tests of the flow with a fake child). */
  sandbox?: boolean;
  /** Install signal / uncaught-exception handlers (main() does; tests don't). */
  processHandlers?: boolean;
  titleIntervalMs?: number;
  readyTimeoutMs?: number;
  restartDelayMs?: number;
  /** Extra Node flags for the child (tests). */
  childExecArgv?: string[];
  /** Called at once with a handle that can stop a launch still starting (main()'s signal handlers). */
  onHandle?: (h: { stop(reason: string): void }) => void;
}

export interface LanHost {
  paths: LanPaths;
  ports: PortPlan;
  panelUrl: string;
  /** The URL the browser was sent to (null with --no-browser / openBrowser off). */
  openedUrl: string | null;
  /** This launcher run's code (every child's lan:start carries it, so a restarted child keeps the setup state). */
  setupCode: string;
  /** The code the console showed last: this run's, or one the child minted after a void or an expiry. */
  readonly currentSetupCode: string;
  /** Setup (first run, or after a password reset) is pending, as the latest child said. */
  readonly setupPending: boolean;
  preset: Preset;
  primary: string | null;
  /** Players can join now: the latest child listens beyond loopback and setup is done. */
  readonly serveLan: boolean;
  supervisor: Supervisor;
  log: HostLog;
  /** Resolves with the launcher's exit code when the host has stopped (pipe released, log flushed). */
  finished: Promise<number>;
  stop(reason?: string): Promise<number>;
}

export interface LaunchResult {
  /** Set when the launch ended without a running host (refused, second launch, failed start). */
  exitCode: number | null;
  host: LanHost | null;
}

class Refused extends Error {
  constructor(readonly exitCode: number, message: string) { super(message); }
}

/**
 * Runs §2.2 steps 1–13 and resolves once the host is running (`host`), or with the exit code when it didn't start
 * (a refusal, a second launch, a startup failure). The console gets the banner or the refusal.
 */
export async function launch(argv: readonly string[], deps: LaunchDeps = {}): Promise<LaunchResult> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? execTool;
  const now = deps.now ?? Date.now;
  const cons = new HostConsole({ out: deps.out ?? processConsole(), now });
  const startedAt = now();

  const flags = parseLaunchArgs(argv, deps.cwd);
  if ('error' in flags) {
    cons.fatal(`${flags.error}\n${USAGE_TEXT}`);
    return { exitCode: LAUNCH_EXIT.USAGE, host: null };
  }
  const root = path.resolve(deps.root ?? rootFromLauncher(deps.launcherFile ?? fileURLToPath(import.meta.url), platform));
  const paths = lanPaths(root, { data: flags.data ?? undefined, platform });
  // The server may write to its data folder only (§2.2): a --data folder that is (or holds) the Voidswarm folder, or
  // lies in its program folders, would let the network-facing child replace what this launcher runs.
  const dataConflict = dataDirConflict(root, paths.data, platform);
  if (dataConflict) {
    cons.fatal(`The data folder ${paths.data} can't be used: ${dataConflict}. The server may change only its own data `
      + `folder, so it must be a separate folder (the default is ${path.join(root, 'data')}).\n${USAGE_TEXT}`);
    return { exitCode: LAUNCH_EXIT.USAGE, host: null };
  }
  const serverEntry = deps.serverEntry ?? path.join(paths.app, 'server.mjs');
  const execPath = deps.execPath ?? process.execPath;
  const openBrowser = deps.openBrowser ?? ((url: string) => openInBrowser(url, { exec, platform, env }));

  /** Short lines under the banner. */
  const notes: string[] = [];
  /** Host-log lines from the checks that run before data\logs exists (written once the log is open). */
  const earlyLog: string[] = [];
  const banners: LauncherBanner[] = [];
  const addBanner = (code: string, level: LauncherBanner['level'], text: string | null | undefined): void => {
    if (text) banners.push({ code, level, text });
  };

  let lock: HostLock | null = null;
  let log: HostLog | null = null;
  let supervisor: Supervisor | null = null;
  let stopRequested: string | null = null;
  const ctx = { adminPort: 7778, stopHost: (reason: string): void => { stopRequested = stopRequested ?? reason; void supervisor?.stop(reason); } };

  deps.onHandle?.({ stop: (reason) => ctx.stopHost(reason) });

  const cleanup = async (): Promise<void> => {
    try { await lock?.close(); } catch { /* released on exit anyway */ }
    try { await log?.close(); } catch { /* best effort */ }
  };

  try {
    // 0. Settings that belong to the VPS kit.
    const vps = vpsSettingsRefusal(env);
    if (vps) throw new Refused(LAUNCH_EXIT.REFUSED, vps);

    // The stored settings, read only (the preset and the launcher policies decide how strict the checks are).
    let stored: HostSettings | null = null;
    try {
      const raw = readConfigFile(paths.config).raw;
      stored = raw ? settingsFromRaw(raw, { lan: true }) : null;
    } catch (e) {
      if (e instanceof SettingsLoadError) throw new Refused(LAUNCH_EXIT.DATA, e.message);
      throw e;
    }
    let preset: Preset = stored?.preset ?? 'home';
    if (stored) ctx.adminPort = stored.network.adminPort;

    // 1. Location.
    if (flags.skipLocationCheck) {
      notes.push('The location check is off (--skip-location-check): this is for tests only.');
    } else {
      const loc = await (deps.checkLocation
        ? deps.checkLocation(root, paths.data)
        : checkLocation(root, paths.data, {
          ...(deps.env ? { env } : {}),
          ...(deps.platform ? { platform } : {}),
          volume: volumeLookup({ dataDir: paths.data, root, version: GAME_VERSION, exec, env }),
        }));
      if (!loc.ok) throw new Refused(LAUNCH_EXIT.REFUSED, loc.message ?? 'Voidswarm can\'t run from this folder.');
      for (const w of loc.warnings) { notes.push(w.detail); addBanner(`location-${w.code}`, 'info', w.detail); }
    }

    // 6 (early: it makes every other check moot). Moved data.
    const moved = movedRefusal(paths.movedTo);
    if (moved) throw new Refused(LAUNCH_EXIT.REFUSED, moved);

    // 2. Elevation.
    const token = await (deps.readToken ? deps.readToken() : readToken({ exec, platform }));
    const elev = decideElevation(token, policyPreset(stored?.launcher.elevated, preset));
    if (elev.decision === 'refuse') throw new Refused(LAUNCH_EXIT.REFUSED, elev.message ?? 'Voidswarm was started as administrator.');
    if (elev.decision === 'warn') { notes.push(elev.banner ?? elev.message ?? 'Running as administrator.'); addBanner('elevated', 'warn', elev.message); }
    const userSid = token.userSid;

    // 3. Permissions (read-only icacls; the fix only with --fix-permissions). 'off' (the panel's "Don't warn me again")
    //    skips the check: one host-log line, no banner, no console warning; --fix-permissions still runs when given.
    const permPolicy = stored?.launcher.permissions;
    const permsOff = permPolicy === 'off';
    const aclPreset = policyPreset(permPolicy, preset);
    if (permsOff) earlyLog.push(flags.fixPermissions ? "launcher.permissions is 'off'; --fix-permissions runs the fix anyway" : PERMISSIONS_OFF_LOG);
    if (permsOff && !flags.fixPermissions) {
      // Nothing to check.
    } else if (platform === 'win32' && !userSid) {
      if (!permsOff) {
        notes.push("Folder permissions couldn't be checked (whoami didn't answer).");
        addBanner('permissions-unchecked', 'warn', "Voidswarm couldn't check who can reach its folder (whoami didn't answer).");
      }
    } else if (userSid) {
      const aclOpts: AclOptions = { root, dataDir: paths.data, userSid, preset: aclPreset, platform, exec, checkOwners: !stored };
      let acl: AclReport;
      if (flags.fixPermissions) {
        cons.print('Fixing the folder permissions (only you, SYSTEM and Administrators)…');
        const fix = await (deps.fixPermissions ?? fixPermissions)({ ...aclOpts, checkOwners: true });
        for (const e of fix.errors) cons.print(`  ! ${e}`);
        cons.print(fix.report.ok ? 'The folder permissions are fixed.' : 'Some permissions could not be fixed (see below).');
        acl = fix.report;
      } else {
        acl = await (deps.checkPermissions ?? checkPermissions)(aclOpts);
      }
      if (permsOff) {
        // The fix ran (--fix-permissions); whatever is left is not reported (the host turned the warning off).
      } else if (acl.decision === 'refuse') {
        throw new Refused(LAUNCH_EXIT.REFUSED, acl.message ?? 'Other accounts can reach Voidswarm\'s folder.');
      } else if (acl.decision === 'warn') {
        notes.push(acl.banner ?? 'Permissions warning: other accounts on this PC can reach Voidswarm\'s folder.');
        addBanner('permissions', 'warn', acl.message);
      }
    }

    // 4. Mark-of-the-Web: listed, never stripped.
    const motw = (deps.scanMotw ?? ((r: string) => scanMotw(r, { platform })))(root);
    if (motw.message) {
      notes.push(`${motw.files.length} file(s) are still marked as downloaded from the internet: see the control panel.`);
      addBanner('motw', 'warn', motw.message);
    }

    // 5. The single-instance lock (before anything is written to data\).
    let existingKey: Buffer | null = null;
    try { const k = fs.readFileSync(paths.pipeKey); existingKey = k.length >= 16 ? k : null; } catch { existingKey = null; }
    const acquired = await acquireLock({
      dataDir: paths.data,
      key: existingKey,
      platform,
      pipe: deps.pipe,
      handlers: {
        version: GAME_VERSION,
        panelUrl: () => `http://localhost:${ctx.adminPort}/`,
        status: async () => ({
          launcher: { version: GAME_VERSION, pid: process.pid, startedAt, restarts: supervisor?.restartCount ?? 0, stopping: !!stopRequested },
          server: supervisor ? await supervisor.status(1500) : null,
        }),
        stop: () => ctx.stopHost('pipe'),
        reloadAdmin: () => { supervisor?.send({ type: 'reload-admin' }); },
      },
    });
    if (!acquired.ok) {
      const r = await secondLaunch({ dataDir: paths.data, key: existingKey, openBrowser, platform, pipe: deps.pipe });
      cons.print(r.message);
      return { exitCode: r.exitCode, host: null };
    }
    lock = acquired.lock;

    // data\ and the host log (from here on everything the launcher says is also in data\logs).
    try { fs.mkdirSync(paths.data, { recursive: true }); } catch (e) {
      throw new Refused(LAUNCH_EXIT.DATA, `Voidswarm could not create its data folder ${paths.data}: ${(e as Error).message}`);
    }
    log = createHostLog({ dir: paths.logs, tag: 'launcher', now });
    cons.setLog(log);
    const hostLog = log;
    if (deps.processHandlers !== false) process.on('exit', () => hostLog.flushSync());
    log.write(`Voidswarm LAN ${GAME_VERSION} starting (Node ${process.version}, pid ${process.pid}, ${platform})`);
    for (const l of earlyLog.splice(0)) log.write(l);

    // 7. Config: created (code defaults → Home → the environment) on the first run.
    const openSettings = (): SettingsService => {
      try {
        return SettingsService.open({ dataDir: paths.data, env, lan: true, log: (l) => hostLog.write(l) });
      } catch (e) {
        if (e instanceof SettingsLoadError) throw new Refused(LAUNCH_EXIT.DATA, e.message);
        throw new Refused(LAUNCH_EXIT.DATA, `Voidswarm could not save its settings in ${paths.data}: ${(e as Error).message}`);
      }
    };
    let settings = openSettings();
    const firstRun = settings.created;
    let s = settings.get();
    preset = s.preset;

    // data\secrets\: protected BEFORE any secret is written; the random keys exist from the first run on.
    const prep = await prepareSecretsDir(paths.data, {
      platform,
      protectDir: userSid ? (d: string) => (deps.protectDir ?? ((dir: string, sid: string) => protectDir(dir, sid, { exec, platform })))(d, userSid) : undefined,
    });
    for (const e of prep.errors) { notes.push(e); addBanner('secrets-acl', 'warn', e); }
    const secrets = openFileSecrets(paths.data, { platform });
    try {
      for (const k of ['pepper.key', 'backup.key', 'pipe.key'] as const) secrets.ensureKey(k);
    } catch (e) {
      if (e instanceof SecretError) throw new Refused(LAUNCH_EXIT.DATA, e.message);
      throw e;
    }
    lock.setKey(secrets.read('pipe.key'));
    const sc = checkSecrets(paths.data, { platform });
    for (const p of sc.problems) { notes.push(`data\\${p.what}: ${p.why}`); addBanner('secrets', 'warn', `data\\${p.what}: ${p.why}`); }

    /**
     * The child's secrets, read fresh for every child (a secret the previous one saved, such as a new SMTP password,
     * must reach the restarted one). A damaged or unreadable REQUIRED key refuses (LAUNCH_EXIT.DATA); an optional one
     * (the SMTP password, a TLS key) is left out with a banner, so the host still starts or restarts without it.
     */
    const childSecrets = (): { bundle: SecretBundle; problems: string[] } => {
      const out: Partial<Record<SecretName, string>> = {};
      const problems: string[] = [];
      for (const n of CHILD_SECRETS) {
        const required = REQUIRED_CHILD_SECRETS.includes(n);
        let b: Buffer | null;
        try {
          b = secrets.read(n);
          if (required && (!b || b.length !== KEY_BYTES)) {
            throw new SecretError('EDAMAGED', `data\\secrets\\${n} is ${b ? 'damaged' : 'missing'}. Restore it from the recovery file, or restore a backup ("Restore a backup.cmd").`);
          }
        } catch (e) {
          const msg = e instanceof SecretError ? e.message : `data\\secrets\\${n} can't be read: ${(e as Error)?.message ?? e}`;
          if (required) throw new Refused(LAUNCH_EXIT.DATA, msg);
          problems.push(`${msg} Voidswarm runs without it until it is fixed.`);
          continue;
        }
        if (b) out[n] = b.toString('base64');
      }
      return { bundle: { v: BUNDLE_VERSION, secrets: out }, problems };
    };

    // 8. Staged work: a restore staged from the panel (restore.ts), update leftovers. Nothing runs on the data folder
    //    yet (the pipe lock is held). A failure here may have left the database mid-swap: refuse (restore.ts rolls an
    //    interrupted swap back at the next start, and the staged file is already gone, so it never loops).
    let stagedNotes: string[];
    try {
      stagedNotes = await (deps.stagedWork ?? ((c: StagedWorkContext) => applyStagedRestore(c, { now })))({ paths, log, settings: s });
    } catch (e) {
      log.write(`staged work failed: ${(e as Error)?.stack ?? e}`);
      throw new Refused(LAUNCH_EXIT.DATA, `Voidswarm could not finish the work staged for this start (a restore): ${(e as Error)?.message ?? e}. `
        + 'Start it again; if this keeps happening, use "Restore a backup.cmd".');
    }
    for (const n of stagedNotes) { notes.push(n); addBanner('staged', 'info', n); }
    // Update leftovers (read-only here: the Start stub refuses while an update journal exists, and Update
    // Voidswarm.cmd finishes or undoes an interrupted swap itself through update.recover.mjs, B11).
    try {
      for (const n of updateLeftoverNotes(root)) { notes.push(n); addBanner('update-leftover', 'warn', n); }
    } catch { /* nothing to say */ }
    if (stagedNotes.length) {
      // A restore may have replaced the settings (restore.ts: "the launcher should re-read its settings").
      await settings.close();
      settings = openSettings();
      s = settings.get();
      preset = s.preset;
    }

    // 9. Preflight and the primary address.
    const primary = (await (deps.primary ? deps.primary() : findPrimaryAddress())) ?? null;
    let report: PreflightReport | null = null;
    try {
      const pf = await (deps.preflight ?? getPreflight)({ dataDir: paths.data, version: GAME_VERSION, nodeExe: execPath, primary, platform, exec, env, now });
      report = pf.report;
      // A cached report (a day old at most): the firewall part is re-read now (read-only, about a second), so a rule
      // IT just added, or a Block rule from a cancelled Windows prompt, shows at this start. Not needed on this PC only.
      if (pf.ran === false && !flags.thisPcOnly) {
        try {
          const fw = await (deps.readFirewall ?? readFirewall)({ nodeExe: execPath, platform, exec, env });
          if (fw) report = { ...report, firewall: fw };
        } catch (e) {
          log.write(`the firewall re-read failed: ${(e as Error)?.message ?? e}`);
        }
      }
    } catch (e) {
      log.write(`preflight failed: ${(e as Error)?.message ?? e}`);
    }
    if (report) {
      for (const n of preflightNotices(report, { preset, thisPcOnly: flags.thisPcOnly })) {
        addBanner(`preflight-${n.code}`, n.level, n.text);
        if (n.level !== 'info') notes.push(n.console ?? n.text);
      }
    }
    const allowed = lanServingAllowed(report, primary);
    // Players join only after first-run setup (§3.1, P-m2). On the first run it is pending (the config was just made);
    // on a later run the database says (readSetupState), so the first child is already on loopback when the host
    // closed Voidswarm before finishing setup. When the database can't tell, the child says so in 'ready'
    // (setupPending), and a child that is then listening beyond loopback is replaced by one on loopback (below).
    const networkReason: NotServingReason | null = flags.thisPcOnly ? 'this-pc-only'
      : !primary ? 'no-address' : !allowed.allowed ? 'public-network' : null;
    let dbSetup: SetupState | null = 'first';
    if (!firstRun) {
      try { dbSetup = (deps.setupState ?? readSetupState)(paths.db); } catch { dbSetup = null; }
      log.write(`first-run setup, as the database says: ${dbSetup ?? 'unknown (the server will say)'}`);
    }
    const initialReason: NotServingReason | null = networkReason ?? (dbSetup === 'first' ? 'setup' : null);

    // 11. Ports: chosen once and stored; Home's first run may move to the next free pair.
    const envPort = firstRun ? Number(envGet(env, 'PORT')) : NaN;
    const seededPort = Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535 - ENV_PORT_PICK_SPAN - 1 ? envPort : null;
    const portOpts: ChoosePortsOptions = {
      preset: s.network.portAutoPick === 'never' ? 'school' : preset,
      stored: firstRun ? null : { game: s.network.port, admin: s.network.adminPort },
      standardPorts: s.network.standardPorts,
      primary,
      ...(seededPort ? { firstGamePort: seededPort, lastGamePort: seededPort + ENV_PORT_PICK_SPAN } : {}),
    };
    const ports = await (deps.choosePorts ?? choosePorts)(portOpts);
    if (!ports.ok) throw new Refused(LAUNCH_EXIT.PORT, ports.message);
    const plan = ports.plan;
    if (ports.persist) {
      const r = await settings.apply({ network: { port: plan.game, adminPort: plan.admin } }, LAUNCHER_ACTOR, { context: 'ports' });
      if (!r.ok) log.write(`could not save the ports: ${r.error}`);
      else s = settings.get();
    }
    if (ports.note) notes.push(ports.note);
    ctx.adminPort = plan.admin;
    const openBrowserSetting = s.network.openBrowser;
    await settings.close();

    if (stopRequested) throw new Refused(LAUNCH_EXIT.OK, 'Stopped before the server started.');

    // 12. The sandboxed child, secrets over IPC.
    if (!fs.existsSync(serverEntry)) {
      throw new Refused(LAUNCH_EXIT.CRASH, `The server program is missing (${path.relative(root, serverEntry) || serverEntry}). Unzip the WHOLE folder again.`);
    }
    // Checked once before the first child: a damaged required key refuses here (exit 3); an optional one is a banner.
    const knownSecretProblems = new Set(childSecrets().problems);
    for (const p of knownSecretProblems) { notes.push(p); addBanner('secrets-left-out', 'warn', p); hostLog.write(`a secret was left out: ${p}`); }

    const setupCode = newSetupCode();
    /** The code the console showed last (a child mints a new one after a void or an expiry: {type:'setup-code'}). */
    let shownSetupCode = setupCode;
    /**
     * Where the next child listens: loopback while first-run setup is pending (a child reports it in 'ready'), the LAN
     * address once it is done ('setup-done', or setupPending false in 'ready' / 'status'; onSetupDone below).
     */
    const serveFor = (reason: NotServingReason | null): ServeState => (reason === null && primary
      ? { serveLan: true, notServing: null, bind: primary, publicUrl: `http://${primary}:${plan.game}` }
      : { serveLan: false, notServing: reason ?? 'no-address', bind: '127.0.0.1', publicUrl: `http://localhost:${plan.game}` });
    let serve = serveFor(initialReason);
    const buildInfo = readBuildInfo(paths.app);
    // For the first-run page (it shows them only while setup is pending): cheap, so looked up on every start.
    let importCandidates: ImportCandidate[] = [];
    try { importCandidates = (deps.importCandidates ?? ((r: string, d: string) => findImportCandidates(r, d, { env, platform })))(root, paths.data); } catch { /* none offered */ }
    if (importCandidates.length) log.write(`${importCandidates.length} other Voidswarm LAN data folder(s) found for "Bring in data from another copy"`);
    const adminDir = path.join(paths.app, 'admin');
    const displayDir = path.join(paths.app, 'display');
    // The maintenance process (the child may start no worker thread: its sandbox has no --allow-worker).
    const maintEntry = deps.maintEntry === undefined ? maintEntryBeside(serverEntry) : deps.maintEntry;
    const maintRelay = maintEntry && fs.existsSync(maintEntry) ? new MaintRelay({
      entry: maintEntry,
      root,
      dataDir: paths.data,
      dbPath: paths.db,
      execPath,
      env,
      platform,
      sandbox: deps.sandbox !== false,
      execArgv: deps.childExecArgv,
      send: (m) => { supervisor?.send(m); },
      onOutput: (line) => childOut.write(`[maint] ${line.replace(/^\d\d:\d\d:\d\d(\.\d+)? /, '')}`),
      log: (line) => hostLog.write(line),
      now,
    }) : null;
    const startMessage = (restart: RestartInfo | null): LanStartMessage => {
      // Read fresh for every child: a secret the previous one saved (a new SMTP password) must not be lost on a restart.
      const cs = childSecrets();
      const extra: LauncherBanner[] = [];
      for (const p of cs.problems) {
        if (knownSecretProblems.has(p)) continue;
        knownSecretProblems.add(p);
        extra.push({ code: 'secrets-left-out', level: 'warn', text: p });
        hostLog.write(`a secret was left out: ${p}`);
      }
      if (extra.length) banners.push(...extra);
      return {
        type: 'lan:start',
        dataDir: paths.data,
        port: plan.game,
        bind: serve.bind,
        ...(fs.existsSync(paths.web) ? { serveDir: paths.web } : {}),
        ...(fs.existsSync(adminDir) ? { adminPageDir: adminDir } : {}),
        ...(fs.existsSync(displayDir) ? { displayDir } : {}),
        maint: !!maintRelay,
        publicUrl: serve.publicUrl,
        primary,
        preset,
        adminPort: plan.admin,
        serveLan: serve.serveLan,
        notServing: serve.notServing,
        secrets: cs.bundle,
        setupCode,
        banners: restart ? [...banners, { code: 'restarted', level: 'warn', text: restartNotice(restart.at) }] : [...banners],
        preflight: report,
        restart: restart ? { ...restart, notice: restartNotice(restart.at) } : null,
        importCandidates,
        launcher: { version: GAME_VERSION, node: process.version, pid: process.pid, startedAt, buildDate: buildInfo.buildDate, root },
      };
    };

    const childOut = createHostLog({ dir: paths.logs, tag: 'server', now, redactor: new Redactor() });
    let titleState: 'starting' | 'running' | 'restarting' | 'stopping' = 'starting';
    let stdoutNoted = false;
    /** A sliding one-minute budget per kind of child request (the child is network-facing; the launcher is not). */
    const budgets = new Map<string, number[]>();
    const withinBudget = (kind: string, perMinute: number): boolean => {
      const t = now();
      const list = budgets.get(kind) ?? [];
      while (list.length && t - list[0] > 60_000) list.shift();
      budgets.set(kind, list);
      if (list.length >= perMinute) return false;
      list.push(t);
      return true;
    };
    /** The data folder's own folders, by name only (a Map: no inherited keys): the path never comes from the child. */
    const folders = new Map<string, string>([['backups', paths.backups], ['exports', paths.exports], ['logs', paths.logs], ['data', paths.data]]);
    /** Setup is pending, as the latest child said (the first 'ready' decides the banner's value). */
    let setupPendingNow = dbSetup === 'first' || dbSetup === 'reset';
    /** Assigned once the supervisor exists (below): 'setup-done' and a setup-free 'ready' / 'status' call it. */
    let onSetupDone: (why: string) => void = () => undefined;
    const onChildMessage = (m: Record<string, unknown>): void => {
      if (maintRelay?.handle(m)) return;
      if (m.type === 'notice' && typeof m.text === 'string') {
        // A rare one-line notice from the server (the index tidy, an address change); at most 10 a minute.
        if (!withinBudget('notice', CHILD_NOTICES_PER_MIN)) { hostLog.write(`notice (not shown): ${m.text.slice(0, 200)}`); return; }
        cons.notice(m.text.slice(0, 200));
      } else if (m.type === 'open-folder' && typeof m.which === 'string') {
        const which = m.which;
        const dir = folders.get(which);
        if (!dir) return;
        if (!withinBudget('open-folder', CHILD_OPEN_FOLDER_PER_MIN)) {
          hostLog.write(`open-folder ${which}: refused (more than ${CHILD_OPEN_FOLDER_PER_MIN} a minute)`);
          supervisor?.send({ type: 'open-folder:done', which, ok: false });
          return;
        }
        void openFolder(dir, { exec, platform, env }).then((ok) => supervisor?.send({ type: 'open-folder:done', which, ok }));
      } else if (m.type === 'setup-code') {
        // A fresh code the child minted after a void (too many wrong tries) or an expiry (hostAdmin onSetupCode). It is
        // shown in the console only: the host log never carries a code (§5.1). lan:start keeps this run's own code, so a
        // restarted child recognises the same launcher run (hostAdmin installLaunchCode).
        const code = typeof m.code === 'string' ? m.code : '';
        if (!SETUP_CODE_RE.test(code)) { hostLog.write('ignored a malformed setup-code message from the server'); return; }
        if (!withinBudget('setup-code', CHILD_SETUP_CODES_PER_MIN)) { hostLog.write('a new setup code was not shown (too many a minute)'); return; }
        shownSetupCode = code;
        setupPendingNow = true;
        const why = m.why === 'void' ? 'void' : m.why === 'expired' ? 'expired' : null;
        const because = why === 'void' ? ' (the old one stopped working after too many wrong tries)' : why === 'expired' ? ' (the old one expired)' : '';
        cons.print(noticeLine(`New setup code: ${formatSetupCode(code)}${because}`, now()));
        hostLog.write(`a new setup code was shown in the console${why ? ` (the old one ${why})` : ''}`);
      } else if (m.type === 'setup-done') {
        // B6, once the host admin login exists: players may join on the LAN address now (§3.1, §4.10).
        setupPendingNow = false;
        onSetupDone('the server says so');
      }
    };

    /** A respawn a setup switch started (see 'ready' and onSetupDone); the banner waits for it. */
    let setupRespawn: Promise<ChildReady> | null = null;
    /** The latest child's 'ready' (the title and host.serveLan follow it). */
    let lastReady: ChildReady | null = null;
    /** Setup was finished during this run: the first LAN child after it gets the "players can join" line. */
    let joinNoticePending = false;
    let bannerShown = false;
    let setupSwitches = 0;
    /** Set once the title is known (after the banner): a setup switch refreshes it at once. */
    let refreshTitle: () => void = () => undefined;
    /** First-run setup is pending on this child: players must not join (§3.1). A password reset is not first-run setup. */
    const setupGates = (r: { setupPending?: unknown; setupKind?: unknown } | null): boolean =>
      !!r && r.setupPending === true && r.setupKind !== 'reset';
    /** The child says first-run setup is behind it: done, or only a password reset (players keep playing). */
    const setupClear = (r: { setupPending?: unknown; setupKind?: unknown } | null): boolean =>
      !!r && (r.setupPending === false || (r.setupPending === true && r.setupKind === 'reset'));
    /** Players can join: the child listens beyond loopback and first-run setup is not pending. */
    const serving = (r: ChildReady | null): boolean => !!r && serve.serveLan && !isLoopbackBind(r.bind) && !setupGates(r);
    /** What a 'ready' or a 'status' says about setup. */
    const noteSetup = (r: { setupPending?: unknown; setupKind?: unknown } | null, why: string): void => {
      if (!r) return;
      if (typeof r.setupPending === 'boolean') setupPendingNow = r.setupPending;
      if (setupClear(r)) onSetupDone(why);
    };
    /** A server child's maintenance process ends with it (the next child asks for its own). */
    const watchMaint = (c: ServerChild): ServerChild => {
      void c.exited.then(() => maintRelay?.serverGone());
      return c;
    };
    const sup = new Supervisor({
      spawn: (restart) => watchMaint(new ServerChild({
        entry: serverEntry,
        root,
        dataDir: paths.data,
        start: startMessage(restart) as unknown as Record<string, unknown>,
        execPath,
        env,
        platform,
        sandbox: deps.sandbox !== false,
        execArgv: deps.childExecArgv,
        readyTimeoutMs: deps.readyTimeoutMs,
        onOutput: (line, stream) => {
          if (stream === 'stdout' && !stdoutNoted) {
            // The quiet console (installChildLogging) keeps the child's own lines off its pipes; a pipe the launcher
            // stops reading (a QuickEdit selection) would block a child that writes to it (§5.1, T-LAN-10).
            stdoutNoted = true;
            hostLog.write('note: the server writes its log to its stdout pipe (the launcher copies it here); the server should use its own log sink');
          }
          childOut.write(line.replace(/^\d\d:\d\d:\d\d(\.\d+)? /, ''));
        },
        onMessage: onChildMessage,
      })),
      restartDelayMs: deps.restartDelayMs,
      now,
      onEvent: (e: SupervisorEvent) => {
        if (e.type === 'crashed') {
          const why = e.exit.readyTimeout ? 'it did not start in time'
            : e.exit.signal ? `killed (${e.exit.signal})`
              : `exit code ${e.exit.code}${e.exit.wasReady ? '' : ' before it was ready'}`;
          hostLog.write(`the server stopped unexpectedly (${why})${e.willRestart ? ' — restarting it' : ''}`);
          if (e.exit.fatal) hostLog.write(`its last error: ${e.exit.fatal.message}`);
          titleState = 'restarting';
        } else if (e.type === 'respawning') {
          hostLog.write(`restarting the server (${e.reason})`);
          titleState = 'restarting';
        } else if (e.type === 'ready') {
          titleState = 'running';
          lastReady = e.ready;
          if (e.restart) cons.notice(restartNotice(e.restart.at));
          if (setupGates(e.ready) && serve.serveLan && !isLoopbackBind(e.ready.bind)) {
            // Setup is still pending (the host closed Voidswarm before finishing it) but this child listens on the LAN
            // address: players must not join before setup (§3.1). Every child from now on is on loopback only, until
            // the child says setup is done (onSetupDone).
            setupPendingNow = true;
            serve = serveFor(networkReason ?? 'setup');
            hostLog.write('first-run setup is still pending: the server is restarted on this PC only (loopback) until setup is done');
            setupRespawn = sup.respawn('first-run setup pending');
            return;
          }
          noteSetup(e.ready, 'the server started with setup done');
          if (joinNoticePending && serving(e.ready)) {
            joinNoticePending = false;
            if (bannerShown) cons.notice(`Setup is done: players can join at ${serve.publicUrl}`);
            refreshTitle();
          }
        }
      },
    });
    supervisor = sup;
    /**
     * First-run setup is done (or was never pending): the loopback child is replaced by one on the LAN address (§3.1),
     * unless the network itself keeps the game on this PC (no address, a Public network). A crash restart after this
     * keeps the LAN address. At most MAX_SETUP_SWITCHES times per run (see there).
     */
    onSetupDone = (why: string): void => {
      if (serve.notServing !== 'setup' || networkReason !== null || !primary || stopRequested || sup.isStopping) return;
      if (setupSwitches >= MAX_SETUP_SWITCHES) {
        if (setupSwitches === MAX_SETUP_SWITCHES) {
          setupSwitches++;
          hostLog.write(`setup is done again (${why}), but the server already switched ${MAX_SETUP_SWITCHES} times in this run: `
            + 'it stays on this PC only until Voidswarm is started again');
        }
        return;
      }
      setupSwitches++;
      serve = serveFor(null);
      joinNoticePending = true;
      hostLog.write(`first-run setup is done (${why}): the server is restarted to serve players on the LAN address`);
      setupRespawn = sup.respawn('first-run setup done');
    };

    let ready: ChildReady;
    try {
      ready = await sup.start();
      for (let p = setupRespawn; p; p = setupRespawn) {
        setupRespawn = null;
        ready = await p;
      }
    } catch (e) {
      const result = (e as { result?: SupervisorResult }).result;
      const code = result?.exitCode ?? LAUNCH_EXIT.CRASH;
      if (result?.reason === 'requested') throw new Refused(LAUNCH_EXIT.OK, 'Stopped before the server was ready.');
      const tail = sup.current?.tail.slice(-5) ?? [];
      for (const l of tail) childOut.write(`(last output) ${l}`);
      await childOut.close();
      throw new Refused(code === 0 ? LAUNCH_EXIT.CRASH : code, result?.message ?? (e as Error).message);
    }
    lastReady = ready;
    // A switch made before the banner needs no extra line: the banner itself says where players join.
    joinNoticePending = false;

    // 13. The banner and the browser. Players can join only when the child listens beyond loopback AND setup is done.
    const setupPending = typeof ready.setupPending === 'boolean' ? ready.setupPending : setupPendingNow;
    setupPendingNow = setupPending;
    const panelUrl = `http://localhost:${plan.admin}/`;
    const effectiveServe = serving(ready);
    cons.print(`\n${bannerLines({
      version: GAME_VERSION,
      panelUrl,
      gamePort: ready.port || plan.game,
      primary,
      notServing: effectiveServe ? null : serve.notServing ?? 'setup',
      https: false,
      certificate: null,
      dataDir: paths.data,
      setupCode: setupPending ? shownSetupCode : null,
      notes,
      env,
      platform,
    }).join('\n')}\n`);
    bannerShown = true;
    log.write(`ready: game port ${ready.port || plan.game} on ${ready.bind}, control panel ${plan.admin}${setupPending ? ', first-run setup pending' : ''}`);
    for (const n of notes) log.write(`note: ${n}`);

    let openedUrl: string | null = null;
    if (!flags.noBrowser && openBrowserSetting) {
      openedUrl = setupPending ? `${panelUrl}#setup=${formatSetupCode(shownSetupCode)}` : panelUrl;
      try { await openBrowser(openedUrl); } catch (e) { log.write(`could not open the browser: ${(e as Error)?.message ?? e}`); }
    }

    // 14. Supervise: the title every 5 s; the host ends when the supervisor does.
    const titleOf = (st: ChildStatus | null): string => windowTitle({
      state: stopRequested ? 'stopping' : titleState,
      online: typeof st?.online === 'number' ? st.online : null,
      rooms: typeof st?.rooms === 'number' ? st.rooms : null,
      primary: serving(lastReady) ? primary : null,
      gamePort: ready.port || plan.game,
      notServing: !serving(lastReady),
    });
    cons.title(titleOf(null));
    /** The title from the child's status; a status that says setup is done also opens the game to the LAN. */
    const pollTitle = (): void => {
      void sup.status(1500).then((st) => {
        noteSetup(st, "the server's status says so");
        cons.title(titleOf(st));
      }).catch(() => undefined);
    };
    refreshTitle = pollTitle;
    const titleTimer = setInterval(pollTitle, deps.titleIntervalMs ?? TITLE_INTERVAL_MS);
    titleTimer.unref?.();

    const finished = sup.finished.then(async (result) => {
      clearInterval(titleTimer);
      cons.title(windowTitle({ state: 'stopping', gamePort: ready.port || plan.game }));
      if (result.reason === 'gave-up' || result.reason === 'fatal') {
        cons.fatal(result.message ?? 'The server stopped after an error.');
        for (const l of sup.current?.tail.slice(-5) ?? []) childOut.write(`(last output) ${l}`);
      } else {
        cons.notice(result.reason === 'server-stopped' ? 'The server was stopped from the control panel. Bye!' : 'Voidswarm stopped. Bye!');
      }
      try { await maintRelay?.stop(); } catch { /* it is killed with the launcher anyway */ }
      await childOut.close();
      await cleanup();
      return result.reason === 'requested' || result.reason === 'server-stopped' ? LAUNCH_EXIT.OK : result.exitCode || LAUNCH_EXIT.CRASH;
    });

    const host: LanHost = {
      paths,
      ports: plan,
      panelUrl,
      openedUrl,
      setupCode,
      get currentSetupCode() { return shownSetupCode; },
      get setupPending() { return setupPendingNow; },
      preset,
      primary,
      get serveLan() { return serving(lastReady); },
      supervisor: sup,
      log,
      finished,
      stop(reason = 'launcher') {
        stopRequested = stopRequested ?? reason;
        titleState = 'stopping';
        cons.title(windowTitle({ state: 'stopping', gamePort: ready.port || plan.game }));
        void sup.stop(reason);
        return finished;
      },
    };
    ctx.stopHost = (reason) => { void host.stop(reason); };
    if (stopRequested) void host.stop(stopRequested);
    return { exitCode: null, host };
  } catch (e) {
    if (e instanceof Refused) {
      if (e.exitCode !== LAUNCH_EXIT.OK) cons.fatal(e.message);
      else cons.notice(e.message);
      if (supervisor) await supervisor.stop('launch aborted');
      await cleanup();
      return { exitCode: e.exitCode, host: null };
    }
    cons.fatal(`Voidswarm could not start: ${(e as Error)?.message ?? e}`);
    log?.write(`launcher error: ${(e as Error)?.stack ?? e}`);
    if (supervisor) await supervisor.stop('launcher error');
    await cleanup();
    return { exitCode: LAUNCH_EXIT.CRASH, host: null };
  }
}

function readBuildInfo(appDir: string): { buildDate: string | null } {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(appDir, 'build-info.json'), 'utf8')) as Record<string, unknown>;
    const d = j.buildDate ?? j.built ?? j.date;
    return { buildDate: typeof d === 'string' ? d.slice(0, 40) : null };
  } catch {
    return { buildDate: null };
  }
}

// ------------------------------------------------------------------------------------------
// The process
// ------------------------------------------------------------------------------------------

/** The signals that stop the host: Ctrl+C, kill, the window's close button (about 5 s of grace), Ctrl+Break. */
export const HOST_STOP_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];

/**
 * app\launch.mjs as a program: launch, then own the process until the host stops. A stop signal stops the child
 * over IPC (it flushes the chat log first), then the pipe is released; a second signal kills the child and exits 1.
 */
export async function main(argv: readonly string[] = process.argv.slice(2), deps: LaunchDeps = {}): Promise<void> {
  let host: LanHost | null = null;
  let starting: { stop(reason: string): void } | null = null;
  let signals = 0;
  const onSignal = (sig: NodeJS.Signals): void => {
    signals++;
    if (signals > 1) {
      host?.supervisor.kill();
      process.exitCode = LAUNCH_EXIT.CRASH;
      setTimeout(() => process.exit(LAUNCH_EXIT.CRASH), 200).unref?.();
      return;
    }
    // Still starting: the launch stops before (or right after) the child comes up.
    if (host) void host.stop(sig);
    else starting?.stop(sig);
  };
  if (deps.processHandlers !== false) {
    for (const s of HOST_STOP_SIGNALS) {
      try { process.on(s, () => onSignal(s)); } catch { /* not on this platform */ }
    }
    process.on('uncaughtException', (err) => {
      try { host?.log.write(`launcher FATAL: ${(err as Error)?.stack ?? err}`); } catch { /* the log itself failed */ }
      try { process.stdout.write(`\nVoidswarm's launcher failed: ${(err as Error)?.message ?? err}\n`); } catch { /* console gone */ }
      process.exitCode = LAUNCH_EXIT.CRASH;
      if (host) void host.stop('launcher error').finally(() => process.exit(LAUNCH_EXIT.CRASH));
      else process.exit(LAUNCH_EXIT.CRASH);
      setTimeout(() => process.exit(LAUNCH_EXIT.CRASH), 12_000).unref?.();
    });
  }
  const r = await launch(argv, { ...deps, onHandle: (h) => { starting = h; deps.onHandle?.(h); } });
  if (!r.host) {
    process.exitCode = r.exitCode ?? LAUNCH_EXIT.CRASH;
    return;
  }
  host = r.host;
  const code = await host.finished;
  process.exitCode = code;
  // Everything is closed; leave now rather than wait for stray handles.
  setTimeout(() => process.exit(code), 100).unref?.();
}

/** The launcher's own file names (app\launch.mjs; launch.ts / launch.js when run from source). */
const ENTRY_NAME_RE = /^launch\.(?:mjs|js|ts)$/i;

/**
 * True when this module is the program being run (app\launch.mjs), not an import (tests) and not another bundle
 * that merely includes it (app\tool.mjs: esbuild makes import.meta.url that bundle's file, so the file name must be
 * the launcher's too). Both paths are compared as real paths, so a root reached through a junction or symlink (a
 * moved C:\Users) still starts; Node's loader resolves the main module the same way.
 */
export function isEntry(url: string, argv1: string | undefined = process.argv[1], platform: Platform = process.platform): boolean {
  if (!argv1) return false;
  let self: string;
  try { self = fileURLToPath(url); } catch { return false; }
  if (!ENTRY_NAME_RE.test(path.basename(argv1)) || !ENTRY_NAME_RE.test(path.basename(self))) return false;
  const real = (p: string): string => {
    const abs = path.resolve(p);
    try { return fs.realpathSync.native(abs); } catch { return abs; }
  };
  const a = real(argv1);
  const b = real(self);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (isEntry(import.meta.url)) void main();
