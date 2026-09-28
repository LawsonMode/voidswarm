// Accounts HTTP API client (see protocol.ts → Accounts). Online only; offline mode never calls this.
// Passwords are only ever placed in request bodies — never logged, never stored.
import { PASSWORD_MIN, USERNAME_RE, type AccountInfo, type AuthResponse } from '../../shared/protocol';
import { loadJSON, saveJSON, saveStr } from '../storage';

const TIMEOUT_MS = 10000;

/** ws://host:port/path → http://host:port (wss → https). Null if the URL is unusable. */
export function apiBaseFromServerUrl(serverUrl: string): string | null {
  let u: URL;
  try { u = new URL(serverUrl.trim()); } catch { return null; }
  let proto: string;
  switch (u.protocol) {
    case 'ws:': case 'http:': proto = 'http:'; break;
    case 'wss:': case 'https:': proto = 'https:'; break;
    default: return null;
  }
  if (!u.host) return null;
  return `${proto}//${u.host}`;
}

/** Hostnames where an unencrypted connection is acceptable (this machine or a private LAN). */
export function isLocalOrLan(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;
  if (h.includes(':')) {
    // IPv6 literal: loopback, link-local, unique-local (fc00::/7).
    return h === '::1' || h.startsWith('fe80:') || /^f[cd][0-9a-f]{0,2}:/.test(h);
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  // Single-label names (e.g. "bat-computer") are LAN hosts.
  return !h.includes('.') && h.length > 0;
}

/** True when the server URL is plain ws:// (or http://) to a host that is not local/LAN. */
export function isInsecureRemote(serverUrl: string): boolean {
  let u: URL;
  try { u = new URL(serverUrl.trim()); } catch { return false; }
  if (u.protocol !== 'ws:' && u.protocol !== 'http:') return false;
  return !isLocalOrLan(u.hostname);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RegistrationInput { username: string; email: string; password: string; confirm: string }

/** Client-side registration validation. Returns a user-facing error, or null when valid. */
export function validateRegistration(r: RegistrationInput): string | null {
  const username = r.username.trim();
  if (!USERNAME_RE.test(username)) return 'Username must be 3–16 characters: letters, numbers, _ or -.';
  const email = r.email.trim();
  if (!EMAIL_RE.test(email) || email.length > 254) return 'Please enter a valid email address.';
  return validateNewPassword(r.password, r.confirm);
}

export function validateNewPassword(password: string, confirm: string): string | null {
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (password !== confirm) return 'Passwords do not match.';
  return null;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'ApiError'; }
}

export class AccountsApi {
  constructor(readonly base: string) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl?.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl?.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      throw new ApiError(`Can't reach the account server at ${this.base}.`, 0);
    } finally {
      clearTimeout(timer);
    }
    let data: unknown = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const msg = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : res.status === 404 ? 'This server has no account service.' : `Account server error (HTTP ${res.status}).`;
      throw new ApiError(msg, res.status);
    }
    if (data === null) throw new ApiError('Account server sent an invalid response.', res.status);
    return data as T;
  }

  register(username: string, email: string, password: string): Promise<AuthResponse> {
    return this.post('/api/register', { username: username.trim(), email: email.trim(), password });
  }
  login(login: string, password: string): Promise<AuthResponse> {
    return this.post('/api/login', { login: login.trim(), password });
  }
  logout(token: string): Promise<{ ok: true }> {
    return this.post('/api/logout', { token });
  }
  me(token: string): Promise<{ account: AccountInfo }> {
    return this.post('/api/me', { token });
  }
  forgot(email: string): Promise<{ ok: true }> {
    return this.post('/api/forgot', { email: email.trim() });
  }
  reset(resetToken: string, password: string): Promise<AuthResponse> {
    return this.post('/api/reset', { resetToken, password });
  }
}

// ---------------------------------------------------------------------------------------------
// Session persistence (token is tied to the API base that issued it)
// ---------------------------------------------------------------------------------------------

export interface StoredSession { token: string; apiBase: string; username: string }

const SESSION_KEY = 'voidswarm.session';

export function loadSession(): StoredSession | null {
  const s = loadJSON<Partial<StoredSession> | null>(SESSION_KEY, null);
  if (!s || typeof s.token !== 'string' || !s.token || typeof s.apiBase !== 'string') return null;
  return { token: s.token, apiBase: s.apiBase, username: typeof s.username === 'string' ? s.username : '' };
}

export function saveSession(s: StoredSession): void {
  saveJSON(SESSION_KEY, s);
}

export function clearSession(): void {
  saveStr(SESSION_KEY, '');
}

/** Server error text that means our token is no longer valid. */
export const SESSION_EXPIRED_MSG = 'Session expired — please log in again';
/** Sent (then the socket is closed with WS_CLOSE_KICKED) when our session was revoked: logout elsewhere / password reset. */
export const SESSION_ENDED_MSG = 'Session ended — please log in again';

/** Does this server message mean our stored token is dead ("Session expired…" / "Session ended…")? Forget it then. */
export function isSessionExpiredMessage(msg: string): boolean {
  const m = msg.trim().toLowerCase();
  return m.startsWith('session expired') || m.startsWith('session ended');
}
