// LAN edition §4.15 / §8.2: the generated chat notice (GET /api/info → notice) shown at the top of the chat panel.
import { describe, expect, it } from 'vitest';
import { CHAT_NOTICE_MAX, chatNoticeText, fetchChatNotice } from './serverInfo';

const NOTICE = 'Chat is filtered and logged. Your teacher can read it. Lines are kept for 90 days. Ask your teacher for a copy or to delete it.';

describe('chat notice line', () => {
  it('keeps the server text as plain text: trimmed, one line, clipped', () => {
    expect(chatNoticeText(NOTICE)).toBe(NOTICE);
    expect(chatNoticeText(`  ${NOTICE.replace('. ', '.\n\n')}  `)).toBe(NOTICE);
    expect(chatNoticeText('<b>Chat</b> is logged')).toBe('<b>Chat</b> is logged'); // shown as text (textContent), not parsed
    expect(chatNoticeText(undefined)).toBe('');
    expect(chatNoticeText(42)).toBe('');
    expect(chatNoticeText('   ')).toBe('');
    const long = chatNoticeText('x'.repeat(CHAT_NOTICE_MAX + 50));
    expect(long).toHaveLength(CHAT_NOTICE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('GETs /api/info on the game server itself, with no credentials', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const text = await fetchChatNotice('https://10.0.0.5:7779', async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ ok: true, serverName: 'Room 136', notice: NOTICE, guests: false }) };
    });
    expect(text).toBe(NOTICE);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://10.0.0.5:7779/api/info');
    expect(calls[0]!.init).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store' });
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it('no notice from an older server (404 / 405), a bad body, or a failed request', async () => {
    expect(await fetchChatNotice('http://x', async () => ({ ok: false, json: async () => ({ error: 'Method not allowed' }) }))).toBe('');
    expect(await fetchChatNotice('http://x', async () => ({ ok: true, json: async () => ({ ok: true }) }))).toBe('');
    expect(await fetchChatNotice('http://x', async () => ({ ok: true, json: async () => null }))).toBe('');
    expect(await fetchChatNotice('http://x', async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }))).toBe('');
    expect(await fetchChatNotice('http://x', async () => { throw new TypeError('Failed to fetch'); })).toBe('');
  });
});
