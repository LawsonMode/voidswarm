// OWNER: SERVER. The game server as a library: startServer(opts) opens the accounts service, moderation (chat log,
// bans, mutes, reports), the loot profile store, the Zone and the HTTP + WebSocket listener, and resolves with a
// RunningServer whose stop() is flush-first. index.ts is the process entry (the env boot, and the LAN child's IPC
// boot); installProcessHandlers() ties signals, uncaught exceptions and the stop watchdog to a RunningServer.
//
// LAN edition (docs/LAN-EDITION-proposal.md §5.1, §5.7, §5.16, §11.3):
//  - Chat lines are written at the end of the event-loop turn in which they arrive, and a per-tick sweep writes any
//    line that reached the buffer another way. Writes never wait for the DB lock (noWait): a busy DB only keeps
//    the lines buffered. A Windows sign-out, which Node never sees as a signal, therefore loses at most one tick.
//  - stop(): 1. flush the chat buffer and checkpoint the DB FIRST; 2. the "Server stopping" line, with 3 s for
//    players to read it; 3. the per-socket teardowns (leave grants); 4. close ws; 5. profiles; 6. moderation;
//    7. accounts. installProcessHandlers() adds the 4 s watchdog and turns "closed" into the process exit.
//  - A busy port rejects with StartupError, exitCode 2 (EXIT_LISTEN). In LAN mode a database that can't open
//    rejects with the data-folder message, exitCode 3 (EXIT_DATA). Everywhere else it keeps today's behaviour:
//    guests only, and a warning that chat is not logged.
//  - LAN mode also runs (M1 gate): the settings service (settings/*, bound live to the Zone, moderation and the
//    connection gate, audited into mod_actions), the secrets (from the launcher's IPC bundle, saved through to
//    data\secrets), the maintenance worker (maint/*: the encrypted start-up backup before a migration, the FTS tidy,
//    every panel read and chunked write; in the sandboxed child a separate maint PROCESS the launcher relays,
//    maint/ipcTransport.ts) and the Host Control Panel on the admin port A (moderation/http.ts startAdminPanel:
//    loopback, the host admin login, Home, /display, Live, the Chat log). The game port then serves no admin API:
//    /admin there says the panel is on the host PC.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { DEFAULT_PORT, SNAPSHOT_EVERY_ONLINE, TICK_RATE } from '../shared/constants';
import { parseStrictness } from '../shared/moderation/filter';
import { RESTART_CLOSE_REASON, WS_CLOSE_KICKED, WS_CLOSE_SERVICE_RESTART } from '../shared/net/closeCodes';
import { encodeSnapshot } from '../shared/net/codec';
import { validateClientMsg } from '../shared/net/validate';
import type { ProfileStore } from '../shared/profile/store';
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { houseRooms } from '../shared/room/houseRooms';
import type { ModerationHook } from '../shared/room/moderation';
import { Zone, type ClientSink } from '../shared/room/Zone';
import { GAME_VERSION, PROTOCOL_VERSION } from '../shared/version';
import type { AuthService } from './auth/index';
import { createAuthServiceWith } from './auth/service';
import { migrationPlan } from './auth/store';
import { DbGuardError, protectConnection } from './db/guard';
import { MaintClient, type MaintTransportFactory } from './maint/client';
import { ipcMaintTransport } from './maint/ipcTransport';
import { auditActorOf, maintAdminHandlers } from './maint/api';
import { MaintService, maintSettingsFrom } from './maint/service';
import {
  adminIpcHooks, adminReadyFields, createAdminHttp, handleAdminIpcMessage, serveAdminPage, startAdminPanel,
  type AdminPanel, type AdminToLauncher, type Banner,
} from './moderation/http';
import { CustomTerms, customTermsAdminHandlers } from './moderation/customTerms';
import { ModerationService, moderationAdminHandlers } from './moderation/service';
import { GAME_THREAD_STORE_OPTIONS } from './moderation/store';
import { createSqliteProfileStore } from './profile/sqliteProfiles';
import { decodeBundle, memorySecrets, openFileSecrets, type SecretStore } from './secrets';
import { SettingsLoadError, SettingsService, auditToModeration, bindSettings, type Preset } from './settings';
import { createPanelState, type PanelState } from '../lan/display/state';
import {
  ConnectionGate, EventCarry, SESSION_ENDED_MSG, SessionRegistry, clientAddressKey, createFrameCache,
  defaultCorsOrigins, isTrustedProxyPeer, parseProxyTrust, resolveCorsOrigins,
} from './netguard';
import { createStaticHandler } from './static';

// ------------------------------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------------------------------

/** Process exit codes. The LAN launcher restarts the child only after EXIT_CRASH (2, 3 and 4 would just fail again). */
export const EXIT_OK = 0;
/** An uncaught exception (the chat buffer was flushed first). */
export const EXIT_CRASH = 1;
/** The port is busy, reserved, or the bind address is not on this computer. */
export const EXIT_LISTEN = 2;
/** LAN: the database in the data folder can't be opened. */
export const EXIT_DATA = 3;
/** Bad options: an invalid port, or `--lan` without the launcher's start message. */
export const EXIT_USAGE = 4;

/** The system line every pilot gets when the server stops. */
export const STOP_NOTICE = 'Server stopping — thanks for playing';
/** How long players get to read STOP_NOTICE before their sockets close (skipped when nobody is online). */
export const STOP_NOTICE_MS = 3000;
/** installProcessHandlers forces the exit this long after a stop began (a console close allows about 5 s). */
export const STOP_WATCHDOG_MS = 4000;
/** The database file inside a data folder. */
export const DB_FILE = 'voidswarm.db';
/** The projector page's folder when running from source (the LAN package passes app\display). */
export const DISPLAY_PAGE_DIR = fileURLToPath(new URL('../lan/display/', import.meta.url));
/** How often the game connection's WAL is checkpointed by the maintenance worker (walAutoCheckpoint 0 here). */
export const WAL_UPKEEP_MS = 1000;
/** stop(): how long the maintenance worker gets (an owed index tidy, closing its connections). */
export const MAINT_STOP_MS = 1500;
/** The per-tick sweep of the chat buffer (ms). */
export const CHAT_SWEEP_MS = 1000 / TICK_RATE;

const MAX_MSG_BYTES = 4096;
/** Snapshots are skipped (their global events carried over) while more than this is queued on the socket. */
const MAX_BUFFERED = 256 * 1024;
/** A client this far behind on reliable JSON messages is not reading: drop the connection. */
const MAX_BUFFERED_TEXT = 2 * 1024 * 1024;
const PING_INTERVAL_MS = 5000;
/** Messages held while a hello's token is verified (beyond this, extras are dropped). */
const MAX_PENDING = 256;
/** stop(): how long ws close handshakes and HTTP requests get before their sockets are destroyed. */
const SOCKET_GRACE_MS = 500;

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
/** A WebSocket close reason must fit in 123 UTF-8 bytes (ws throws otherwise). */
const closeReason = (s: string): string => {
  let r = s.slice(0, 100);
  while (Buffer.byteLength(r, 'utf8') > 123) r = r.slice(0, -1);
  return r;
};
const ts = (): string => new Date().toISOString().slice(11, 19);
/** The default log sink: stdout with an HH:MM:SS prefix (looked up per call, so tests can spy on console.log). */
export const defaultLogSink = (line: string): void => console.log(`${ts()} ${line}`);

// ------------------------------------------------------------------------------------------
// Types
// ------------------------------------------------------------------------------------------

export type StartupErrorCode = 'EADDRINUSE' | 'EACCES' | 'EADDRNOTAVAIL' | 'ELISTEN' | 'EDB' | 'EUSAGE';

