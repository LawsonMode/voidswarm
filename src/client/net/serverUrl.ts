import { DEFAULT_PORT } from '../../shared/constants';

export interface LocationLike { protocol: string; hostname: string; host: string; port: string; search: string }

/** Shown when a static-hosted page (GitHub Pages) has no game server to connect to yet. */
export const NO_SERVER_HINT = 'No game server set: open "Server…" and enter a wss:// address, or play offline vs bots.';

/**
 * Build-time or page-level "static host" flag: the `npm run build:pages` build (vite --mode pages), or a
 * page that sets `window.VOIDSWARM_STATIC = true` before the client loads (any other static host).
 */
function staticHostFlag(): boolean {
  try { if ((globalThis as { VOIDSWARM_STATIC?: unknown }).VOIDSWARM_STATIC === true) return true; } catch { /* no global */ }
  try { return import.meta.env.MODE === 'pages'; } catch { return false; }
}

/**
 * True when this page comes from a static host with no game server on its own origin: GitHub Pages
 * (*.github.io), the Pages build, or window.VOIDSWARM_STATIC. Such a page has no default server.
 */
export function isStaticHost(loc: LocationLike, flagged: boolean = staticHostFlag()): boolean {
  const h = (loc.hostname || '').toLowerCase().replace(/\.$/, '');
  return flagged || h === 'github.io' || h.endsWith('.github.io');
}

/**
 * Default ws URL for the server that served this page:
 * - a static host (GitHub Pages, see isStaticHost) → '' — there is no game server there, so the player
 *   must enter one under "Server…" (or play offline); never ws://<static host>:DEFAULT_PORT;
 * - `npm start` serves the page on DEFAULT_PORT → same host and port;
 * - an https page on the default port (reverse proxy / tunnel) → wss:// on the same origin;
 * - anything else (e.g. the Vite dev server) → ws://<hostname>:DEFAULT_PORT.
 */
export function defaultServerUrl(loc: LocationLike, staticHost: boolean = isStaticHost(loc)): string {
  if (staticHost) return '';
  const secure = loc.protocol === 'https:';
  if (loc.port === String(DEFAULT_PORT)) return `${secure ? 'wss' : 'ws'}://${loc.host}`;
  if (secure && (loc.port === '' || loc.port === '443')) return `wss://${loc.host}`;
  return `ws://${loc.hostname || 'localhost'}:${DEFAULT_PORT}`;
}

/**
 * Accepts "host:port", "http(s)://..", "ws(s)://.." and returns a ws(s) URL. A blank value becomes the
 * host-less (invalid) "ws://" on purpose: `new WebSocket('')` would resolve against the page URL and
 * dial the static host itself, while "ws://" makes the WebSocket constructor throw — no socket at all.
 */
export function normalizeServerUrl(s: string): string {
  s = s.trim();
  if (/^wss?:\/\//i.test(s)) return s;
  if (/^https:\/\//i.test(s)) return 'wss://' + s.slice(8);
  if (/^http:\/\//i.test(s)) return 'ws://' + s.slice(7);
  return 'ws://' + s;
}

/** Host (with port) of a server URL for display, or '' when the URL is unusable. */
export function serverHost(url: string): string {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'ws:' || u.protocol === 'wss:' || u.protocol === 'http:' || u.protocol === 'https:' ? u.host : '';
  } catch { return ''; }
}

function hostnameOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
    return u.hostname ? u.hostname.toLowerCase().replace(/^\[|\]$/g, '') : null;
  } catch { return null; }
}

/**
 * This machine or a private network address: localhost / *.localhost, loopback, RFC 1918, link-local,
 * IPv6 loopback / link-local / unique-local, and the non-routable *.local (mDNS) and *.home.arpa names.
 * Deliberately stricter than accounts.isLocalOrLan: a bare single-label name is not trusted here.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.home.arpa')) return true;
  if (h.includes(':')) return h === '::1' || h.startsWith('fe80:') || /^f[cd][0-9a-f]{0,2}:/.test(h);
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/**
 * A server URL that may be used without asking: the page's own host (any port — the Vite page and
 * the game server share a host in dev) or a private/local address. On a static host (GitHub Pages)
 * the page's host runs no game server, so only private/local addresses qualify there.
 */
export function isTrustedServerUrl(url: string, loc: LocationLike, staticHost: boolean = isStaticHost(loc)): boolean {
  const h = hostnameOf(url);
  if (!h) return false;
  const page = staticHost ? '' : (loc.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return (page !== '' && h === page) || isPrivateHost(h);
}

export interface ResolvedServer {
  /** URL to use now: a trusted ?server= value, else the saved one, else the default. */
  url: string;
  source: 'query' | 'saved' | 'default';
  /**
   * An untrusted ?server= value. It must NOT be used (no login, no session token, no connection)
   * until the user explicitly confirms it.
   */
  pending: string | null;
}

/**
 * Precedence: a trusted ?server= param > saved value > default. An untrusted ?server= (someone else's
 * host) never wins on its own: it comes back as `pending` for the title screen to confirm. A ?server=
 * value is never meant to be persisted (see TitleScreen.isPersistable). On a static host the default
 * is '' (no server), so a page with neither a saved nor a ?server= value starts with no server set.
 */
export function resolveServer(loc: LocationLike, saved: string | null, staticHost: boolean = isStaticHost(loc)): ResolvedServer {
  let q: string | null = null;
  try { q = new URLSearchParams(loc.search).get('server'); } catch { q = null; }
  // A saved value without a host (e.g. "ws://" saved by a guest attempt with no server set) is ignored.
  const savedUrl = saved && saved.trim() ? normalizeServerUrl(saved.trim()) : '';
  const fallback: ResolvedServer = savedUrl && hostnameOf(savedUrl)
    ? { url: savedUrl, source: 'saved', pending: null }
    : { url: defaultServerUrl(loc, staticHost), source: 'default', pending: null };
  if (!q || !q.trim()) return fallback;
  const url = normalizeServerUrl(q.trim());
  if (!hostnameOf(url)) return fallback;
  if (isTrustedServerUrl(url, loc, staticHost)) return { url, source: 'query', pending: null };
  return { ...fallback, pending: url };
}
