// OWNER: PACKAGING (LAN task B11). app\tool.mjs: the LAN edition's maintenance program (docs/LAN-EDITION-proposal.md
// §2.1, §2.5, §4.10, §6.2, §11.2). The .cmd stubs run it with a subcommand; it reads the console normally (the tool
// stubs don't use `call <nul`, §2.5), so it may ask questions.
//
//   tool update [--zip <file>] [--rollback] [--yes]      Update Voidswarm.cmd (update.ts)
//   tool restore [--backup <f>] [--recovery <f>] …       Restore a backup.cmd (restore.ts)
//   tool admin-reset [--yes]                             Reset admin password.cmd (§4.10)
//   tool admin-set <username> [--password-stdin]         create / replace the host admin login (VPS parity, §4.10)
//   tool backup                                          an encrypted backup now (works while the host runs)
//   tool fix-permissions                                 the §2.2 step 3 fix (only you, SYSTEM, Administrators)
//   tool <moderation command> …                          the moderation CLI on this copy's data (cliCore.ts)
// Every command takes --data <folder> (advanced), like the launcher. Exit codes: 0 done, 1 refused / failed, 4 usage.
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackup, pepperIdOf, sizeText, type StatfsFn } from '../server/maint';
import { CLI_USAGE, runCli } from '../server/moderation/cliCore';
import { hostAdminState, openAdminDb, resetHostAdmin, setHostAdminCredential, SETUP_CODE_TTL_MS } from '../server/moderation/hostAdmin';
import { openFileSecrets } from '../server/secrets';
import { configPath, readConfigFile } from '../server/settings';
import { GAME_VERSION } from '../shared/version';
import { fixPermissions, type AclOptions, type FixResult } from './acl';
import { formatSetupCode } from './banner';
import { readToken } from './elevation';
import { lanPaths, pathApi, type LanPaths, type Platform, type Preset } from './paths';
import { sendCommand, type PipeReply, type SendOptions } from './pipe';
import { consoleIo, runRestoreTool, type ToolIo } from './restore';
import { installedVersion, RECOVER_TOOL, runUpdateTool, toolRoot, type UpdateToolDeps } from './update';

export const TOOL_EXIT = { OK: 0, FAILED: 1, USAGE: 4 } as const;

export const TOOL_USAGE = [
  `Voidswarm LAN ${GAME_VERSION} maintenance tool (app\\tool.mjs). The .cmd files in the folder run it for you.`,
  '',
  '  update [--zip <file>] [--rollback] [--yes]   install an update zip, or go back (Update Voidswarm.cmd)',
  '  restore [--backup <file>] [--recovery <file>] [--settings] [--yes]   restore a backup (Restore a backup.cmd)',
  '  admin-reset [--yes]                           clear the host admin password; prints a new setup code (Reset admin password.cmd)',
  '  admin-set <username> [--password-stdin]       create or replace the host admin login',
  '  backup                                        make an encrypted backup now',
  '  fix-permissions                               give only you, SYSTEM and Administrators access to this folder',
  '  <moderation command>                          the moderation commands below, on this copy\'s data',
  '  --data <folder>                               (advanced) the data folder, for any command',
  '',
  CLI_USAGE.replace(/npm run mod -- /g, 'tool ').replace(/\(DB: \$DB_PATH, default data\/voidswarm\.db\)/, '(this copy\'s data\\voidswarm.db)'),
].join('\n');

export interface ToolDeps {
  io?: ToolIo;
  /** the install root (default: from this program's file, app\tool.mjs) */
  root?: string;
  toolFile?: string;
  cwd?: string;
  platform?: Platform;
  env?: NodeJS.ProcessEnv;
  /** the pipe path (tests) */
  pipe?: string;
  now?: () => number;
  statfs?: StatfsFn;
  /** stdin for --password-stdin (default process.stdin) */
  stdin?: NodeJS.ReadableStream;
  /** the pipe (tests) */
  send?: (o: SendOptions) => Promise<PipeReply>;
  /** fix-permissions (tests) */
  fixPermissions?: (o: AclOptions) => Promise<FixResult>;
  userSid?: () => Promise<string | null>;
  /** passed through to update.ts (the signature check, the extractor: tests) */
  update?: Partial<UpdateToolDeps>;
}

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