/** Why startServer rejected. `message` is written for the host (it is also logged and sent over IPC). */
export class StartupError extends Error {
  readonly code: StartupErrorCode;
  readonly exitCode: number;
  constructor(code: StartupErrorCode, exitCode: number, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StartupError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** Child → parent messages (the LAN launcher; §2.2). Extend with new `type`s rather than changing these. */
export type ServerToParent =
  | {
    type: 'ready'; port: number; bind: string; version: string; accounts: boolean; chatLog: boolean; profiles: boolean;
    /** LAN, with the control panel: first-run setup / password reset pending, and the admin port (http.ts adminReadyFields). */
    setupPending?: boolean; setupKind?: 'first' | 'reset' | null; adminPort?: number;
  }
  | { type: 'stopping'; reason: string }
  | { type: 'fatal'; code: string; exitCode: number; message: string }
  | ({ type: 'status' } & ServerStatus)
  /** A one-line console notice (the index tidy, …); the launcher rate-limits them. */
  | { type: 'notice'; text: string }
  /** The control panel: a fresh setup code, setup done (http.ts AdminToLauncher). */
  | AdminToLauncher
  /** The maintenance process relay (maint/ipcTransport.ts). */
  | { type: 'maint:spawn' | 'maint:msg' | 'maint:kill'; gen: number; [k: string]: unknown };

/**
 * Parent → child messages startServer understands: `{ type: 'stop', reason? }`, `{ type: 'status' }`,
 * `{ type: 'reload-admin' }` (Reset admin password.cmd changed the credential) and the maint relay's messages.
 */
export type ParentToServer = { type: 'stop'; reason?: string; restart?: boolean } | { type: 'status' } | { type: 'reload-admin' };

/** The IPC channel to the LAN launcher (processIpc() wraps process.send / 'message'). */
export interface ServerIpc {
  /** Never throws (a gone parent is ignored). */
  send(msg: ServerToParent): void;
  /** Subscribe to parent messages (unvalidated); returns the unsubscribe. */
  onMessage(cb: (msg: unknown) => void): () => void;
}

/** LAN-mode details; `true` is the same as `{}`. */
export interface LanOptions {
  /** The preset of a NEW settings file (first-run setup then applies the chosen one). */
  preset?: Preset;
  /**
   * The Host Control Panel (§5): started on `port` (loopback) when given. `setupCode` is the launcher's first-run
   * code (installed while setup is pending; never logged).
   */
  admin?: { port: number; setupCode?: string | null; pageDir?: string; displayDir?: string | null } | null;
  /**
   * Where the maintenance worker runs: 'thread' (a worker_threads worker; npm / tests), 'ipc' (a maint process the
   * launcher relays: the sandboxed child), false (none: panel searches, reveals and exports answer 503). Default:
   * 'ipc' when the launcher offers it (`lan:start` maint), else 'thread'.
   */
  maint?: 'thread' | 'ipc' | false;
  /** Players can join (the game listener goes beyond loopback), and why not (banner.ts NotServingReason). */
  serveLan?: boolean;
  notServing?: string | null;
  /** The launcher's findings for the panel's banners (elevated, permissions, marked files, preflight, restarted). */
  banners?: Banner[];
}

export interface StartServerOptions {
  /** Listen port (default DEFAULT_PORT, 7777). 0 = an ephemeral port (tests); RunningServer.port has the real one. */
  port?: number;
  /** Listen address (default '0.0.0.0'). */
  bind?: string;
  /** The data folder. The DB defaults to `<dataDir>/voidswarm.db`; the LAN data-folder message names it. */
  dataDir?: string;
  /** Explicit DB path (default `<dataDir>/voidswarm.db`, else 'data/voidswarm.db'). */
  dbPath?: string;
  /** Serve the built client from this folder (`--serve dist`). */
  serveDir?: string;
  /** Base URL for reset links and the default CORS list (default `http://localhost:<port>`). */
  publicUrl?: string;
  /**
   * The remaining env knobs (default process.env): CORS_ORIGINS, TRUST_PROXY / TRUSTED_PROXIES, MAX_CONNECTIONS,
   * MAX_CONN_PER_IP, CHAT_FILTER, WATCH_SAME_NETWORK_BLOCK, SMTP_*, MOD_*, CHAT_LOG_RETENTION_DAYS.
   */
  env?: NodeJS.ProcessEnv;
  /** LAN edition child: a DB that fails to open is fatal (EXIT_DATA) instead of "guests only". */
  lan?: boolean | LanOptions;
  /** Where log lines go (default: stdout with a time prefix). Lines are passed without a timestamp. */
  logSink?: (line: string) => void;
  /** The admin dashboard's static folder (default: moderation/admin next to the source; the bundle passes its own). */
  adminPageDir?: string;
  /** The launcher's IPC channel: 'ready' / 'stopping' / 'fatal' / 'status' go out; 'stop' / 'status' come in. */
  ipc?: ServerIpc;
  /** LAN: the settings service (default: SettingsService.open on the data folder). Not used outside LAN mode yet. */
  settings?: SettingsService | null;
  /** LAN: data\secrets (default: openFileSecrets(dataDir); the launcher's child gets them over IPC). */
  secrets?: SecretStore | null;
  /** Reserved for the TLS identity (B12). Not read yet. */
  tls?: unknown;
  /** Reserved: the primary LAN address (B12 / B13 listeners). Not read yet. */
  primary?: string | null;
  /** How long players get to read STOP_NOTICE before stop() closes their sockets (default STOP_NOTICE_MS). */
  stopNoticeMs?: number;
}

export interface ServerStatus {
  version: string;
  port: number;
  bind: string;
  lan: boolean;
  /** accounts are up (false = guests only) */
  accounts: boolean;
  /** chat is being logged (moderation is up) */
  chatLog: boolean;
  /** loot profiles are saved */
  profiles: boolean;
  /** greeted connections */
  online: number;
  /** chat lines buffered, not yet written */
  chatPending: number;
  /** chat lines dropped because the buffer overflowed while the DB was unavailable */
  chatDropped: number;
  stopping: boolean;
  uptimeMs: number;
  /** rooms open (the launcher's window title) */
  rooms: number;
  /** rooms mid-match */
  playing: number;
  /** LAN: first-run setup / a password reset is pending (the launcher opens the game to the LAN once false) */
  setupPending?: boolean;
  setupKind?: 'first' | 'reset' | null;
  /** LAN: the admin listener's port */
  adminPort?: number;
  /** the maintenance worker is running */
  maint?: boolean;
}

export interface RunningServer {
  /** The port actually bound (useful with `port: 0`). */
  readonly port: number;
  readonly bind: string;
  readonly lan: boolean;
  readonly dataDir: string;
  /** null when accounts are off (the DB did not open). */
  readonly dbPath: string | null;
  readonly zone: Zone;
  readonly http: HttpServer;
  readonly log: (line: string) => void;
  readonly ipc: ServerIpc | null;
  /** LAN: the settings service, the maintenance service and the Host Control Panel (null when not running). */
  readonly settings: SettingsService | null;
  readonly maint: MaintService | null;
  readonly admin: AdminPanel | null;
  /** True once stop() began. */
  readonly stopping: boolean;
  /** Resolves with the reason when stop() begins (after the chat flush and checkpoint). */
  readonly whenStopping: Promise<string>;
  /** Resolves when stop() has finished (stores closed, listener closed). Never rejects. */
  readonly closed: Promise<void>;
  status(): ServerStatus;
  /** Write every buffered chat line now (noWait). Never throws. Returns the lines still buffered (0 = all written). */
  flushChat(): number;
  /** PRAGMA wal_checkpoint(TRUNCATE) on a short-lived connection. Never throws; false = not (fully) done. */
  checkpoint(): boolean;
  /**
   * The flush-first shutdown (idempotent: later calls return the same promise). Never rejects. `restart`: a planned
   * restart (the launcher replaces this child): players' sockets close with 1012 and their clients reconnect.
   */
  stop(reason?: string, opts?: { restart?: boolean }): Promise<void>;
}

// ------------------------------------------------------------------------------------------
// Startup errors
// ------------------------------------------------------------------------------------------

/** The friendly message for a failed listen (exit code 2). */
export function listenErrorMessage(e: NodeJS.ErrnoException, port: number, bind: string, lan: boolean): StartupError {
  const where = `${bind}:${port}`;
  const change = lan ? 'change the port in the Host Control Panel (Settings)' : 'set PORT to a free port';
  switch (e.code) {
    case 'EADDRINUSE':
      return new StartupError('EADDRINUSE', EXIT_LISTEN,
        `Port ${port} is already in use (${where}): another Voidswarm server or another program is using it. `
        + `Stop that program, or ${change}.`, e);
    case 'EACCES':
      return new StartupError('EACCES', EXIT_LISTEN,
        `This computer refused port ${port} (${where}): it may be reserved by the system `
        + '(on Windows, see "netsh interface ipv4 show excludedportrange protocol=tcp") or need administrator rights. '
        + `Pick another port: ${change}.`, e);
    case 'EADDRNOTAVAIL':
      return new StartupError('EADDRNOTAVAIL', EXIT_LISTEN,
        `The address ${bind} is not on this computer, so port ${port} can't be opened there. `
        + (lan ? 'The network may have changed: restart the host.' : 'Set BIND to one of its addresses, or 0.0.0.0.'), e);
    default:
      return new StartupError('ELISTEN', EXIT_LISTEN, `Could not open port ${port} (${where}): ${errMsg(e)}.`, e);
  }
}

/** The LAN data-folder message for a database that can't open (exit code 3). */
export function dataFolderError(dataDir: string, dbPath: string, cause: unknown): StartupError {
  // A database refused on purpose (newer than this server, or changed outside it): its own message says what to do.
  if (cause instanceof DbGuardError && (cause.code === 'ENEWER' || cause.code === 'ECHANGED')) {
    return new StartupError('EDB', EXIT_DATA, `${cause.message} (data folder ${dataDir}, ${path.basename(dbPath)})`, cause);
  }
  return new StartupError('EDB', EXIT_DATA,
    `Voidswarm could not open its database in the data folder ${dataDir} (${path.basename(dbPath)}: ${errMsg(cause)}). `
    + 'Chat would not be logged, so the host did not start. Check that the data folder is not read-only, open in another '
    + 'program or blocked by antivirus, then start again, or restore a backup ("Restore a backup.cmd").', cause);
}

// ------------------------------------------------------------------------------------------
// DB helpers
// ------------------------------------------------------------------------------------------

/** PRAGMA wal_checkpoint(TRUNCATE) on a short-lived connection (never creates the file). True = fully checkpointed. */
export function checkpointDb(dbPath: string | null): boolean {
  if (!dbPath || dbPath === ':memory:' || !existsSync(dbPath)) return false;
  let db: DatabaseSync | null = null;
  try {
    db = protectConnection(new DatabaseSync(dbPath));
    db.exec('PRAGMA busy_timeout = 250');
    const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number | bigint } | undefined;
    return Number(row?.busy ?? 0) === 0;
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

// ------------------------------------------------------------------------------------------
// LAN helpers
// ------------------------------------------------------------------------------------------

/** The maint process relay over the launcher's IPC channel (maint/ipcTransport.ts, src/lan/maintRelay.ts). */
function relayTransport(ipc: ServerIpc): MaintTransportFactory {
  return ipcMaintTransport({
    send: (m) => ipc.send(m as ServerToParent),
    onMessage: (cb) => ipc.onMessage(cb),
  });
}

/** The Join card's line when players can't join yet (banner.ts NotServingReason). */
export function notServingText(reason: string | null): string {
  switch (reason) {
    case 'public-network': return 'Players can’t join: this network is set to Public (see Server → Network).';
    case 'unapproved-network': return 'Players can’t join on this new network until you approve it.';
    case 'no-address': return 'Players can’t join: this PC has no network address (connect to Wi-Fi or Ethernet, then restart).';
    case 'this-pc-only': return 'The game is on this PC only (the host was started with --this-pc-only).';
    case 'setup':
    default: return 'Players can join after setup.';
  }
}

const POINTER_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
} as const;

/**
 * LAN (§3.2): the game port serves no admin API. `/admin` says the panel is on the host PC (with its localhost link,
 * which only works there); `/api/admin/*` is 404. True when it answered.
 */
export function lanAdminPointer(req: IncomingMessage, res: ServerResponse, adminPort: number | null): boolean {
  const p = (req.url ?? '').split('?')[0] ?? '';
  if (p.startsWith('/api/admin/') || p === '/api/admin') {
    req.resume();
    res.writeHead(404, { ...POINTER_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'The control panel is on the host PC.' }));
    return true;
  }
  if (p !== '/admin' && !p.startsWith('/admin/')) return false;
  req.resume();
  const link = adminPort ? `http://localhost:${adminPort}/` : null;
  res.writeHead(200, { ...POINTER_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>Voidswarm control panel</title>'
    + '<body style="font-family:system-ui,sans-serif;background:#0b0f1a;color:#e6ecff;padding:2rem;max-width:40rem">'
    + '<h1>The control panel is on the host PC</h1>'
    + `<p>Open it on the computer running Voidswarm${link ? `: <a style="color:#7fdcff" href="${link}">${link}</a>` : ''}.</p></body>`);
  return true;
}

// ------------------------------------------------------------------------------------------
// startServer
// ------------------------------------------------------------------------------------------

export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const env = opts.env ?? process.env;
  const lan = !!opts.lan;
  const log = opts.logSink ?? defaultLogSink;
  const ipc = opts.ipc ?? null;
  const ipcSend = (m: ServerToParent): void => { try { ipc?.send(m); } catch { /* the parent is gone */ } };
  const startedAt = Date.now();

  const reject = (err: StartupError): never => {
    log(`ERROR: ${err.message}`);
    ipcSend({ type: 'fatal', code: err.code, exitCode: err.exitCode, message: err.message });
    throw err;
  };

  const port = opts.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    reject(new StartupError('EUSAGE', EXIT_USAGE, `The port must be a whole number from 0 to 65535 (got ${String(port).slice(0, 20)}).`));
  }
  const bind = opts.bind?.trim() || '0.0.0.0';
  const dbPath = opts.dbPath || (opts.dataDir ? path.join(opts.dataDir, DB_FILE) : 'data/voidswarm.db');
  const dataDir = opts.dataDir ?? path.dirname(path.resolve(dbPath));
  const serveDir = opts.serveDir;
  const noticeMs = Math.max(0, opts.stopNoticeMs ?? STOP_NOTICE_MS);

