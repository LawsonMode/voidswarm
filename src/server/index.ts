// OWNER: SERVER. Process entry of the Node game server: JSON text frames <-> ClientMsg/ServerMsg, binary snapshots,
// the accounts HTTP API (AUTH agent's AuthService), moderation, and optional static hosting of the built client.
// The server itself is ./app.ts (startServer); this file only boots it and hands it the process.
//   tsx src/server/index.ts [--serve <dir>]      the env boot (npm run server / npm start / the VPS)
//   app/server.mjs --lan                          the LAN edition's child: options arrive over IPC (app.ts LanStartMessage)
//   env: PORT, BIND (listen address, default 0.0.0.0 — use 127.0.0.1 behind a local reverse proxy),
//        DB_PATH, PUBLIC_URL, SMTP_* (see ARCHITECTURE.md §3b),
//        CORS_ORIGINS (comma-separated allowlist for cross-origin clients; unset = PUBLIC_URL + this
//          machine's dev client on :5173/:4173 only; '*' = any origin),
//        TRUST_PROXY=1 (+ optional TRUSTED_PROXIES) — X-Forwarded-For is only believed from a proxy on
//          loopback / the local network (or listed), so direct clients cannot forge their address,
//        MAX_CONNECTIONS (default 512), MAX_CONN_PER_IP (default 64; new connections per address are
//          also rate limited: burst 64, then 1/s),
//        CHAT_FILTER=strict|standard (word filter; default strict = classroom: mild words starred too; the filter runs
//          with or without accounts),
//        moderation (src/server/moderation, needs accounts): CHAT_LOG_RETENTION_DAYS (default 90),
//          MOD_STRIKE_LIMIT / MOD_STRIKE_WINDOW_MIN / MOD_AUTOMUTE_MIN (default 3 blocked lines in 10 min → 10 min mute).
//        Moderators: `npm run mod -- promote <username>`; dashboard at /admin; API in moderation/adminApi.md;
//          guide: docs/MODERATION.md.
//   exit codes: 0 stopped (Ctrl+C, SIGTERM, the console closing, Ctrl+Break, the launcher), 1 uncaught exception
//     (chat flushed first), 2 the port can't be opened, 3 LAN: the data folder's database can't be opened,
//     4 bad options / no start message from the launcher.
import { DEFAULT_PORT } from '../shared/constants';
import { installChildLogging } from '../lan/console';
import {
  EXIT_CRASH, EXIT_DATA, EXIT_USAGE, StartupError, exitProcess, installProcessHandlers, processIpc, startServer, waitForLanStart,
  type LanStart, type RunningServer,
} from './app';
import { memorySecrets, openFileSecrets, type SecretStore } from './secrets';

/** How long the LAN child waits for the launcher's 'lan:start' message. */
const LAN_START_TIMEOUT_MS = 30_000;

/**
 * Imported by the server tests (vitest), this module boots from env like the real thing but never takes over the
 * process: no signal / uncaught-exception handlers and no process.exit in the test worker.
 */
const underTest = process.env.VITEST !== undefined;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ts = (): string => new Date().toISOString().slice(11, 19);

/** startServer already logged a StartupError (and sent it over IPC); anything else is a bug: print its stack. */
function bootFailed(e: unknown): null {
  const code = e instanceof StartupError ? e.exitCode : EXIT_CRASH;
  if (!(e instanceof StartupError)) console.error(`${ts()} FATAL: the server failed to start: ${(e as Error)?.stack ?? e}`);
  if (!underTest) exitProcess(code);
  return null;
}

async function envBoot(): Promise<RunningServer | null> {
  const env = process.env;
  try {
    const server = await startServer({
      port: Number(env.PORT) || DEFAULT_PORT,
      bind: env.BIND?.trim() || '0.0.0.0',
      dbPath: env.DB_PATH || 'data/voidswarm.db',
      publicUrl: env.PUBLIC_URL || undefined,
      serveDir: arg('--serve'),
      env,
    });
    if (!underTest) installProcessHandlers(server);
    return server;
  } catch (e) {
    return bootFailed(e);
  }
}

/** The LAN edition's child process (§2.2): everything comes from the launcher over IPC, never argv or env. */
async function lanBoot(): Promise<RunningServer | null> {
  const ipc = processIpc();
  if (!ipc) {
    console.error(`${ts()} ERROR: --lan is the LAN edition's server process: start it with "Start Voidswarm Host.cmd" (it needs the launcher's IPC channel).`);
    if (!underTest) exitProcess(EXIT_USAGE);
    return null;
  }
  let options: LanStart;
  try {
    options = await waitForLanStart(ipc, LAN_START_TIMEOUT_MS);
  } catch (e) {
    const err = e instanceof StartupError ? e : new StartupError('EUSAGE', EXIT_USAGE, String((e as Error)?.message ?? e));
    console.error(`${ts()} ERROR: ${err.message}`);
    ipc.send({ type: 'fatal', code: err.code, exitCode: err.exitCode, message: err.message });
    if (!underTest) exitProcess(err.exitCode);
    return null;
  }
  // The quiet console (§5.1, T-LAN-10): the child's own lines go to data\logs (redacted), never to its stdio pipes,
  // which the launcher may stop reading (a QuickEdit selection in the console would then block the game).
  let logSink: ((line: string) => void) | undefined;
  if (!underTest) {
    try { logSink = installChildLogging({ dataDir: options.dataDir! }).sink; } catch { /* stdout it is */ }
  }
  // The secrets: in memory from the launcher's bundle; a change (a new SMTP password) is saved through to data\secrets.
  let secrets: SecretStore | null = null;
  if (options.secretBundle) {
    try {
      const file = openFileSecrets(options.dataDir!);
      secrets = memorySecrets(options.secretBundle, { onChange: (n, v) => { if (v) file.write(n, v); else file.remove(n); } });
    } catch (e) {
      const err = new StartupError('EDB', EXIT_DATA, `The secrets from the launcher could not be used: ${String((e as Error)?.message ?? e)}`);
      ipc.send({ type: 'fatal', code: err.code, exitCode: err.exitCode, message: err.message });
      if (!underTest) exitProcess(err.exitCode);
      return null;
    }
  }
  try {
    const { secretBundle: _bundle, ...rest } = options;
    const server = await startServer({ ...rest, secrets, env: process.env, ipc, ...(logSink ? { logSink } : {}) });
    if (!underTest) {
      installProcessHandlers(server);
      // The launcher is gone (killed, crashed): stop cleanly rather than hold the port and the data folder.
      process.once('disconnect', () => { void server.stop('launcher disconnected'); });
    }
    return server;
  } catch (e) {
    return bootFailed(e);
  }
}

/** The running server (null when it failed to start). Tests may await it instead of polling the port. */
export const booted: Promise<RunningServer | null> = process.argv.includes('--lan') ? lanBoot() : envBoot();
