// LAN edition: the install folder layout (spec §2.1), the location rules (§2.2 step 1) and the small
// process runner every launcher check shares (absolute System32 tools, no shell, fixed PowerShell
// scripts with values in env vars: P-M9).
//
// Everything that touches the OS is injectable, so the rules are testable on any platform.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export type Preset = 'home' | 'school';
export type Platform = NodeJS.Platform;
export type Env = Record<string, string | undefined>;

/** The top-level folder name inside the zip; it carries no version (§2.1). */
export const LAN_FOLDER_NAME = 'Voidswarm LAN';

/** The .cmd stubs at the root (§2.1). Their contract is frozen for 0.6.x. */
export const STUB_FILES = [
  'Start Voidswarm Host.cmd',
  'Update Voidswarm.cmd',
  'Reset admin password.cmd',
  'Restore a backup.cmd',
  'Allow through firewall (admin).cmd',
] as const;

export interface LanPaths {
  root: string;
  app: string;
  web: string;
  runtime: string;
  nodeExe: string;
  previous: string;
  stubs: string[];
  data: string;
  config: string;
  db: string;
  preflight: string;
  movedTo: string;
  deletions: string;
  secrets: string;
  pipeKey: string;
  tls: string;
  backups: string;
  exports: string;
  logs: string;
}

export function pathApi(platform: Platform = process.platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * The folder layout for a root (the folder that holds app\, runtime\ and the stubs).
 * `data` overrides the data folder (the advanced `--data <dir>` flag).
 */
export function lanPaths(root: string, opts: { data?: string; platform?: Platform } = {}): LanPaths {
  const p = pathApi(opts.platform);
  const r = p.resolve(root);
  const data = opts.data ? p.resolve(opts.data) : p.join(r, 'data');
  const runtime = p.join(r, 'runtime');
  return {
    root: r,
    app: p.join(r, 'app'),
    web: p.join(r, 'web'),
    runtime,
    nodeExe: p.join(runtime, (opts.platform ?? process.platform) === 'win32' ? 'node.exe' : 'node'),
    previous: p.join(r, 'previous'),
    stubs: STUB_FILES.map((s) => p.join(r, s)),
    data,
    config: p.join(data, 'voidswarm.config.json'),
    db: p.join(data, 'voidswarm.db'),
    preflight: p.join(data, 'preflight.json'),
    movedTo: p.join(data, 'MOVED-TO.json'),
    deletions: p.join(data, 'deletions.jsonl'),
    secrets: p.join(data, 'secrets'),
    pipeKey: p.join(data, 'secrets', 'pipe.key'),
    tls: p.join(data, 'tls'),
    backups: p.join(data, 'backups'),
    exports: p.join(data, 'exports'),
    logs: p.join(data, 'logs'),
  };
}

/** `…\Voidswarm LAN\app\launch.mjs` → `…\Voidswarm LAN`. */
export function rootFromLauncher(launcherFile: string, platform: Platform = process.platform): string {
  const p = pathApi(platform);
  return p.dirname(p.dirname(p.resolve(launcherFile)));
}

/** Case-insensitive env lookup (a copied Windows env object loses process.env's case folding). */
export function envGet(env: Env, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct || undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(env)) if (k.toLowerCase() === lower) return env[k] || undefined;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Running system tools
// ---------------------------------------------------------------------------------------------

export interface ExecResult {
  /** Exit code; null when the process could not start or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Spawn or timeout error code (ENOENT, EACCES, ETIMEDOUT, …) when the tool didn't run to completion. */
  error?: string;
}

export interface ExecOptions {
  env?: Env;
  timeoutMs?: number;
  cwd?: string;
}

/** Runs one program with arguments (never through a shell). */
export type ExecFn = (file: string, args: readonly string[], opts?: ExecOptions) => Promise<ExecResult>;

export const execTool: ExecFn = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      args as string[],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: opts.timeoutMs ?? 20_000,
        maxBuffer: 32 * 1024 * 1024,
        env: opts.env as NodeJS.ProcessEnv | undefined,
        cwd: opts.cwd,
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean };
        if (typeof e.code === 'number') return resolve({ code: e.code, stdout: stdout ?? '', stderr: stderr ?? '' });
        resolve({ code: null, stdout: stdout ?? '', stderr: stderr ?? '', error: e.killed ? 'ETIMEDOUT' : String(e.code ?? e.message) });
      },
    );
  });

export type SystemTool = 'icacls' | 'whoami' | 'netsh' | 'powercfg' | 'netstat' | 'tasklist' | 'powershell';