  const proxyTrust = parseProxyTrust(env);
  const publicUrl = opts.publicUrl || `http://localhost:${port}`;
  const corsOrigins = resolveCorsOrigins(env.CORS_ORIGINS, () => defaultCorsOrigins(publicUrl, networkInterfaces(), [hostname()]));

  // --- Stores. Accounts are optional infrastructure (guests only without them), except in LAN mode. ---
  let auth: AuthService | null = null;
  /** Moderation (chat log, bans, mutes, reports, moderators): on the auth DB, so only when accounts are up. */
  let mod: ModerationService | null = null;
  let profiles: ProfileStore | undefined;
  let storesClosed = false;
  const closeStores = (): void => {
    if (storesClosed) return;
    storesClosed = true;
    // Every Zone connection is gone (no more grants): the profile connection first, then moderation (its close
    // flushes the chat log), then the AuthService's.
    try { customTerms?.close(); } catch { /* closed */ }
    try { profiles?.close?.(); } catch (e) { log(`profile store close error: ${errMsg(e)}`); }
    try { mod?.close(); } catch (e) { log(`moderation close error: ${errMsg(e)}`); }
    try { auth?.close(); } catch (e) { log(`auth close error: ${errMsg(e)}`); }
  };
  // --- LAN: secrets, settings and the maintenance worker, before the accounts DB opens (§2.2 step 10). ---
  const lanOpts: LanOptions = typeof opts.lan === 'object' && opts.lan ? opts.lan : {};
  let secrets: SecretStore | null = null;
  let settings: SettingsService | null = null;
  let maintClient: MaintClient | null = null;
  let maint: MaintService | null = null;
  let panel: AdminPanel | null = null;
  let panelState: PanelState | null = null;
  let unbindSettings: (() => void) | null = null;
  let customTerms: CustomTerms | null = null;
  /** Filled once the Zone exists (the maintenance service's quiet windows count the pilots online). */
  let zoneRef: Zone | null = null;
  const closeLanQuiet = (): void => {
    const m = maint;
    const c = maintClient;
    maint = null;
    maintClient = null;
    void (m ? m.stop() : c ? c.close() : Promise.resolve()).catch(() => undefined);
    try { unbindSettings?.(); } catch { /* closing */ }
    const s = settings;
    settings = null;
    if (s && !opts.settings) void s.close().catch(() => undefined);
  };
  const abort = (err: StartupError): never => { closeStores(); closeLanQuiet(); return reject(err); };

