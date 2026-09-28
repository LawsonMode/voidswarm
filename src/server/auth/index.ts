// OWNER: AUTH agent. Frozen public API — server/index.ts (ROOM agent) wires this in.
// HTTP contract + rules: see the "Accounts" block in src/shared/protocol.ts and ARCHITECTURE.md §3b.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccountInfo } from '../../shared/protocol';
import { sha256Hex } from './crypto';
import { createAuthServiceWith } from './service';

/**
 * The hash onSessionsRevoked reports for a session: sha256 hex of the raw session token. The server
 * stores this (never the raw token) per ws connection to match a single-session logout.
 */
export function sessionTokenHash(token: string): string {
  return sha256Hex(token);
}

export interface AuthService {
  /** Handle `/api/*` (incl. CORS preflight). Returns true if the request was handled. */
  handleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** Resolve a session token to its account (null if unknown/expired). */
  verifyToken(token: string): Promise<AccountInfo | null>;
  /** Case-insensitive: is this name a registered username? (sync; guests may not use these). */
  isRegisteredUsername(name: string): boolean;
  /**
   * Register a listener fired when an account's sessions are revoked (password reset → all sessions;
   * logout → that session; also a session dropped as the oldest beyond the per-account cap). The
   * server uses it to kick live WebSocket connections authenticated with a revoked session.
   * `sessionTokenHash` is sessionTokenHash(token) (sha256 hex of the raw token), or null when ALL of
   * the account's sessions were revoked. Fired synchronously after the DB change has committed; a
   * throwing listener is logged and does not affect the request.
   */
  onSessionsRevoked(cb: (accountId: string, sessionTokenHash: string | null) => void): void;
  close(): void;
}

export interface AuthOptions {
  /** e.g. 'data/voidswarm.db' (directory is created if missing). */
  dbPath: string;
  /** Base URL used in reset links, e.g. 'https://voidswarm.example.com' or 'http://localhost:5173'. */
  publicUrl: string;
  /** Allowed CORS origins for the API ('*' in dev). */
  corsOrigins: string[] | '*';
  log: (line: string) => void;
}

/**
 * SQLite-backed account service (see ./service.ts). Reads SMTP_* and TRUST_PROXY from process.env;
 * env docs in ./README.md.
 */
export function createAuthService(opts: AuthOptions): AuthService {
  return createAuthServiceWith(opts);
}
