// LAN edition §4.15 / §5.15: the chat notice from `GET /api/info` ("Chat is filtered and logged. Your teacher can
// read it… Lines are kept for 90 days…"), shown at the top of the Command and room-lobby chat panels.
// Only `notice` is read here; the signup screens (accounts.ts) read the rest of /api/info. An older server (no
// /api/info: 404 / 405), a static host, a failed or slow request: no notice, and nothing else changes.

/** The notice is the server's text: shown as plain text, never longer than this. */
export const CHAT_NOTICE_MAX = 600;
const INFO_TIMEOUT_MS = 5000;

/** The server's chat notice as shown: whitespace collapsed, clipped to CHAT_NOTICE_MAX; '' = no notice line. */
export function chatNoticeText(notice: unknown): string {
  if (typeof notice !== 'string') return '';
  const t = notice.replace(/\s+/g, ' ').trim();
  return t.length > CHAT_NOTICE_MAX ? `${t.slice(0, CHAT_NOTICE_MAX - 1)}…` : t;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>;

/**
 * `GET <apiBase>/api/info` → its `notice` (chatNoticeText), or '' on any failure. `apiBase` comes from
 * accounts.apiBaseFromServerUrl (the game server's own http(s) origin). Never throws; sends no credentials.
 */
export async function fetchChatNotice(apiBase: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<string> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), INFO_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${apiBase}/api/info`, {
      method: 'GET', credentials: 'omit', cache: 'no-store', signal: ctrl?.signal,
    });
    if (!res.ok) return '';
    const data: unknown = await res.json();
    return data && typeof data === 'object' ? chatNoticeText((data as { notice?: unknown }).notice) : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}