  if (lan) {
    try {
      secrets = opts.secrets ?? openFileSecrets(dataDir);
      // A data folder of its own (tests, npm): the random keys exist from the first run on (the launcher does this too).
      if (!opts.secrets) { secrets.ensureKey('pepper.key'); secrets.ensureKey('backup.key'); }
    } catch (e) {
      abort(dataFolderError(dataDir, dbPath, e));
    }
    try {
      settings = opts.settings ?? SettingsService.open({ dataDir, env, lan: true, preset: lanOpts.preset, secrets, log, envWarnings: !ipc });
    } catch (e) {
      abort(new StartupError('EDB', EXIT_DATA, e instanceof SettingsLoadError ? e.message
        : `The settings in the data folder ${dataDir} could not be read (${errMsg(e)}). Restore a backup ("Restore a backup.cmd").`, e));
    }
    const maintMode = lanOpts.maint === undefined ? 'thread' : lanOpts.maint;
    if (maintMode) {
      const s = settings!.get();
      try {
        maintClient = await MaintClient.start({
          dataDir, dbPath, backupKey: secrets!.read('backup.key'), pepper: secrets!.read('pepper.key'), sizeCapMB: s.backups.sizeCapMB,
          installId: s.installId, appVersion: GAME_VERSION, log,
          ...(maintMode === 'ipc' && ipc ? { transport: relayTransport(ipc) } : {}),
        });
      } catch (e) {
        maintClient = null;
        log(`WARNING: the maintenance worker did not start (${errMsg(e)}): panel searches, reveals and exports are unavailable, and backups run on the server thread.`);
      }
    }
    try {
      maint = await MaintService.start({
        dataDir, dbPath, secrets: secrets!, settings: () => maintSettingsFrom(settings!.get()), appVersion: GAME_VERSION, log,
        connections: () => { try { return zoneRef?.onlinePilots().length ?? 0; } catch { return 0; } },
        audit: (e) => { try { mod?.audit(auditActorOf(e.actor), e.action, null, e.reason); } catch { /* audit is best effort */ } },
        runner: maintClient,
      });
    } catch (e) {
      maint = null;
      log(`WARNING: backups are not available this session (${errMsg(e)}).`);
    }
    // §2.2 step 10, §6.6: an encrypted backup first; a migration without one does not run (nothing is changed).
    if (maint) {
      let plan: ReturnType<typeof migrationPlan> = null;
      try { plan = migrationPlan(dbPath); } catch { /* unreadable: the AuthStore's own open says why */ }
      try { await maint.startupBackup({ migration: plan }); } catch (e) { log(`WARNING: the start-up backup failed: ${errMsg(e)}`); }
      if (maint.migrationBlocked) abort(new StartupError('EDB', EXIT_DATA, maint.migrationBlocked));
    }
  }
  const pepperKey = (): Buffer | null => { try { return secrets?.read('pepper.key') ?? null; } catch { return null; } };

  try {
    auth = createAuthServiceWith({
      dbPath,
      publicUrl,
      corsOrigins,
      log, // auth lines already carry an "[auth]" prefix
    }, {
      env,
      // Banned accounts / networks can't sign in; banned networks (and filtered names) can't register.
      guard: {
        login: (account, ip) => mod ? mod.loginRefused(account, ip) : false,
        register: (username, ip) => {
          // §4.10: the host admin's username (any it had) is not a player's.
          try { if (panel?.hostAdmin.isReservedName(username)) return { status: 400, message: "That username isn't available — pick another." }; } catch { /* stopping */ }
          return mod ? mod.registerRefusal(username, ip) : null;
        },
      },
      // LAN: the pepper (email_hash backfill) and the §6.5 schema check that refuses a database changed outside.
      ...(lan ? { store: { pepper: pepperKey(), schemaCheck: 'refuse' as const } } : {}),
    });
  } catch (e) {
    auth = null;
    if (lan) abort(dataFolderError(dataDir, dbPath, e));
    log(`WARNING: accounts disabled (auth service failed to start: ${errMsg(e)}). Everyone plays as a guest.`);
  }
  if (auth) {
    try {
      // With the maintenance worker, the game connection neither checkpoints nor merges FTS segments (T-PERF-2).
      mod = new ModerationService({ dbPath, log, env, ...(lan && maintClient ? { storeOptions: { ...GAME_THREAD_STORE_OPTIONS } } : {}) });
    } catch (e) {
      mod = null;
      if (lan) abort(dataFolderError(dataDir, dbPath, e));
      log(`WARNING: moderation disabled (${errMsg(e)}) — chat is still filtered but NOT logged, and bans are not enforced.`);
    }
  } else {
    log('WARNING: moderation needs the accounts database — chat is still filtered but NOT logged, and bans are not enforced.');
  }

  // v0.3 loot profiles (docs/v0.3-proposal.md §7.2): a second connection on the auth DB, opened AFTER the AuthService
  // (which migrates the schema). No accounts = no store (guests keep their loot on their device). If it can't open,
  // account pilots still get a session-only profile ("Loot won't be saved this session") — except in LAN mode.
  if (auth) {
    try {
      profiles = createSqliteProfileStore(dbPath, { log });
    } catch (e) {
      profiles = undefined;
      if (lan) abort(dataFolderError(dataDir, dbPath, e));
      log(`WARNING: loot profiles are not saved this session (profile store failed to open: ${errMsg(e)}).`);
    }
  }
  // LAN: the maintenance worker serves the moderation service (panel reads, exports, purges, retention), the settings
  // changes are audited, and a v4 index built by the migration is tidied before the listener opens (§5.16).
  if (lan && mod) {
    const m = maint;
    mod.attachMaint(maintClient ? {
      client: maintClient,
      ...(m ? { backup: (reason: 'pre-purge', actor: string) => m.backupNow(reason, { actor }), indexDirty: () => m.noteIndexDirty() } : {}),
    } : null);
    try { await mod.maintReady(); } catch (e) { log(`WARNING: earlier alerts could not be loaded: ${errMsg(e)}`); }
    settings?.setAudit(auditToModeration(mod));
    // The host's own words (§5.12), installed in the word filter before anyone can chat.
    try {
      const m2 = mod;
      customTerms = new CustomTerms({ dbPath, log, audit: (actor, reason) => { m2.audit(actor, 'terms', null, reason); } });
      customTerms.install();
    } catch (e) {
      customTerms = null;
      log(`WARNING: the custom terms could not be loaded (${errMsg(e)}); the built-in filter still runs`);
    }
  }
  if (maint) {
    try {
      await maint.startupTidy((text) => { log(text); ipcSend({ type: 'notice', text }); });
    } catch (e) { log(`the index tidy at start was skipped: ${errMsg(e)}`); }
  }

  if (auth) {
    log(corsOrigins === '*'
      ? 'WARNING: CORS_ORIGINS=* — any website may call the accounts API from its visitors\' browsers.'
      : `accounts API: cross-origin allowed for ${corsOrigins.length} origin(s) (+ same-origin); set CORS_ORIGINS to change`);
  }

  // Word filter strictness (docs/MODERATION.md): 'strict' unless CHAT_FILTER=standard; a typo stays strict.
  const chatFilter = parseStrictness(env.CHAT_FILTER);
  if (env.CHAT_FILTER && env.CHAT_FILTER.trim().toLowerCase() !== chatFilter) {
    log(`WARNING: CHAT_FILTER=${JSON.stringify(env.CHAT_FILTER).slice(0, 40)} is not strict or standard — using strict.`);
  }
  log(`chat filter: ${chatFilter}${chatFilter === 'strict' ? ' (classroom default)' : ''}`);

  // --- End-of-tick chat writes (§5.1, §5.16). ---
  let chatWriteQueued = false;
  /** One noWait batch (the service queues the next one itself); a busy DB leaves the lines buffered. */
  const writeChat = (): void => {
    if (!mod || storesClosed || !mod.store.pending) return;
    mod.flushStep();
  };
  /** At the end of this event-loop turn: every line that arrived in it goes out in one transaction. */
  const queueChatWrite = (): void => {
    if (chatWriteQueued || storesClosed) return;
    chatWriteQueued = true;
    setImmediate(() => { chatWriteQueued = false; writeChat(); });
  };
  let chatSweep: ReturnType<typeof setInterval> | null = null;
  const baseHook = mod?.hook();
  const moderation: ModerationHook | undefined = baseHook
    ? { ...baseHook, logChat: (entry) => { baseHook.logChat(entry); queueChatWrite(); } }
    : undefined;

  const zone = new Zone({
    snapshotEvery: SNAPSHOT_EVERY_ONLINE,
    local: false,
    // Say so when chat is logged (docs/MODERATION.md, privacy): players should know a moderator can read it later.
    motd: `Welcome to Voidswarm v${GAME_VERSION}. Pick a game type and hit Quick Play, or type /help for commands.`
      + (mod ? ' Chat on this server is filtered and logged for moderators; /report <name> <reason> flags a problem.' : ''),
    // v0.3 house rooms, each only while its sub-mode is `ready` (The Descent, Flag Run, Hot Points, Duel Pit, Warzone
    // Classic — docs/v0.3-proposal.md section 3.3; houseRooms() skips the rest, so The Descent opens once `coop` is ready)
    defaultRooms: houseRooms(false),
    log,
    isReservedName: (n) => {
      try {
        if (panel?.hostAdmin.isReservedName(n)) return true;
        return auth ? auth.isRegisteredUsername(n) : false;
      } catch { return false; }
    },
    // Off by default (classrooms / households share one address); set 1 for public internet hosting.
    blockSameNetworkWatch: env.WATCH_SAME_NETWORK_BLOCK === '1',
    profiles,
    moderation,
    chatFilter,
  });
  mod?.attachZone(zone);
  zoneRef = zone;

