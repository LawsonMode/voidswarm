// OWNER: ROOM agent. Node WebSocket game server: JSON text frames <-> ClientMsg/ServerMsg, binary snapshots,
// plus the accounts HTTP API (AUTH agent's AuthService) and optional static hosting of the built client.
//   tsx src/server/index.ts [--serve <dir>]
//   env: PORT, BIND (listen address, default 0.0.0.0 — use 127.0.0.1 behind a local reverse proxy),
//        DB_PATH, PUBLIC_URL, SMTP_* (see ARCHITECTURE.md §3b),
//        CORS_ORIGINS (comma-separated allowlist for cross-origin clients; unset = PUBLIC_URL + this
//          machine's dev client on :5173/:4173 only; '*' = any origin),
//        TRUST_PROXY=1 (+ optional TRUSTED_PROXIES) — X-Forwarded-For is only believed from a proxy on
//          loopback / the local network (or listed), so direct clients cannot forge their address,
//        MAX_CONNECTIONS (default 512), MAX_CONN_PER_IP (default 64; new connections per address are
//          also rate limited: burst 64, then 1/s).
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { hostname, networkInterfaces } from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { DEFAULT_PORT, SNAPSHOT_EVERY_ONLINE } from '../shared/constants';
import { WS_CLOSE_KICKED } from '../shared/net/closeCodes';
import { encodeSnapshot } from '../shared/net/codec';
import { validateClientMsg } from '../shared/net/validate';
import type { ProfileStore } from '../shared/profile/store';
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { houseRooms } from '../shared/room/houseRooms';
import { Zone, type ClientSink } from '../shared/room/Zone';
import { GAME_VERSION, PROTOCOL_VERSION } from '../shared/version';
import { createAuthService, type AuthService } from './auth/index';
import { createSqliteProfileStore } from './profile/sqliteProfiles';
import {
  ConnectionGate, EventCarry, SESSION_ENDED_MSG, SessionRegistry, clientAddressKey, createFrameCache,
  defaultCorsOrigins, isTrustedProxyPeer, parseProxyTrust, resolveCorsOrigins,
} from './netguard';
import { createStaticHandler } from './static';

const MAX_MSG_BYTES = 4096;
/** Snapshots are skipped (their global events carried over) while more than this is queued on the socket. */
const MAX_BUFFERED = 256 * 1024;
/** A client this far behind on reliable JSON messages is not reading: drop the connection. */
const MAX_BUFFERED_TEXT = 2 * 1024 * 1024;
const PING_INTERVAL_MS = 5000;
/** Messages held while a hello's token is verified (beyond this, extras are dropped). */
const MAX_PENDING = 256;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function envInt(name: string, dflt: number, min: number): number {
  const n = Math.floor(Number(process.env[name]));
  return Number.isFinite(n) && n >= min ? n : dflt;
}

const port = Number(process.env.PORT) || DEFAULT_PORT;
const bindHost = process.env.BIND?.trim() || '0.0.0.0';
const serveDir = arg('--serve');
const ts = (): string => new Date().toISOString().slice(11, 19);
const log = (line: string): void => console.log(`${ts()} ${line}`);
const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
/** A WebSocket close reason must fit in 123 UTF-8 bytes (ws throws otherwise). */
const closeReason = (s: string): string => {
  let r = s.slice(0, 100);
  while (Buffer.byteLength(r, 'utf8') > 123) r = r.slice(0, -1);
  return r;
};

const proxyTrust = parseProxyTrust(process.env);
const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;
const corsOrigins = resolveCorsOrigins(process.env.CORS_ORIGINS, () => defaultCorsOrigins(publicUrl, networkInterfaces(), [hostname()]));

// Accounts are optional infrastructure: if the auth service can't start, everyone plays as a guest.
const dbPath = process.env.DB_PATH || 'data/voidswarm.db';
let auth: AuthService | null = null;
try {
  auth = createAuthService({
    dbPath,
    publicUrl,
    corsOrigins,
    log, // auth lines already carry an "[auth]" prefix
  });
} catch (e) {
  auth = null;
  log(`WARNING: accounts disabled (auth service failed to start: ${(e as Error)?.message ?? e}). Everyone plays as a guest.`);
}

// v0.3 loot profiles (docs/v0.3-proposal.md §7.2): a second connection on the auth DB, opened AFTER the AuthService
// (which migrates the schema). No accounts = no store (guests keep their loot on their device). If it can't open,
// account pilots still get a session-only profile ("Loot won't be saved this session").
let profiles: ProfileStore | undefined;
if (auth) {
  try {
    profiles = createSqliteProfileStore(dbPath, { log });
  } catch (e) {
    profiles = undefined;
    log(`WARNING: loot profiles are not saved this session (profile store failed to open: ${(e as Error)?.message ?? e}).`);
  }
}
if (auth) {
  log(corsOrigins === '*'
    ? 'WARNING: CORS_ORIGINS=* — any website may call the accounts API from its visitors\' browsers.'
    : `accounts API: cross-origin allowed for ${corsOrigins.length} origin(s) (+ same-origin); set CORS_ORIGINS to change`);
}