/**
 * The absolute path of a Windows system tool. Never a bare name: Windows searches the current
 * directory before PATH, so a planted `icacls.exe` next to the cwd would otherwise run.
 */
export function systemTool(name: SystemTool, env: Env = process.env): string {
  const sysRoot = envGet(env, 'SystemRoot') ?? envGet(env, 'windir') ?? 'C:\\Windows';
  const sys32 = path.win32.join(sysRoot, 'System32');
  if (name === 'powershell') return path.win32.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return path.win32.join(sys32, `${name}.exe`);
}

/**
 * Runs a fixed PowerShell script. Values go in `vars` (as `VS_*` environment variables), never into
 * the script text, and the script must not contain double quotes (they don't survive the Windows
 * command line reliably). No -EncodedCommand and no -ExecutionPolicy Bypass: both are classic
 * EDR / antivirus signals, and neither is needed (execution policy doesn't apply to -Command text,
 * so the fixed scripts also run under the Windows client default, Restricted).
 */
export async function runPowerShell(
  script: string,
  vars: Record<string, string> = {},
  opts: { exec?: ExecFn; env?: Env; timeoutMs?: number } = {},
): Promise<ExecResult> {
  if (script.includes('"')) throw new Error('runPowerShell: scripts must not contain double quotes');
  for (const k of Object.keys(vars)) if (!/^VS_[A-Z0-9_]+$/.test(k)) throw new Error(`runPowerShell: bad variable name ${k}`);
  // Windows PowerShell 5.1 must not inherit PowerShell 7's PSModulePath (a launch from a pwsh 7 window or a CI step):
  // it would load PS7's incompatible modules and Get-AuthenticodeSignature and friends fail silently.
  const env: Record<string, string | undefined> = { ...(opts.env ?? process.env), ...vars };
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'psmodulepath') delete env[k];
  return (opts.exec ?? execTool)(
    systemTool('powershell', env),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { env, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
}

// ---------------------------------------------------------------------------------------------
// Location rules (§2.2 step 1)
// ---------------------------------------------------------------------------------------------

export type LocationCode =
  | 'cloud'          // OneDrive, Dropbox, Google Drive, iCloud Drive
  | 'unc'            // \\server\share
  | 'network-drive'  // a mapped or redirected drive letter
  | 'zip-view'       // running inside a zip that Explorer (or 7-Zip, WinRAR) opened in %TEMP%
  | 'temp'
  | 'downloads'
  | 'program-files'
  | 'system-folder'
  | 'read-only'
  | 'fat'            // FAT, FAT32 or exFAT: no file permissions
  | 'removable';

export interface LocationProblem {
  code: LocationCode;
  /** Which checked folder it is about. */
  which: 'root' | 'data';
  path: string;
  /** One plain sentence for the console and the panel. */
  detail: string;
}

/** Places that aren't refused but often start syncing to OneDrive later (§1 table). */
export interface LocationWarning {
  code: 'desktop' | 'documents';
  which: 'root' | 'data';
  path: string;
  detail: string;
}

export interface LocationReport {
  ok: boolean;
  problems: LocationProblem[];
  warnings: LocationWarning[];
  /** The folder to move to, expanded (C:\Users\<you>\Voidswarm LAN). */
  suggestion: string;
  /** The refusal text (null when ok). Always names %USERPROFILE%\Voidswarm LAN on Windows. */
  message: string | null;
}

export interface VolumeInfo {
  /** NTFS, ReFS, FAT32, exFAT, … as Get-Volume reports it ('' when unknown). */
  fileSystem: string;
  /** Fixed, Removable, CD-ROM, Remote, RAM Disk, Unknown … */
  driveType: string;
}

export interface LocationProbe {
  platform: Platform;
  env: Env;
  homedir: string;
  /** Resolves junctions, subst and mapped drives (fs.realpathSync.native); null if it doesn't exist. */
  realpath(p: string): string | null;
  /** Volume facts for a drive letter ('C'); null when unknown (Get-Volume, cached: see preflight.ts). */
  volume(drive: string): Promise<VolumeInfo | null> | VolumeInfo | null;
  /** True when a file can be created in this existing directory. */
  writable(dir: string): boolean;
  exists(p: string): boolean;
  readText(p: string): string | null;
  /** The Downloads known folder when it is redirected somewhere else (optional). */
  downloadsDir?: string | null;
}

function defaultRealpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** Creates and removes a probe file (the only write the location check makes). */
export function canWriteDir(dir: string): boolean {
  const probe = path.join(dir, `.vs-write-test-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    fs.writeFileSync(probe, '', { flag: 'wx' });
  } catch {
    return false;
  }
  try {
    fs.unlinkSync(probe);
  } catch {
    /* ignore */
  }
  return true;
}

export function defaultLocationProbe(): LocationProbe {
  return {
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    realpath: defaultRealpath,
    volume: () => null,
    writable: canWriteDir,
    exists: (p) => fs.existsSync(p),
    readText: (p) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/** Normalizes a Windows path for comparison: strips \\?\ and \\.\ prefixes, resolves, lowercases. */
export function normWin(p: string): string {
  let s = p.replace(/\//g, '\\');
  if (/^\\\\\?\\UNC\\/i.test(s)) s = '\\\\' + s.slice(8);
  else if (/^\\\\[?.]\\[a-z]:/i.test(s)) s = s.slice(4);
  s = path.win32.resolve(s);
  if (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1);
  return s.toLowerCase();
}

/** True when `child` is `parent` or inside it. */
export function isUnder(child: string, parent: string | undefined | null, platform: Platform = process.platform): boolean {
  if (!parent) return false;
  if (platform === 'win32') {
    const c = normWin(child);
    const p = normWin(parent);
    if (c === p) return true;
    return c.startsWith(p.endsWith('\\') ? p : p + '\\');
  }
  const c = path.posix.resolve(child);
  const p = path.posix.resolve(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : p + '/');
}

/** `\\server\share\a\b` → `\\server\share`. */
export function uncShare(p: string): string {
  let s = p.replace(/\//g, '\\');
  if (/^\\\\\?\\UNC\\/i.test(s)) s = '\\\\' + s.slice(8);
  return s.split('\\').slice(0, 4).join('\\');
}

export function isUncPath(p: string): boolean {
  const s = p.replace(/\//g, '\\');
  if (/^\\\\\?\\UNC\\/i.test(s)) return true;
  if (/^\\\\[?.]\\[a-z]:/i.test(s)) return false;
  return s.startsWith('\\\\');
}

/** The suggested install folder: %USERPROFILE%\Voidswarm LAN (expanded). */
export function suggestedRoot(probe: Pick<LocationProbe, 'platform' | 'env' | 'homedir'>): string {
  const p = pathApi(probe.platform);
  const home = (probe.platform === 'win32' ? envGet(probe.env, 'USERPROFILE') : envGet(probe.env, 'HOME')) ?? probe.homedir;
  return p.join(home, LAN_FOLDER_NAME);
}

const CLOUD_SEGMENTS: [RegExp, string][] = [
  [/^OneDrive( - .+)?$/i, 'OneDrive'],
  [/^Dropbox( \(.+\))?$/i, 'Dropbox'],
  [/^(Google ?Drive|My Drive)$/i, 'Google Drive'],
  [/^iCloud ?Drive$/i, 'iCloud Drive'],
];

function segments(p: string, platform: Platform): string[] {
  return (platform === 'win32' ? p.replace(/\//g, '\\').split('\\') : p.split('/')).filter(Boolean);
}

function cloudProvider(p: string, probe: LocationProbe): string | null {
  const { platform, env } = probe;
  if (platform === 'win32') {
    for (const name of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
      if (isUnder(p, envGet(env, name), platform)) return 'OneDrive';
    }
    // Dropbox records its folders in info.json.
    for (const base of [envGet(env, 'LOCALAPPDATA'), envGet(env, 'APPDATA')]) {
      if (!base) continue;
      const text = probe.readText(path.win32.join(base, 'Dropbox', 'info.json'));
      if (!text) continue;
      try {
        const info = JSON.parse(text) as Record<string, { path?: unknown }>;
        for (const v of Object.values(info)) {
          if (v && typeof v.path === 'string' && isUnder(p, v.path, platform)) return 'Dropbox';
        }
      } catch {
        /* ignore a broken info.json */
      }
    }
  } else {
    const s = path.posix.resolve(p);
    const m = /\/Library\/CloudStorage\/([^/]+)/.exec(s);
    if (m) return m[1].split('-')[0] || 'a cloud drive';
    if (s.includes('/Library/Mobile Documents/')) return 'iCloud Drive';
  }
  for (const seg of segments(p, platform)) {
    for (const [re, name] of CLOUD_SEGMENTS) if (re.test(seg)) return name;
  }
  return null;
}

function tempDirs(probe: LocationProbe): string[] {
  const { platform, env } = probe;
  if (platform === 'win32') {
    const out = [envGet(env, 'TEMP'), envGet(env, 'TMP')];
    const local = envGet(env, 'LOCALAPPDATA');
    if (local) out.push(path.win32.join(local, 'Temp'));
    const sysRoot = envGet(env, 'SystemRoot') ?? envGet(env, 'windir');
    if (sysRoot) out.push(path.win32.join(sysRoot, 'Temp'));
    return out.filter((x): x is string => !!x);
  }
  return [envGet(env, 'TMPDIR'), '/tmp', '/var/tmp'].filter((x): x is string => !!x);
}

const ZIP_VIEW_SEGMENTS = [/^Temp\d+_/i, /^7zO[0-9A-F]+$/i, /^Rar\$/i, /\.zip$/i];

/** The rules that need no volume facts (pure given the probe). */
export function pathRules(p: string, which: 'root' | 'data', probe: LocationProbe): LocationProblem[] {
  const { platform, env } = probe;
  const out: LocationProblem[] = [];
  const add = (code: LocationCode, detail: string) => out.push({ code, which, path: p, detail });

  if (platform === 'win32' && isUncPath(p)) add('unc', `It is on a network share (${uncShare(p)}).`);

  const cloud = cloudProvider(p, probe);
  if (cloud) add('cloud', `It is inside ${cloud}, which syncs and locks files while the game writes its database.`);

  const temps = tempDirs(probe);
  const inTemp = temps.some((t) => isUnder(p, t, platform));
  if (inTemp) {
    const tempRoot = temps.find((t) => isUnder(p, t, platform))!;
    const rel = pathApi(platform).relative(tempRoot, p);
    const zipView = segments(rel, platform).some((seg) => ZIP_VIEW_SEGMENTS.some((re) => re.test(seg)));
    if (zipView) add('zip-view', 'It is running from inside the zip (Windows opened a temporary copy). Extract the zip first: right-click it → Extract All.');
    else add('temp', 'It is in a temporary folder, which Windows and clean-up tools empty.');
  }

  const home = platform === 'win32' ? envGet(env, 'USERPROFILE') ?? probe.homedir : envGet(env, 'HOME') ?? probe.homedir;
  const downloads = [home ? pathApi(platform).join(home, 'Downloads') : null, probe.downloadsDir ?? null];
  if (downloads.some((d) => d && isUnder(p, d, platform))) {
    add('downloads', 'It is in Downloads, which antivirus watches closely and Storage Sense can empty.');
  }

  if (platform === 'win32') {
    const pf = [envGet(env, 'ProgramFiles'), envGet(env, 'ProgramFiles(x86)'), envGet(env, 'ProgramW6432'), 'C:\\Program Files', 'C:\\Program Files (x86)'];
    if (pf.some((d) => d && isUnder(p, d, platform))) add('program-files', 'It is under Program Files, where only administrators can write.');
    const sysRoot = envGet(env, 'SystemRoot') ?? envGet(env, 'windir') ?? 'C:\\Windows';
    if (!inTemp && isUnder(p, sysRoot, platform)) add('system-folder', 'It is inside the Windows folder.');
  }
  return out;
}

function driveLetter(p: string): string | null {
  const m = /^([a-z]):/i.exec(p.replace(/^\\\\[?.]\\/, ''));
  return m ? m[1].toUpperCase() : null;
}

function volumeProblems(v: VolumeInfo, drive: string, which: 'root' | 'data', p: string): LocationProblem[] {
  const out: LocationProblem[] = [];
  const fsName = v.fileSystem.trim();
  const type = v.driveType.trim().toLowerCase();
  if (/^(fat|fat12|fat16|fat32|exfat)$/i.test(fsName)) {
    out.push({ code: 'fat', which, path: p, detail: `Drive ${drive}: uses ${fsName}, which has no file permissions.` });
  }
  if (type.includes('removable') || type.includes('cd')) {
    out.push({ code: 'removable', which, path: p, detail: `Drive ${drive}: is a removable drive (a USB stick or card).` });
  } else if (type.includes('remote') || type.includes('network')) {
    out.push({ code: 'network-drive', which, path: p, detail: `Drive ${drive}: is a network drive.` });
  }
  return out;
}

function desktopWarnings(p: string, which: 'root' | 'data', probe: LocationProbe): LocationWarning[] {
  const home = probe.platform === 'win32' ? envGet(probe.env, 'USERPROFILE') ?? probe.homedir : envGet(probe.env, 'HOME') ?? probe.homedir;
  if (!home) return [];
  const j = pathApi(probe.platform).join;
  if (isUnder(p, j(home, 'Desktop'), probe.platform)) {
    return [{ code: 'desktop', which, path: p, detail: 'The Desktop often starts syncing to OneDrive later; your user folder is safer.' }];
  }
  if (isUnder(p, j(home, 'Documents'), probe.platform)) {
    return [{ code: 'documents', which, path: p, detail: 'Documents often starts syncing to OneDrive later; your user folder is safer.' }];
  }
  return [];
}

function nearestExisting(p: string, probe: LocationProbe): string | null {
  const api = pathApi(probe.platform);
  let cur = p;
  for (let i = 0; i < 64; i++) {
    if (probe.exists(cur)) return cur;
    const up = api.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

/**
 * The install-location check. It refuses (both presets) when the root or the data folder is in a
 * synced, shared, temporary, removable or permission-less place, and says where to move it.
 */
export async function checkLocation(root: string, dataDir: string, probeIn: Partial<LocationProbe> = {}): Promise<LocationReport> {
  const probe: LocationProbe = { ...defaultLocationProbe(), ...probeIn };
  const api = pathApi(probe.platform);
  const rootAbs = api.resolve(root);
  const dataAbs = api.resolve(dataDir);
  const dataInside = isUnder(dataAbs, rootAbs, probe.platform);
  const problems: LocationProblem[] = [];
  const warnings: LocationWarning[] = [];
  const seen = new Set<string>();
  const push = (list: LocationProblem[]) => {
    for (const x of list) {
      // The data folder inside the root repeats the root's problems: keep only the root's copy.
      const key = dataInside ? x.code : `${x.which}:${x.code}`;
      if (!seen.has(key)) {
        seen.add(key);
        problems.push(x);
      }
    }
  };
  const volumes = new Map<string, VolumeInfo | null>();
  const volumeOf = async (drive: string): Promise<VolumeInfo | null> => {
    if (!volumes.has(drive)) {
      let v: VolumeInfo | null = null;
      try {
        v = await probe.volume(drive);
      } catch {
        v = null;
      }
      volumes.set(drive, v);
    }
    return volumes.get(drive) ?? null;
  };

  for (const [p, which] of [[rootAbs, 'root'], [dataAbs, 'data']] as const) {
    push(pathRules(p, which, probe));
    const existing = nearestExisting(p, probe);
    const real = existing ? probe.realpath(existing) : null;
    if (real && existing && real.toLowerCase() !== existing.toLowerCase()) {
      if (probe.platform === 'win32' && isUncPath(real) && !isUncPath(p)) {
        const drive = driveLetter(p) ?? '?';
        const share = uncShare(real);
        push([{ code: 'network-drive', which, path: p, detail: `Drive ${drive}: is a mapped network drive (${share}).` }]);
      } else {
        // subst drives and junctions: judge where the files really are.
        push(pathRules(real, which, probe).filter((x) => x.code !== 'unc').map((x) => ({ ...x, path: p })));
      }
    }
    if (probe.platform === 'win32' && !isUncPath(p)) {
      const drive = driveLetter(real && !isUncPath(real) ? real : p);
      const v = drive ? await volumeOf(drive) : null;
      if (v && drive) push(volumeProblems(v, drive, which, p));
    }
    if (existing && !probe.writable(existing)) {
      push([{ code: 'read-only', which, path: p, detail: 'The folder is read-only for your account.' }]);
    }
    warnings.push(...desktopWarnings(p, which, probe));
  }

  const suggestion = suggestedRoot(probe);
  return {
    ok: problems.length === 0,
    problems,
    warnings: dedupeWarnings(warnings),
    suggestion,
    message: problems.length ? locationMessage(problems, suggestion, probe.platform) : null,
  };
}

function dedupeWarnings(ws: LocationWarning[]): LocationWarning[] {
  const seen = new Set<string>();
  return ws.filter((w) => (seen.has(w.code) ? false : (seen.add(w.code), true)));
}

/** The refusal text. Windows always names %USERPROFILE%\Voidswarm LAN (T-LAN-3). */
export function locationMessage(problems: LocationProblem[], suggestion: string, platform: Platform = process.platform): string {
  const where = platform === 'win32' ? `%USERPROFILE%\\${LAN_FOLDER_NAME}` : `~/${LAN_FOLDER_NAME}`;
  const lines = [
    "Voidswarm can't run from this folder:",
    ...problems.map((x) => `  - ${x.which === 'data' ? 'Data folder: ' : ''}${x.detail}`),
    `Move the whole "${LAN_FOLDER_NAME}" folder to ${where} (${suggestion}) and start it from there.`,
  ];
  if (platform === 'win32') lines.push('Tip: in the Extract box, type %USERPROFILE% and press Extract.');
  return lines.join('\n');
}