  // The v0.5 moderator dashboard / API on the game port (npm / VPS). The LAN edition's panel is on the admin port.
  const adminHttp = lan ? null : createAdminHttp({
    service: mod,
    verifyToken: auth ? (t) => auth!.verifyToken(t) : null,
    corsOrigins,
    trustProxy: proxyTrust.enabled,
    log,
  });

  /** Live ws connections authenticated with a session, so a logout / password reset can end them. */
  const sessions = new SessionRegistry<{ kick(reason: string): void }>();
  if (auth && typeof auth.onSessionsRevoked === 'function') {
    try {
      auth.onSessionsRevoked((accountId, sessionTokenHash) => {
        const hit = sessions.revoke(accountId, sessionTokenHash);
        for (const h of hit) {
          try { h.kick(SESSION_ENDED_MSG); } catch (e) { log(`session kick error: ${errMsg(e)}`); }
        }
        if (hit.length) log(`session revoked: ended ${hit.length} live connection(s)`);
      });
    } catch (e) {
      log(`WARNING: could not subscribe to session revocations: ${errMsg(e)}`);
    }
  }

  // Per-address caps are generous on purpose: a classroom behind one NAT address shares them.
  const envInt = (name: string, dflt: number, min: number): number => {
    const n = Math.floor(Number(env[name]));
    return Number.isFinite(n) && n >= min ? n : dflt;
  };
  const gate = new ConnectionGate({
    maxTotal: envInt('MAX_CONNECTIONS', 512, 1),
    maxPerAddress: envInt('MAX_CONN_PER_IP', 64, 1),
    burst: 64,
    perSec: 1,
  });
  // LAN: the settings apply now and live (Zone chat options and room caps, moderation config and policy, gate limits).
  if (settings) {
    try { unbindSettings = bindSettings(settings, { zone, moderation: mod, gate, log }); } catch (e) { log(`WARNING: the settings could not be applied: ${errMsg(e)}`); }
  }

