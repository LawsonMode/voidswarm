// Static hosting (GitHub Pages): no game server on the page's own origin, so there is no default server.
// The general resolution + SEC-1 trust rules are pinned in netcode.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { defaultServerUrl, isStaticHost, isTrustedServerUrl, normalizeServerUrl, resolveServer } from './serverUrl';

const pages = (search = '', hostname = 'lawsonmode.github.io') =>
  ({ protocol: 'https:', hostname, host: hostname, port: '', search });
const selfHosted = (search = '') =>
  ({ protocol: 'https:', hostname: 'voidswarm.example.com', host: 'voidswarm.example.com', port: '', search });

describe('static hosting: server URL defaults (GitHub Pages)', () => {
  afterEach(() => { delete (globalThis as { VOIDSWARM_STATIC?: unknown }).VOIDSWARM_STATIC; });

  it('detects *.github.io and the explicit flags, nothing else', () => {
    for (const h of ['lawsonmode.github.io', 'LawsonMode.GitHub.io', 'someone.github.io.', 'github.io']) {
      expect(isStaticHost(pages('', h), false)).toBe(true);
    }
    for (const h of ['voidswarm.example.com', 'github.io.evil.com', 'notgithub.io', 'localhost', '192.168.1.5', '']) {
      expect(isStaticHost(pages('', h), false)).toBe(false);
    }
    expect(isStaticHost(selfHosted(), true)).toBe(true); // the Pages build on a custom domain
    expect(isStaticHost(selfHosted())).toBe(false); // vitest runs in mode 'test', no global flag
    (globalThis as { VOIDSWARM_STATIC?: unknown }).VOIDSWARM_STATIC = 'yes'; // only literal true counts
    expect(isStaticHost(selfHosted())).toBe(false);
    (globalThis as { VOIDSWARM_STATIC?: unknown }).VOIDSWARM_STATIC = true;
    expect(isStaticHost(selfHosted())).toBe(true);
    expect(defaultServerUrl(selfHosted())).toBe('');
  });

  it('has an empty default server instead of ws://<static host>:7777', () => {
    expect(defaultServerUrl(pages())).toBe('');
    expect(defaultServerUrl({ protocol: 'http:', hostname: 'box.lan', host: 'box.lan:8080', port: '8080', search: '' }, true)).toBe('');
    expect(resolveServer(pages(), null)).toEqual({ url: '', source: 'default', pending: null });
    expect(resolveServer(pages(), '  ')).toEqual({ url: '', source: 'default', pending: null });
    // unchanged for a page served by the game server itself
    expect(defaultServerUrl(selfHosted())).toBe('wss://voidswarm.example.com');
    expect(defaultServerUrl({ protocol: 'http:', hostname: 'localhost', host: 'localhost:5173', port: '5173', search: '' })).toBe('ws://localhost:7777');
  });

  it('a blank server never becomes a dialable URL', () => {
    // new WebSocket('') would resolve against the page (the static host itself); 'ws://' throws instead.
    expect(normalizeServerUrl('')).toBe('ws://');
    expect(normalizeServerUrl('   ')).toBe('ws://');
    expect(() => new URL('ws://')).toThrow();
    expect(normalizeServerUrl('play.example.com:7777')).toBe('ws://play.example.com:7777');
    // ...and a host-less value that got saved (a guest attempt with no server) is ignored next visit
    expect(resolveServer(pages(), 'ws://')).toEqual({ url: '', source: 'default', pending: null });
    expect(resolveServer(selfHosted(), 'ws://').url).toBe('wss://voidswarm.example.com');
  });

  it('keeps the saved server and ?server= working', () => {
    expect(resolveServer(pages(), 'wss://play.example.com')).toEqual({ url: 'wss://play.example.com', source: 'saved', pending: null });
    expect(resolveServer(pages('?server=localhost:7777'), null)).toEqual({ url: 'ws://localhost:7777', source: 'query', pending: null });
    expect(resolveServer(pages('?server=192.168.1.20:7777'), 'wss://play.example.com').source).toBe('query');
  });

  it('SEC-1 still holds: a non-local ?server= needs confirmation, and the page host earns no trust', () => {
    const r = resolveServer(pages('?server=wss://evil.example'), null);
    expect(r).toEqual({ url: '', source: 'default', pending: 'wss://evil.example' });
    const saved = resolveServer(pages('?server=wss://evil.example'), 'wss://play.example.com');
    expect(saved).toEqual({ url: 'wss://play.example.com', source: 'saved', pending: 'wss://evil.example' });
    // github.io runs no game server, so its own host (and every other *.github.io page) must be confirmed too
    expect(isTrustedServerUrl('wss://lawsonmode.github.io', pages())).toBe(false);
    expect(resolveServer(pages('?server=wss://lawsonmode.github.io'), null).pending).toBe('wss://lawsonmode.github.io');
    expect(resolveServer(pages('?server=wss://other.github.io'), null).pending).toBe('wss://other.github.io');
    expect(isTrustedServerUrl('ws://127.0.0.1:7777', pages())).toBe(true);
    // a self-hosted page still trusts its own host
    expect(isTrustedServerUrl('wss://voidswarm.example.com:9443', selfHosted())).toBe(true);
  });
});