const zone = new Zone({
  snapshotEvery: SNAPSHOT_EVERY_ONLINE,
  local: false,
  motd: `Welcome to Voidswarm v${GAME_VERSION}. Pick a game type and hit Quick Play, or type /help for commands.`,
  // v0.3 house rooms, each only while its sub-mode is `ready` (The Descent, Flag Run, Hot Points, Duel Pit, Warzone
  // Classic — docs/v0.3-proposal.md section 3.3; houseRooms() skips the rest, so The Descent opens once `coop` is ready)
  defaultRooms: houseRooms(false),
  log,
  isReservedName: (n) => {
    try { return auth ? auth.isRegisteredUsername(n) : false; } catch { return false; }
  },
  // Off by default (classrooms / households share one address); set 1 for public internet hosting.
  blockSameNetworkWatch: process.env.WATCH_SAME_NETWORK_BLOCK === '1',
  profiles,
});

/** Live ws connections authenticated with a session, so a logout / password reset can end them. */
const sessions = new SessionRegistry<{ kick(reason: string): void }>();
if (auth && typeof auth.onSessionsRevoked === 'function') {
  try {
    auth.onSessionsRevoked((accountId, sessionTokenHash) => {
      const hit = sessions.revoke(accountId, sessionTokenHash);
      for (const h of hit) {
        try { h.kick(SESSION_ENDED_MSG); } catch (e) { log(`session kick error: ${(e as Error)?.message ?? e}`); }
      }
      if (hit.length) log(`session revoked: ended ${hit.length} live connection(s)`);
    });
  } catch (e) {
    log(`WARNING: could not subscribe to session revocations: ${(e as Error)?.message ?? e}`);
  }
}

// Per-address caps are generous on purpose: a classroom behind one NAT address shares them.
const gate = new ConnectionGate({
  maxTotal: envInt('MAX_CONNECTIONS', 512, 1),
  maxPerAddress: envInt('MAX_CONN_PER_IP', 64, 1),
  burst: 64,
  perSec: 1,
});

const staticHandler = serveDir ? createStaticHandler(serveDir) : null;

const http = createServer((req, res) => {
  // A forged X-Forwarded-For from a client that reached us directly must not steer per-IP limits.
  if (proxyTrust.enabled && !isTrustedProxyPeer(req.socket.remoteAddress, proxyTrust)) delete req.headers['x-forwarded-for'];
  void (async () => {
    try {
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
  })();
});

const wss = new WebSocketServer({ server: http, maxPayload: 64 * 1024 });

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
    if (auth && typeof hello.token === 'string' && hello.token) {
      const token = hello.token;
      try {
        const acc = await auth.verifyToken(token);
        conn.setAccount(acc);
        invalid = !acc;
        if (acc && !closed) {
          forgetSession = sessions.add(acc.accountId, sha256Hex(token), { kick: (r) => conn.kick(r) });
        }
      } catch (e) {
        log(`verifyToken error (${addr}): ${(e as Error)?.message ?? e}`);
        conn.setAccount(null);
        invalid = true;
      }
    } else {
      conn.setAccount(null);
    }
    if (closed) return;
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
    try { conn.close(); } catch (e) { log(`close error: ${(e as Error)?.message ?? e}`); }
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

http.listen(port, bindHost, () => {
  log(`Voidswarm v${GAME_VERSION} listening on ${bindHost}:${port}${serveDir ? ` (serving ${serveDir})` : ''}${auth ? ` — accounts on${profiles ? ', loot saved' : ', loot NOT saved'}` : ' — guests only'}`);
  if (proxyTrust.enabled && bindHost !== '127.0.0.1' && bindHost !== '::1' && bindHost !== 'localhost') {
    log('note: TRUST_PROXY is on and the port is reachable from other hosts — X-Forwarded-For is only trusted from local-network peers (set BIND=127.0.0.1 behind a local proxy)');
  }
  zone.start();
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  log('shutting down...');
  zone.stop();
  // Leave every connection in the Zone now, while the profile store is still open: leave grants (a pilot's secured
  // caches) commit and their lootGrant still reaches the open socket. Only then close the sockets.
  for (const td of [...teardowns.values()]) {
    try { td(); } catch (e) { log(`shutdown teardown error: ${(e as Error)?.message ?? e}`); }
  }
  teardowns.clear();
  for (const c of wss.clients) c.close(1001, 'server shutting down');
  wss.close();
  // Every Zone connection is gone (no more grants): close the profile connection first, then the AuthService's.
  try { profiles?.close?.(); } catch (e) { log(`profile store close error: ${(e as Error)?.message ?? e}`); }
  try { auth?.close(); } catch (e) { log(`auth close error: ${(e as Error)?.message ?? e}`); }
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