  const staticHandler = serveDir ? createStaticHandler(serveDir) : null;
  let stopping = false;

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (storesClosed) {
      res.writeHead(503, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: 'The server is stopping.' }));
      return;
    }
    try {
      // Moderation first: the admin API (/api/admin/*) and its dashboard (/admin).
      if (adminHttp) {
        if (await adminHttp.handle(req, res)) return;
        if (serveAdminPage(req, res, opts.adminPageDir)) return;
      } else if (lanAdminPointer(req, res, panel?.port ?? lanOpts.admin?.port ?? null)) return;
      if (auth && (await auth.handleHttp(req, res))) return;
    } catch (e) {
      log(`auth http error: ${(e as Error)?.stack ?? e}`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: 'Server error' }));
      return;
    }
    if (req.url?.startsWith('/api/')) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Accounts are not available on this server.' }));
      return;
    }
    if (staticHandler) { staticHandler(req, res); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Voidswarm server v${GAME_VERSION} (protocol ${PROTOCOL_VERSION}). Connect with the game client.\n`);
  };

  const http = createServer((req, res) => {
    // A forged X-Forwarded-For from a client that reached us directly must not steer per-IP limits.
    if (proxyTrust.enabled && !isTrustedProxyPeer(req.socket.remoteAddress, proxyTrust)) delete req.headers['x-forwarded-for'];
    void handleRequest(req, res);
  });

  const wss = new WebSocketServer({ server: http, maxPayload: 64 * 1024 });
  // ws re-emits the http server's 'error' events: without a listener a failed listen was an uncaught exception.
  let listening = false;
  wss.on('error', (e) => { if (listening) log(`ws server error: ${errMsg(e)}`); });

  /** Broadcasts are serialized once, not once per recipient. */
  const frameOf: (m: ServerMsg) => Buffer = createFrameCache();

  /**
   * Per-socket Zone teardown (Zone.disconnect → Room.removeUser → leave grants). Shutdown runs these synchronously,
   * BEFORE closing the profile store: a ws 'close' event only fires after the close handshake, by which time the
   * stores would already be closed and a leaver's secured caches lost.
   */
  const teardowns = new Map<WebSocket, () => void>();

  wss.on('connection', (ws: WebSocket, req) => {
    const addr = `${req.socket.remoteAddress ?? '?'}:${req.socket.remotePort ?? '?'}`;
    if (stopping) {
      ws.on('error', () => { /* refused socket: nothing to clean up */ });
      ws.close(1001, 'server shutting down');
      return;
    }
    const key = clientAddressKey(req.socket.remoteAddress, req.headers['x-forwarded-for'], proxyTrust);
    const refusal = gate.tryAcquire(key, Date.now());
    if (refusal) {
      log(`ws refused ${addr} (${key}): ${refusal}`);
      ws.on('error', () => { /* refused socket: nothing to clean up */ });
      ws.close(1013, refusal);
      return;
    }
    log(`ws connect ${addr}`);
    const carry = new EventCarry();
    const sink: ClientSink = {
      sendMsg(m) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED_TEXT) {
          log(`ws ${addr} is not reading (${ws.bufferedAmount} B queued) — dropping it`);
          ws.terminate();
          return;
        }
        // Held (skipped-snapshot) events belong to the previous match — or, on a rift floorStart, to the previous
        // floor's map (room indices, positions): the next snapshot starts fresh.
        if (m.type === 'matchStart' || m.type === 'floorStart') carry.reset();
        ws.send(frameOf(m), { binary: false });
      },
      sendSnapshot(s) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED) { carry.hold(s); return; } // keep its kill feed / level-ups for the next one
        ws.send(encodeSnapshot(carry.merge(s)), { binary: true });
      },
      close(reason) {
        // The client returns to its title / login screen with `reason` (and forgets a revoked session).
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(WS_CLOSE_KICKED, closeReason(reason));
      },
    };
    const conn = zone.connect(sink);
    conn.setAddress(key);
    let closed = false;
    let forgetSession: (() => void) | null = null;

    const deliver = (msg: ClientMsg): void => {
      try { conn.handle(msg); } catch (e) { log(`handler error (${addr}, ${msg.type}): ${(e as Error)?.stack ?? e}`); }
    };

    // The first hello is held until its token is verified; anything arriving meanwhile queues behind it.
    let helloSeen = false;
    let pending: ClientMsg[] | null = null;
    const onHello = async (hello: Extract<ClientMsg, { type: 'hello' }>): Promise<void> => {
      let invalid = false;
      let accountId: string | null = null;
      if (auth && typeof hello.token === 'string' && hello.token) {
        const token = hello.token;
        try {
          const acc = await auth.verifyToken(token);
          conn.setAccount(acc);
          invalid = !acc;
          accountId = acc ? acc.accountId : null;
          if (acc && !closed) {
            forgetSession = sessions.add(acc.accountId, sha256Hex(token), { kick: (r) => conn.kick(r) });
          }
        } catch (e) {
          log(`verifyToken error (${addr}): ${errMsg(e)}`);
          conn.setAccount(null);
          invalid = true;
        }
      } else {
        conn.setAccount(null);
      }
      if (closed) return;
      // Moderation: a banned account / network (or a guest from a network banned for guests) is refused here.
      const ban = mod ? mod.banFor({ accountId, address: key, name: typeof hello.name === 'string' ? hello.name : null }) : null;
      if (ban) {
        log(`ws refused ${addr} (${key}): banned (#${ban.id})`);
        pending = null;
        conn.kick(mod!.banMessage(ban));
        return;
      }
      if (invalid) sink.sendMsg({ type: 'error', message: 'Session expired — please log in again' });
      deliver(hello);
      const queued = pending ?? [];
      pending = null;
      for (const m of queued) { if (closed) break; deliver(m); }
    };

    let pingSentAt = 0;
    const pinger = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (pingSentAt && Date.now() - pingSentAt > 30_000) { ws.terminate(); return; } // dead peer
      if (!pingSentAt) { pingSentAt = Date.now(); ws.ping(); }
    }, PING_INTERVAL_MS);
    ws.on('pong', () => { if (pingSentAt) { conn.setPing(Date.now() - pingSentAt); pingSentAt = 0; } });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const len = Array.isArray(data) ? data.reduce((a, b) => a + b.length, 0) : (data as Buffer | ArrayBuffer).byteLength;
      if (len > MAX_MSG_BYTES) return;
      let parsed: unknown;
      try { parsed = JSON.parse(data.toString()); } catch { return; }
      const msg = validateClientMsg(parsed);
      if (!msg) return;
      if (pending) {
        if (pending.length < MAX_PENDING) pending.push(msg);
        return;
      }
      if (msg.type === 'hello' && !helloSeen) {
        helloSeen = true;
        pending = [];
        void onHello(msg);
        return;
      }
      deliver(msg);
    });
    const teardown = (): void => {
      if (closed) return;
      closed = true;
      pending = null;
      clearInterval(pinger);
      gate.release(key);
      forgetSession?.();
      forgetSession = null;
      try { conn.close(); } catch (e) { log(`close error: ${errMsg(e)}`); }
    };
    teardowns.set(ws, teardown);
    ws.on('close', () => {
      teardowns.delete(ws);
      if (closed) return;
      teardown();
      log(`ws disconnect ${addr}`);
    });
    ws.on('error', (e) => log(`ws error ${addr}: ${e.message}`));
  });

  // --- Listen. A failure (busy port, reserved port, foreign address) closes the stores and rejects: exit code 2. ---
  try {
    await new Promise<void>((resolve, rej) => {
      const onError = (e: Error): void => { http.off('listening', onListening); rej(e); };
      const onListening = (): void => { http.off('error', onError); resolve(); };
      http.once('error', onError);
      http.once('listening', onListening);
      http.listen(port, bind);
    });
  } catch (e) {
    try { wss.close(); } catch { /* not started */ }
    abort(listenErrorMessage(e as NodeJS.ErrnoException, port, bind, lan));
  }
  listening = true;
  http.on('error', (e) => log(`http server error: ${errMsg(e)}`));
  const boundPort = (http.address() as AddressInfo | null)?.port ?? port;

  log(`Voidswarm v${GAME_VERSION} listening on ${bind}:${boundPort}${serveDir ? ` (serving ${serveDir})` : ''}${auth ? ` — accounts on${profiles ? ', loot saved' : ', loot NOT saved'}` : ' — guests only'}`);
  if (proxyTrust.enabled && bind !== '127.0.0.1' && bind !== '::1' && bind !== 'localhost') {
    log('note: TRUST_PROXY is on and the port is reachable from other hosts — X-Forwarded-For is only trusted from local-network peers (set BIND=127.0.0.1 behind a local proxy)');
  }
  zone.start();
  if (mod) {
    chatSweep = setInterval(writeChat, CHAT_SWEEP_MS);
    chatSweep.unref?.();
  }

  /** The panel's banners: the launcher's findings, backups and disk, alerts, and whether chat is being logged. */
  const lanBanners = (): Banner[] => {
    const out: Banner[] = [];
    let permissions: string | undefined;
    try { permissions = settings?.get().launcher.permissions; } catch { /* shown */ }
    out.push(...launcherBanners(lanOpts.banners ?? [], permissions));
    if (!mod) out.push({ code: 'chat-not-logged', level: 'urgent', text: 'Chat is NOT being logged (the database is not open). Restart the host.' });
    else if (mod.store.dropped > 0) out.push({ code: 'chat-dropped', level: 'urgent', text: `Chat is NOT being logged right now: ${mod.store.dropped} line(s) could not be written (the database is busy or the disk is full).` });
    if (lan && !maintClient) out.push({ code: 'maint-down', level: 'warn', text: 'The maintenance worker is not running: Chat log searches, reveals and exports are unavailable until the host restarts.' });
    else if (maintClient?.failed) out.push({ code: 'maint-down', level: 'warn', text: maintClient.failed });
    try { if (maint) out.push(...maint.banners()); } catch { /* next time */ }
    try { if (mod) out.push(...mod.banners()); } catch { /* next time */ }
    return out;
  };

  // --- LAN: the Host Control Panel on the admin port (loopback; §5, §3.1). ---
  const noteHostName = (): void => {
    try {
      const n = panel?.hostAdmin.hostUsername();
      zone.setReservedNames(n ? [n] : []);
    } catch { /* stopping */ }
  };
  if (lan && lanOpts.admin && auth) {
    const serveLan = lanOpts.serveLan ?? bind !== '127.0.0.1';
    const adminOpts = lanOpts.admin;
    const ps = createPanelState({
      serverName: () => settings?.get().serverName ?? 'Voidswarm',
      join: () => ({
        url: serveLan ? publicUrl : null,
        notServing: serveLan ? null : notServingText(lanOpts.notServing ?? null),
        others: [],
      }),
      rooms: () => zone.roomSummaries(),
      pilots: () => zone.onlinePilots(),
      alerts: mod ? () => mod!.alertCounts() : undefined,
      classPeriods: () => settings?.get().chat.classPeriods ?? [],
      presentingAtLogin: () => settings?.get().admin.presentingAtLogin ?? false,
      announce: (text, roomId) => zone.announce(text, roomId),
      audit: mod ? (actor, reason) => { mod!.audit(actor, 'announce', null, reason); } : undefined,
      log,
    });
    panelState = ps;
    const hooks = adminIpcHooks((m) => ipcSend(m));
    try {
      panel = await startAdminPanel({
        dbPath,
        port: adminOpts.port,
        service: mod,
        settings,
        pepper: pepperKey(),
        setupCode: adminOpts.setupCode ?? null,
        pageDir: adminOpts.pageDir ?? opts.adminPageDir,
        displayDir: adminOpts.displayDir === undefined ? DISPLAY_PAGE_DIR : adminOpts.displayDir,
        trustProxy: proxyTrust.enabled,
        handlers: {
          ...(maint ? maintAdminHandlers(maint) : {}),
          ...(mod ? moderationAdminHandlers(mod) : {}),
          ...(customTerms ? customTermsAdminHandlers(customTerms) : {}),
          ...ps.handlers,
        },
        banners: () => lanBanners(),
        log,
        onSetupCode: hooks.onSetupCode,
        onStateChange: (s) => { noteHostName(); hooks.onStateChange(s); },
      });
      noteHostName();
      log(`Host Control Panel on http://localhost:${panel.port}/`);
    } catch (e) {
      ps.close();
      panelState = null;
      try { zone.stop(); } catch { /* not started */ }
      if (chatSweep) clearInterval(chatSweep);
      chatSweep = null;
      try { wss.close(); } catch { /* closing */ }
      await new Promise<void>((r) => { http.close(() => r()); http.closeAllConnections(); });
      const le = e as { code?: string; message?: string };
      abort(le.code
        ? listenErrorMessage(Object.assign(new Error(le.message ?? ''), { code: le.code }) as NodeJS.ErrnoException, adminOpts.port, '127.0.0.1', true)
        : new StartupError('ELISTEN', EXIT_LISTEN, `The control panel could not start: ${errMsg(e)}`, e));
    }
  }

  // --- LAN: with the maintenance worker, the game connection's WAL is checkpointed there once a second; if the
  //     worker fails for good, this connection checkpoints and merges itself again (INLINE_STORE_OPTIONS). ---
  let upkeep: ReturnType<typeof setInterval> | null = null;
  if (maintClient && mod) {
    const client: MaintClient = maintClient;
    const store = mod.store;
    let inline = false;
    let busy = false;
    upkeep = setInterval(() => {
      if (storesClosed) return;
      if (client.failed && !inline) {
        inline = true;
        try { store.setWalAutoCheckpoint(1000); store.setFtsMerge('inline'); } catch { /* the next flush */ }
        log('the maintenance worker is down: the chat log checkpoints and merges on the server thread again');
      }
      if (inline || busy || !client.ready) return;
      busy = true;
      client.call('wal.checkpoint', {}, { timeoutMs: 10_000 }).catch(() => undefined).finally(() => { busy = false; });
    }, WAL_UPKEEP_MS);
    upkeep.unref?.();
  }
  maint?.startTimers();

  // --- The running server. ---
  const flushChat = (): number => {
    if (!mod || storesClosed) return 0;
    mod.flushAllQuiet();
    return mod.store.pending;
  };
  const checkpoint = (): boolean => (auth && !storesClosed ? checkpointDb(dbPath) : false);
  const status = (): ServerStatus => {
    let online = 0;
    try { online = zone.onlinePilots().length; } catch { online = 0; }
    let rooms = 0;
    let playing = 0;
    try {
      const list = zone.roomSummaries();
      rooms = list.length;
      playing = list.filter((r) => r.phase === 'countdown' || r.phase === 'playing').length;
    } catch { /* stopping */ }
    return {
      version: GAME_VERSION,
      port: boundPort,
      bind,
      lan,
      accounts: !!auth,
      chatLog: !!mod,
      profiles: !!profiles,
      online,
      chatPending: mod && !storesClosed ? mod.store.pending : 0,
      chatDropped: mod ? mod.store.dropped : 0,
      stopping,
      uptimeMs: Date.now() - startedAt,
      rooms,
      playing,
      ...(panel && !storesClosed ? adminReadyFields(panel) : {}),
      ...(lan ? { maint: !!maintClient && !maintClient.failed } : {}),
    };
  };

  let resolveStopping!: (reason: string) => void;
  const whenStopping = new Promise<string>((r) => { resolveStopping = r; });
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => { resolveClosed = r; });
  let stopPromise: Promise<void> | null = null;
  let unsubscribeIpc: (() => void) | null = null;

  const runStop = async (reason: string, restart: boolean): Promise<void> => {
    log(`shutting down (${reason})...`);
    // 1. FIRST: every buffered chat line to the DB, and the WAL into the main file. Everything after this can be
    //    cut short (the watchdog, Windows ending a closed console) without losing chat.
    const left = flushChat();
    checkpoint();
    if (left) log(`WARNING: ${left} chat line(s) could not be written yet (the database is busy); retrying before exit`);
    resolveStopping(reason);
    ipcSend({ type: 'stopping', reason });
    // No new connections from here on (the ones open now stay until step 4). The panel goes first: nothing can be
    // changed while the server stops.
    const httpClosed = new Promise<void>((r) => { http.close(() => r()); });
    if (upkeep) clearInterval(upkeep);
    upkeep = null;
    panelState?.close();
    const panelClosed = panel ? panel.close().catch((e: unknown) => log(`control panel close error: ${errMsg(e)}`)) : Promise.resolve();
    // 2. The notice, with time to read it (the game keeps running meanwhile; chat typed now is still logged).
    if (noticeMs > 0) {
      let told = 0;
      try {
        for (const p of zone.onlinePilots()) if (zone.tellPilot(p.playerId, STOP_NOTICE)) told++;
      } catch (e) { log(`shutdown notice error: ${errMsg(e)}`); }
      if (told) await sleep(noticeMs);
    }
    // 3. Leave every connection in the Zone now, while the profile store is still open: leave grants (a pilot's
    //    secured caches) commit and their lootGrant still reaches the open socket. Only then close the sockets.
    zone.stop();
    for (const td of [...teardowns.values()]) {
      try { td(); } catch (e) { log(`shutdown teardown error: ${errMsg(e)}`); }
    }
    teardowns.clear();
    // 4. Close the sockets.
    for (const c of wss.clients) {
      if (restart) c.close(WS_CLOSE_SERVICE_RESTART, closeReason(RESTART_CLOSE_REASON));
      else c.close(1001, 'server shutting down');
    }
    wss.close();
    // The maintenance worker (a quick index tidy when one is owed; bounded) and the settings.
    await panelClosed;
    try { unbindSettings?.(); } catch { /* closing */ }
    unbindSettings = null;
    const m = maint;
    const c = maintClient;
    maint = null;
    maintClient = null;
    if (m) await Promise.race([m.stop().catch((e: unknown) => log(`maintenance stop error: ${errMsg(e)}`)), sleep(MAINT_STOP_MS)]);
    else if (c) await Promise.race([c.close().catch(() => undefined), sleep(MAINT_STOP_MS)]);
    // 5–7. Profiles, moderation (a final chat flush: lines typed during the notice), accounts.
    if (chatSweep) clearInterval(chatSweep);
    chatSweep = null;
    closeStores();
    const s = settings;
    settings = null;
    if (s && !opts.settings) await s.close().catch(() => undefined);
    unsubscribeIpc?.();
    unsubscribeIpc = null;
    // Give close handshakes and in-flight requests a moment, then destroy what is left.
    await Promise.race([httpClosed, sleep(SOCKET_GRACE_MS)]);
    for (const c of wss.clients) c.terminate();
    http.closeAllConnections();
    await Promise.race([httpClosed, sleep(SOCKET_GRACE_MS)]);
    log('stopped');
  };

  const stop = (reason = 'stop', o: { restart?: boolean } = {}): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = runStop(reason, o.restart === true)
      .catch((e: unknown) => {
        log(`shutdown error: ${(e as Error)?.stack ?? e}`);
        closeStores();
      })
      .finally(() => resolveClosed());
    return stopPromise;
  };

  if (ipc) {
    try {
      unsubscribeIpc = ipc.onMessage((m) => {
        if (!m || typeof m !== 'object') return;
        const msg = m as { type?: unknown; reason?: unknown; restart?: unknown };
        if (msg.type === 'stop') void stop(typeof msg.reason === 'string' && msg.reason ? msg.reason.slice(0, 40) : 'launcher', { restart: msg.restart === true });
        else if (msg.type === 'status') ipcSend({ type: 'status', ...status() });
        else if (handleAdminIpcMessage(panel, m)) noteHostName();
      });
    } catch (e) {
      log(`WARNING: could not listen to the launcher: ${errMsg(e)}`);
    }
  }
  ipcSend({ type: 'ready', port: boundPort, bind, version: GAME_VERSION, accounts: !!auth, chatLog: !!mod, profiles: !!profiles, ...adminReadyFields(panel) });

  return {
    port: boundPort,
    bind,
    lan,
    dataDir,
    dbPath: auth ? dbPath : null,
    zone,
    http,
    log,
    ipc,
    get settings() { return settings; },
    get maint() { return maint; },
    get admin() { return panel; },
    get stopping() { return stopping; },
    whenStopping,
    closed,
    status,
    flushChat,
    checkpoint,
    stop,
  };
}