/** Splits off --data <folder> (every command takes it). */
export function takeDataFlag(argv: readonly string[], cwd = process.cwd()): { data: string | null; rest: string[] } | { error: string } {
  const rest: string[] = [];
  let data: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--data' || a.startsWith('--data=')) {
      const v = a === '--data' ? argv[++i] : a.slice('--data='.length);
      if (!v || v.startsWith('--')) return { error: '--data needs a folder.' };
      data = path.resolve(cwd, v);
    } else rest.push(a);
  }
  return { data, rest };
}

function rootOf(deps: ToolDeps): string {
  return path.resolve(deps.root ?? toolRoot(toolFileOf(deps), deps.platform));
}

const toolFileOf = (deps: ToolDeps): string => deps.toolFile ?? process.argv[1] ?? fileURLToPath(import.meta.url);

/** Is this program the root's update.recover.mjs (the copy the Update stub runs while app\ is out)? */
const isRecoveryCopy = (deps: ToolDeps): boolean => pathApi(deps.platform).basename(toolFileOf(deps)).toLowerCase() === RECOVER_TOOL;

function readSettingsRaw(dataDir: string): Record<string, unknown> | null {
  try {
    const raw = readConfigFile(configPath(dataDir)).raw;
    return raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function configured(dataDir: string): { preset: Preset; serverName: string; adminPort: number | null; sizeCapMB: number | null; installId: string } {
  const raw = readSettingsRaw(dataDir) as { preset?: unknown; serverName?: unknown; installId?: unknown; network?: { adminPort?: unknown }; backups?: { sizeCapMB?: unknown } } | null;
  const port = Number(raw?.network?.adminPort);
  return {
    preset: raw?.preset === 'school' ? 'school' : 'home',
    serverName: typeof raw?.serverName === 'string' ? raw.serverName : '',
    adminPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
    sizeCapMB: typeof raw?.backups?.sizeCapMB === 'number' ? raw.backups.sizeCapMB : null,
    installId: typeof raw?.installId === 'string' ? raw.installId.slice(0, 64) : '',
  };
}

function readSecret(paths: LanPaths, name: 'pepper.key' | 'backup.key' | 'pipe.key', platform?: Platform): Buffer | null {
  try {
    const s = openFileSecrets(paths.data, { platform });
    return s.has(name) ? s.read(name) : null;
  } catch {
    return null;
  }
}

/** Tells a running host that the admin credential changed on disk (`reload-admin`); returns what to say about it. */
async function tellHost(paths: LanPaths, deps: ToolDeps): Promise<{ running: boolean; panelUrl: string | null; note: string | null }> {
  const send = deps.send ?? sendCommand;
  const key = readSecret(paths, 'pipe.key', deps.platform);
  const r = await send({ dataDir: paths.data, key: key && key.length >= 16 ? key : null, cmd: 'reload-admin', platform: deps.platform, pipe: deps.pipe });
  if (!r.ok && r.error === 'not-running') return { running: false, panelUrl: null, note: null };
  if (!r.ok) return { running: true, panelUrl: null, note: 'The running host did not take the change: stop it and start it again (Start Voidswarm Host.cmd).' };
  const p = await send({ dataDir: paths.data, key: null, cmd: 'panel', platform: deps.platform, pipe: deps.pipe });
  const url = p.ok && typeof p.body.panelUrl === 'string' && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+\/?$/.test(p.body.panelUrl) ? p.body.panelUrl : null;
  return { running: true, panelUrl: url, note: null };
}

// ------------------------------------------------------------------------------------------
// admin-reset (Reset admin password.cmd, §4.10)
// ------------------------------------------------------------------------------------------

export async function runAdminReset(argv: readonly string[], deps: ToolDeps = {}): Promise<number> {
  const io = deps.io ?? consoleIo();
  try {
    const d = takeDataFlag(argv, deps.cwd);
    if ('error' in d) { io.write(d.error); return TOOL_EXIT.USAGE; }
    let assumeYes = false;
    for (const a of d.rest) {
      if (a === '--yes' || a === '-y') assumeYes = true;
      else { io.write(`Unknown option: ${a.slice(0, 60)}`); io.write('Usage: Reset admin password.cmd [--yes]'); return TOOL_EXIT.USAGE; }
    }
    const paths = lanPaths(rootOf(deps), { data: d.data ?? undefined, platform: deps.platform });
    if (!fs.existsSync(paths.db)) {
      io.write('This copy of Voidswarm has not been set up yet: start it (Start Voidswarm Host.cmd) and create the host admin login in the browser.');
      return TOOL_EXIT.FAILED;
    }
    let who: string | null = null;
    let pending = false;
    try {
      const db = openAdminDb(paths.db, 5000);
      try { const st = hostAdminState(db); who = st.username; pending = st.setupPending && st.setupKind === 'first'; } finally { db.close(); }
    } catch (e) {
      io.write(`The data could not be opened: ${errMsg(e)}. Start the host once (it updates the data), then try again.`);
      return TOOL_EXIT.FAILED;
    }
    if (pending) io.write('No host admin login has been created yet. A new setup code is made anyway (the launcher also shows one each time it starts).');
    else {
      io.write(`This clears the host admin password${who ? ` of "${who}"` : ''} and signs every admin out. You then set a new one in the control panel with a setup code.`);
      if (!assumeYes) {
        const a = await io.ask('Reset it? [y/N]: ');
        if (!a || !/^y(es)?$/i.test(a.trim())) { io.write('Cancelled: nothing was changed.'); return TOOL_EXIT.FAILED; }
      }
    }
    const pepper = readSecret(paths, 'pepper.key', deps.platform);
    const db = openAdminDb(paths.db, 5000);
    let result;
    try {
      result = resetHostAdmin(db, { pepper, now: (deps.now ?? Date.now)(), actor: 'cli' });
    } finally {
      db.close();
    }
    const host = await tellHost(paths, deps);
    const code = formatSetupCode(result.setupCode);
    const port = configured(paths.data).adminPort;
    const url = host.panelUrl ?? (port ? `http://localhost:${port}/` : null);
    io.write('');
    io.write(`  New setup code: ${code}   (valid for ${Math.round(SETUP_CODE_TTL_MS / 60_000)} minutes, on this PC only)`);
    io.write('');
    if (result.sessionsRevoked) io.write(`${result.sessionsRevoked} admin session(s) were signed out.`);
    if (host.note) io.write(host.note);
    if (host.running) io.write(`Open the Host Control Panel${url ? ` (${url})` : ''} on this PC and type the setup code to choose a new password.`);
    else io.write(`Start Voidswarm Host.cmd, then type the setup code in the Host Control Panel${url ? ` (${url})` : ''} to choose a new password.`);
    io.write('Players can keep playing meanwhile.');
    return TOOL_EXIT.OK;
  } catch (e) {
    io.write(`The reset failed: ${errMsg(e)}`);
    return TOOL_EXIT.FAILED;
  } finally {
    io.close?.();
  }
}

// ------------------------------------------------------------------------------------------
// admin-set <username> (VPS parity, §4.10)
// ------------------------------------------------------------------------------------------

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let s = '';
  for await (const chunk of stream) {
    s += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
    if (s.length > 4096) break;
  }
  return s;
}

export async function runAdminSet(argv: readonly string[], deps: ToolDeps = {}): Promise<number> {
  const stdinMode = argv.includes('--password-stdin');
  // With --password-stdin the password is the input: nothing else may read it (no console prompt interface).
  const io = deps.io ?? (stdinMode ? { write: (l: string) => { process.stdout.write(`${l}\n`); }, ask: async () => null } : consoleIo());
  try {
    const d = takeDataFlag(argv, deps.cwd);
    if ('error' in d) { io.write(d.error); return TOOL_EXIT.USAGE; }
    const pos = d.rest.filter((a) => a !== '--password-stdin');
    const username = pos[0];
    if (!username || pos.length !== 1 || username.startsWith('-')) { io.write('Usage: tool admin-set <username> [--password-stdin]'); return TOOL_EXIT.USAGE; }
    const paths = lanPaths(rootOf(deps), { data: d.data ?? undefined, platform: deps.platform });
    if (!fs.existsSync(paths.db)) { io.write('There is no data yet: start the host once first (it creates the database).'); return TOOL_EXIT.FAILED; }
    let password: string | null;
    if (stdinMode) {
      password = (await readAll(deps.stdin ?? process.stdin)).replace(/\r?\n$/, '');
    } else {
      password = await io.ask(`New password for ${username}: `, { secret: true });
      const again = password === null ? null : await io.ask('Type it again: ', { secret: true });
      if (password !== again) { io.write(password === null ? 'Cancelled: nothing was changed.' : 'The two passwords differ: nothing was changed.'); return TOOL_EXIT.FAILED; }
    }
    if (!password) { io.write('No password given: nothing was changed.'); return TOOL_EXIT.FAILED; }
    const db = openAdminDb(paths.db, 5000);
    let r;
    try {
      r = await setHostAdminCredential(db, { username, password, serverName: configured(paths.data).serverName, now: (deps.now ?? Date.now)(), actor: 'cli' });
    } catch (e) {
      io.write(errMsg(e));
      return TOOL_EXIT.FAILED;
    } finally {
      db.close();
    }
    const host = await tellHost(paths, deps);
    io.write(`${r.created ? 'Created' : 'Replaced'} the host admin login "${username}".${r.sessionsRevoked ? ` ${r.sessionsRevoked} admin session(s) were signed out.` : ''}`);
    if (host.note) io.write(host.note);
    return TOOL_EXIT.OK;
  } catch (e) {
    io.write(`admin-set failed: ${errMsg(e)}`);
    return TOOL_EXIT.FAILED;
  } finally {
    io.close?.();
  }
}

// ------------------------------------------------------------------------------------------
// backup, fix-permissions
// ------------------------------------------------------------------------------------------

export async function runBackupTool(argv: readonly string[], deps: ToolDeps = {}): Promise<number> {
  const io = deps.io ?? consoleIo();
  try {
    const d = takeDataFlag(argv, deps.cwd);
    if ('error' in d) { io.write(d.error); return TOOL_EXIT.USAGE; }
    if (d.rest.length) { io.write(`Unknown option: ${d.rest[0]!.slice(0, 60)}`); io.write('Usage: tool backup [--data <folder>]'); return TOOL_EXIT.USAGE; }
    const paths = lanPaths(rootOf(deps), { data: d.data ?? undefined, platform: deps.platform });
    if (!fs.existsSync(paths.db)) { io.write('There is no data to back up yet.'); return TOOL_EXIT.FAILED; }
    const key = readSecret(paths, 'backup.key', deps.platform);
    if (!key) { io.write('data\\secrets\\backup.key is missing or damaged: start the host once, or restore it from the recovery file.'); return TOOL_EXIT.FAILED; }
    const pepper = readSecret(paths, 'pepper.key', deps.platform);
    const s = configured(paths.data);
    const r = await createBackup({
      dataDir: paths.data, dbPath: paths.db, key, reason: 'manual', now: (deps.now ?? Date.now)(), appVersion: installedVersion(paths),
      installId: s.installId, sizeCapMB: s.sizeCapMB, pepperId: pepper ? pepperIdOf(pepper) : null, statfs: deps.statfs,
    });
    if (!r.ok) { io.write(`No backup was made: ${'skipped' in r ? r.text : r.error}`); return TOOL_EXIT.FAILED; }
    io.write(`Backed up to data\\backups\\${r.name} (${sizeText(r.size)}).`);
    return TOOL_EXIT.OK;
  } catch (e) {
    io.write(`The backup failed: ${errMsg(e)}`);
    return TOOL_EXIT.FAILED;
  } finally {
    io.close?.();
  }
}

export async function runFixPermissionsTool(argv: readonly string[], deps: ToolDeps = {}): Promise<number> {
  const io = deps.io ?? consoleIo();
  try {
    const d = takeDataFlag(argv, deps.cwd);
    if ('error' in d) { io.write(d.error); return TOOL_EXIT.USAGE; }
    if (d.rest.length) { io.write(`Unknown option: ${d.rest[0]!.slice(0, 60)}`); return TOOL_EXIT.USAGE; }
    const paths = lanPaths(rootOf(deps), { data: d.data ?? undefined, platform: deps.platform });
    const sid = await (deps.userSid ?? (async () => (await readToken({ platform: deps.platform })).userSid))();
    if (!sid) { io.write('Your Windows account could not be read (whoami did not answer): nothing was changed.'); return TOOL_EXIT.FAILED; }
    io.write('Giving only you, SYSTEM and Administrators access to this folder…');
    const fix = await (deps.fixPermissions ?? fixPermissions)({ root: paths.root, dataDir: paths.data, userSid: sid, preset: configured(paths.data).preset, platform: deps.platform, checkOwners: true });
    for (const e of fix.errors) io.write(`  - ${e}`);
    if (fix.report.ok) { io.write('The permissions are fixed.'); return TOOL_EXIT.OK; }
    io.write(fix.report.message ?? 'Some permissions could not be fixed.');
    return TOOL_EXIT.FAILED;
  } catch (e) {
    io.write(`The fix failed: ${errMsg(e)}`);
    return TOOL_EXIT.FAILED;
  } finally {
    io.close?.();
  }
}

// ------------------------------------------------------------------------------------------
// The dispatcher
// ------------------------------------------------------------------------------------------

/** app\tool.mjs <command> …: returns the exit code. */
export async function runTool(argv: readonly string[], deps: ToolDeps = {}): Promise<number> {
  const [cmdRaw, ...rest] = argv;
  const cmd = (cmdRaw ?? '').toLowerCase();
  if (isRecoveryCopy(deps) && cmd !== 'update') {
    // The recovery copy only finishes putting an interrupted update back (runUpdateTool sees the file name).
    (deps.io ?? { write: (l: string) => { process.stdout.write(`${l}\n`); } }).write(`${RECOVER_TOOL} only finishes an interrupted update: run Update Voidswarm.cmd.`);
    return TOOL_EXIT.USAGE;
  }
  switch (cmd) {
    case 'update':
      return runUpdateTool(rest, { ...deps.update, io: deps.io, root: deps.root, toolFile: deps.toolFile, cwd: deps.cwd, platform: deps.platform, pipe: deps.pipe, now: deps.now, statfs: deps.statfs });
    case 'restore':
      return runRestoreTool(rest, { io: deps.io, root: deps.root, toolFile: deps.toolFile, cwd: deps.cwd, platform: deps.platform, pipe: deps.pipe, now: deps.now, statfs: deps.statfs });
    case 'admin-reset':
      return runAdminReset(rest, deps);
    case 'admin-set':
      return runAdminSet(rest, deps);
    case 'backup':
      return runBackupTool(rest, deps);
    case 'fix-permissions':
      return runFixPermissionsTool(rest, deps);
    case '':
    case 'help':
    case '--help':
    case '-h': {
      const io = deps.io ?? { write: (l: string) => { process.stdout.write(`${l}\n`); }, ask: async () => null };
      io.write(TOOL_USAGE);
      return cmd ? TOOL_EXIT.OK : TOOL_EXIT.USAGE;
    }
    default: {
      // The moderation CLI on this copy's database.
      const d = takeDataFlag(rest, deps.cwd);
      const io = deps.io;
      const out = (s: string): void => { if (io) io.write(s.replace(/\n$/, '')); else process.stdout.write(s); };
      const err = (s: string): void => { if (io) io.write(s.replace(/\n$/, '')); else process.stderr.write(s.endsWith('\n') ? s : `${s}\n`); };
      if ('error' in d) { err(d.error); return TOOL_EXIT.USAGE; }
      const paths = lanPaths(rootOf(deps), { data: d.data ?? undefined, platform: deps.platform });
      const env = { ...(deps.env ?? process.env), DB_PATH: paths.db };
      return runCli([cmd, ...d.rest], { out, err, env, now: deps.now });
    }
  }
}

/** The tool's own file names (app\tool.mjs; tool.ts when run from source; the root's update.recover.mjs copy). */
const TOOL_NAME_RE = /^(?:tool\.(?:mjs|js|ts)|update\.recover\.mjs)$/i;

/** True when this module is the program being run (app\tool.mjs), not an import (tests) or another bundle. */
export function isToolEntry(url: string, argv1: string | undefined = process.argv[1], platform: Platform = process.platform): boolean {
  if (!argv1) return false;
  let self: string;
  try { self = fileURLToPath(url); } catch { return false; }
  if (!TOOL_NAME_RE.test(path.basename(argv1)) || !TOOL_NAME_RE.test(path.basename(self))) return false;
  const real = (p: string): string => {
    const abs = path.resolve(p);
    try { return fs.realpathSync.native(abs); } catch { return abs; }
  };
  const a = real(argv1);
  const b = real(self);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  try {
    process.exitCode = await runTool(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error)?.stack ?? e}\n`);
    process.exitCode = TOOL_EXIT.FAILED;
  }
}

if (isToolEntry(import.meta.url)) void main();