// ------------------------------------------------------------------------------------------
// Process integration
// ------------------------------------------------------------------------------------------

/** process.send / 'message' as a ServerIpc, or null when this process has no IPC channel. */
export function processIpc(proc: NodeJS.Process = process): ServerIpc | null {
  if (typeof proc.send !== 'function') return null;
  return {
    send(msg) {
      try { if (proc.connected) proc.send!(msg); } catch { /* the parent is gone */ }
    },
    onMessage(cb) {
      const fn = (m: unknown): void => { try { cb(m); } catch { /* a handler error must not kill the channel */ } };
      proc.on('message', fn);
      return () => { proc.off('message', fn); };
    },
  };
}

/** Exit with `code` once stdout / stderr have drained (a pipe to the launcher loses unflushed lines otherwise). */
export function exitProcess(code: number): void {
  process.exitCode = code;
  let waiting = 0;
  let done = false;
  const go = (): void => { if (!done) { done = true; process.exit(code); } };
  for (const s of [process.stdout, process.stderr]) {
    if (s && s.writableNeedDrain) { waiting++; s.once('drain', () => { if (--waiting <= 0) go(); }); }
  }
  const force = setTimeout(go, 250);
  force.unref?.();
  if (!waiting) setImmediate(go);
}

/** The signals that stop the server: Ctrl+C, kill, the console window's close button, Ctrl+Break. */
export const STOP_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];

export interface ProcessHandlerOptions {
  /** Default exitProcess (drains stdio, then process.exit). Tests pass a spy. */
  exit?: (code: number) => void;
  /** Forced exit this long after a stop began (default STOP_WATCHDOG_MS). */
  watchdogMs?: number;
  /** Default STOP_SIGNALS. */
  signals?: readonly NodeJS.Signals[];
}

export interface ProcessHandlers {
  /** What a stop signal does: stop() (flush first); a second signal while stopping exits at once (code 1). */
  onSignal(signal: NodeJS.Signals): void;
  /** What an uncaught exception does: log, flush the chat buffer, checkpoint, 'fatal' over IPC, exit 1. */
  onUncaught(err: unknown, origin?: string): void;
  /** Remove the process listeners and the watchdog (tests). */
  uninstall(): void;
}

/**
 * Make `server` own the process: stop on SIGINT / SIGTERM / SIGHUP / SIGBREAK, exit 0 when it has closed (whoever
 * stopped it: a signal, the launcher over IPC, the panel), force the exit STOP_WATCHDOG_MS after a stop began, and
 * turn an uncaught exception into "flush, exit 1" (the launcher restarts the child).
 */
export function installProcessHandlers(server: RunningServer, opts: ProcessHandlerOptions = {}): ProcessHandlers {
  const exit = opts.exit ?? exitProcess;
  const watchdogMs = opts.watchdogMs ?? STOP_WATCHDOG_MS;
  const signals = opts.signals ?? STOP_SIGNALS;
  const log = server.log;
  let exited = false;
  let removed = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;

  const signalFns: [NodeJS.Signals, () => void][] = [];
  const uninstall = (): void => {
    if (removed) return;
    removed = true;
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    for (const [s, fn] of signalFns) process.off(s, fn);
    process.off('uncaughtException', onUncaughtListener);
  };
  const done = (code: number): void => {
    if (exited) return;
    exited = true;
    uninstall();
    exit(code);
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (exited) return;
    if (server.stopping) {
      log(`${signal} again — exiting now`);
      try { server.flushChat(); } catch { /* never throws */ }
      done(EXIT_CRASH);
      return;
    }
    log(`${signal} received`);
    void server.stop(signal);
  };

  const onUncaught = (err: unknown, origin = 'uncaughtException'): void => {
    if (exited) return;
    const message = errMsg(err).slice(0, 300);
    try { log(`FATAL (${origin}): ${(err as Error)?.stack ?? err}`); } catch { /* the sink itself failed */ }
    try { server.zone.stop(); } catch { /* keep going: the flush matters more */ }
    try { server.flushChat(); } catch { /* never throws */ }
    try { server.checkpoint(); } catch { /* never throws */ }
    try { server.ipc?.send({ type: 'fatal', code: 'EUNCAUGHT', exitCode: EXIT_CRASH, message }); } catch { /* parent gone */ }
    done(EXIT_CRASH);
  };
  const onUncaughtListener = (err: Error, origin: string): void => onUncaught(err, origin);

  for (const s of signals) {
    const fn = (): void => onSignal(s);
    process.on(s, fn);
    signalFns.push([s, fn]);
  }
  process.on('uncaughtException', onUncaughtListener);

  void server.whenStopping.then(() => {
    if (exited || removed) return;
    watchdog = setTimeout(() => {
      log(`shutdown took longer than ${watchdogMs / 1000} s — forcing the exit`);
      try { server.flushChat(); } catch { /* never throws */ }
      done(EXIT_OK);
    }, watchdogMs);
    watchdog.unref?.();
  });
  void server.closed.then(() => { if (!removed) done(EXIT_OK); });

  return { onSignal, onUncaught, uninstall };
}

// ------------------------------------------------------------------------------------------
// LAN child boot (index.ts --lan)
// ------------------------------------------------------------------------------------------

/**
 * The launcher's first message to the child (`app/server.mjs --lan`, §2.2; src/lan/launch.ts builds it). Unknown
 * fields are ignored; the ones read here are validated (the child trusts the launcher, but not blindly).
 */
export interface LanStartMessage {
  type: 'lan:start';
  /** The data folder (required). */
  dataDir: string;
  port?: number;
  bind?: string;
  /** The built client (`web\`). */
  serveDir?: string;
  adminPageDir?: string;
  /** The projector page (`app\display`). */
  displayDir?: string;
  publicUrl?: string;
  primary?: string | null;
  preset?: 'home' | 'school';
  /** The admin listener's port A (the Host Control Panel, loopback). */
  adminPort?: number;
  /** Players may join (the game listener goes beyond loopback), and why not. */
  serveLan?: boolean;
  notServing?: string | null;
  /** data\secrets as base64 (never pipe.key): decodeBundle → memorySecrets. */
  secrets?: unknown;
  /** The first-run setup code (8 Crockford base32 characters). Never logged. */
  setupCode?: string;
  /** The launcher's findings for the panel's banners. */
  banners?: unknown;
  /** The launcher relays a maintenance process (maint/ipcTransport.ts). */
  maint?: boolean;
}

/** What parseLanStart gives: startServer options plus the secrets bundle (index.ts makes the store). */
export interface LanStart extends StartServerOptions {
  /** The launcher's secrets, validated (decodeBundle), or null when the message had none. */
  secretBundle: ReturnType<typeof decodeBundle> | null;
}

const SETUP_CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** The launcher's folder-permission banners (src/lan/launch.ts step 3): hidden while launcher.permissions is 'off'. */
export const PERMISSION_BANNERS: ReadonlySet<string> = new Set(['permissions', 'permissions-unchecked']);

/**
 * The launcher's banners as the panel gets them now. The list is fixed for this run (lan:start) but the setting is
 * live: once the host chose "Don't warn me again" (launcher.permissions = 'off') the folder-permission ones stop.
 */
export function launcherBanners(banners: readonly Banner[], permissions: string | undefined): Banner[] {
  const out: Banner[] = [];
  for (const b of banners) {
    if (permissions === 'off' && PERMISSION_BANNERS.has(b.code)) continue;
    out.push({ code: b.code, level: (b.level as string) === 'error' ? 'urgent' : b.level, text: b.text });
  }
  return out;
}

function lanBannersOf(v: unknown): Banner[] {
  if (!Array.isArray(v)) return [];
  const out: Banner[] = [];
  for (const b of v.slice(0, 40)) {
    if (!b || typeof b !== 'object') continue;
    const o = b as Record<string, unknown>;
    if (typeof o.code !== 'string' || typeof o.text !== 'string') continue;
    const level = o.level === 'urgent' || o.level === 'error' ? 'urgent' : o.level === 'info' ? 'info' : 'warn';
    out.push({ code: o.code.slice(0, 40), level, text: o.text.slice(0, 500) });
  }
  return out;
}

/** Validate a 'lan:start' message into startServer options (lan: {…}), or null when it is not one. */
export function parseLanStart(m: unknown): LanStart | null {
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if (o.type !== 'lan:start') return null;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
  const dataDir = str(o.dataDir);
  if (!dataDir) return null;
  const port = o.port === undefined ? undefined : Number(o.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) return null;
  const preset = o.preset === 'home' || o.preset === 'school' ? o.preset : undefined;
  const adminPort = o.adminPort === undefined ? undefined : Number(o.adminPort);
  if (adminPort !== undefined && (!Number.isInteger(adminPort) || adminPort < 0 || adminPort > 65535)) return null;
  let secretBundle: LanStart['secretBundle'] = null;
  if (o.secrets !== undefined) {
    try { secretBundle = decodeBundle(o.secrets); } catch { return null; }
  }
  const setupCode = typeof o.setupCode === 'string' && SETUP_CODE_SHAPE.test(o.setupCode) ? o.setupCode : null;
  const lanOpts: LanOptions = {
    ...(preset ? { preset } : {}),
    ...(adminPort !== undefined ? {
      admin: { port: adminPort, setupCode, ...(str(o.adminPageDir) ? { pageDir: str(o.adminPageDir) } : {}), ...(str(o.displayDir) ? { displayDir: str(o.displayDir) } : {}) },
    } : {}),
    maint: o.maint === true ? 'ipc' : false,
    ...(typeof o.serveLan === 'boolean' ? { serveLan: o.serveLan } : {}),
    notServing: typeof o.notServing === 'string' ? o.notServing.slice(0, 40) : null,
    banners: lanBannersOf(o.banners),
  };
  return {
    lan: lanOpts,
    dataDir,
    port,
    bind: str(o.bind),
    serveDir: str(o.serveDir),
    adminPageDir: str(o.adminPageDir),
    publicUrl: str(o.publicUrl),
    primary: typeof o.primary === 'string' ? o.primary : null,
    secretBundle,
  };
}

/**
 * Wait for the launcher's 'lan:start' (other message types are ignored). Rejects (EUSAGE) on a malformed
 * 'lan:start' at once, or after `timeoutMs` without one.
 */
export function waitForLanStart(ipc: ServerIpc, timeoutMs: number): Promise<LanStart> {
  return new Promise((resolve, rej) => {
    let off: (() => void) | null = null;
    const finish = (fn: () => void): void => { clearTimeout(timer); off?.(); fn(); };
    const timer = setTimeout(() => {
      finish(() => rej(new StartupError('EUSAGE', EXIT_USAGE, `The launcher did not send its start message within ${Math.round(timeoutMs / 1000)} s.`)));
    }, timeoutMs);
    off = ipc.onMessage((m) => {
      if (!m || typeof m !== 'object' || (m as { type?: unknown }).type !== 'lan:start') return;
      const parsed = parseLanStart(m);
      if (parsed) finish(() => resolve(parsed));
      else finish(() => rej(new StartupError('EUSAGE', EXIT_USAGE, "The launcher's start message is invalid (it needs a dataDir, and a port from 0 to 65535).")));
    });
  });
}
