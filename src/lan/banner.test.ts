import { describe, expect, it } from 'vitest';
import {
  MAX_BANNER_NOTES, bannerLines, clockTime, consoleSafe, displayPath, formatBanner, formatSetupCode, noticeLine, restartNotice,
  shortFingerprint, windowTitle, type BannerInfo,
} from './banner';

const winEnv = { USERPROFILE: 'C:\\Users\\capta' };
const base: BannerInfo = {
  version: '0.6.0',
  panelUrl: 'http://localhost:7778/',
  gamePort: 7777,
  primary: '192.168.1.50',
  notServing: null,
  dataDir: 'C:\\Users\\capta\\Voidswarm LAN\\data',
  env: winEnv,
  platform: 'win32',
};

describe('banner (§5.1)', () => {
  it('matches the spec layout: panel, the canonical pair, certificate, data folder, setup code, stop tip', () => {
    const lines = bannerLines({
      ...base,
      https: true,
      certificate: { rootNumber: 1, fingerprint: '3F9A' + '00'.repeat(29) + 'C2', scope: "this PC's address only" },
      setupCode: 'K7QP4MXD',
    });
    expect(lines).toEqual([
      ' VOIDSWARM LAN HOST 0.6.0 — keep this running (closing it stops the game)',
      '',
      ' Host Control Panel (this PC):  http://localhost:7778',
      ' Players join at:               http://192.168.1.50:7777   (start page)',
      '                                https://192.168.1.50:7777  (secure)',
      " Certificate:                   root #1  SHA-256 3F:9A:…:C2   (this PC's address only)",
      ' Data folder:                   C:\\Users\\…\\Voidswarm LAN\\data',
      ' First run — setup code:        K7QP-4MXD   (already filled in on the setup page)',
      " Stop: Ctrl+C here, or Stop in the control panel. Tip: don't click inside this window.",
    ]);
  });

  it('without TLS (M1) there is no https line and no certificate line; no setup code after setup', () => {
    const text = formatBanner(base);
    expect(text).toContain('http://192.168.1.50:7777');
    expect(text).not.toContain('https://');
    expect(text).not.toContain('Certificate');
    expect(text).not.toContain('setup code');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('says why players cannot join instead of printing an address', () => {
    const say = (notServing: BannerInfo['notServing']) => bannerLines({ ...base, notServing }).find((l) => l.startsWith(' Players join at:'))!;
    expect(say('setup')).toContain('after setup');
    expect(say('public-network')).toContain('Public');
    expect(say('no-address')).toContain('no network address');
    expect(say('unapproved-network')).toContain('approve');
    expect(bannerLines({ ...base, primary: null }).join('\n')).toContain('no network address');
    for (const r of ['setup', 'public-network', 'no-address'] as const) expect(bannerLines({ ...base, notServing: r }).join('\n')).not.toContain('192.168.1.50');
  });

  it('prints at most a few short notes (the full texts are on the panel)', () => {
    const notes = Array.from({ length: 9 }, (_, i) => `note ${i} ${'x'.repeat(200)}`);
    const lines = bannerLines({ ...base, notes });
    const shown = lines.filter((l) => l.startsWith(' ! '));
    expect(shown).toHaveLength(MAX_BANNER_NOTES + 1);
    expect(shown[0].length).toBeLessThanOrEqual(3 + 110);
    expect(shown.at(-1)).toContain('3 more');
    expect(bannerLines({ ...base, notes: ['two\nlines'] }).find((l) => l.startsWith(' ! '))).toBe(' ! two lines');
  });

  it('never shows the Windows account name in the data folder', () => {
    expect(displayPath('C:\\Users\\capta\\Voidswarm LAN\\data', { env: winEnv, platform: 'win32' })).toBe('C:\\Users\\…\\Voidswarm LAN\\data');
    expect(displayPath('c:\\users\\CAPTA\\Voidswarm LAN\\data', { env: winEnv, platform: 'win32' })).not.toMatch(/capta/i);
    expect(displayPath('D:\\Games\\Voidswarm LAN\\data', { env: winEnv, platform: 'win32' })).toBe('D:\\Games\\Voidswarm LAN\\data');
    expect(displayPath('/home/pat/Voidswarm LAN/data', { env: { HOME: '/home/pat' }, platform: 'linux' })).toBe('/home/…/Voidswarm LAN/data');
    const long = displayPath('C:\\Users\\capta\\AppData\\Local\\Some\\Very\\Deep\\Folder\\Structure\\That\\Goes\\On\\Voidswarm LAN\\data', { env: winEnv, platform: 'win32' });
    expect(long.length).toBeLessThanOrEqual(70);
    expect(long).toMatch(/Voidswarm LAN\\data$/);
    expect(long).not.toMatch(/capta/i);
  });

  it('formats the setup code and the fingerprint', () => {
    expect(formatSetupCode('k7qp4mxd')).toBe('K7QP-4MXD');
    expect(formatSetupCode('K7QP-4MXD')).toBe('K7QP-4MXD');
    expect(shortFingerprint('3f:9a:11:22:c2')).toBe('3F:9A:…:C2');
  });
});

describe('window title and notices', () => {
  it('is "Voidswarm Host · 12 online · 3 rooms · 192.168.1.50:7777"', () => {
    expect(windowTitle({ state: 'running', online: 12, rooms: 3, primary: '192.168.1.50', gamePort: 7777 })).toBe('Voidswarm Host · 12 online · 3 rooms · 192.168.1.50:7777');
    expect(windowTitle({ state: 'running', online: 1, rooms: 1, primary: '192.168.1.50', gamePort: 7777 })).toBe('Voidswarm Host · 1 online · 1 room · 192.168.1.50:7777');
    expect(windowTitle({ state: 'running', online: 0, primary: null, gamePort: 7777, notServing: true })).toBe('Voidswarm Host · 0 online · this PC only (:7777)');
    expect(windowTitle({ state: 'starting', gamePort: 7777, primary: '10.0.0.5' })).toBe('Voidswarm Host · starting… · 10.0.0.5:7777');
    expect(windowTitle({ state: 'stopping' })).toBe('Voidswarm Host · stopping…');
  });

  it('restart notice and one-line notices use the local HH:MM', () => {
    const at = new Date(2026, 8, 28, 10, 14, 59);
    expect(clockTime(at)).toBe('10:14');
    expect(restartNotice(at)).toBe('The server restarted after an error at 10:14.');
    expect(noticeLine('New network\n  192.168.2.0/24', at)).toBe('10:14 New network 192.168.2.0/24');
    expect(noticeLine('\u001b[2J\u001b[1;1H spoof\u0007', at)).toBe('10:14 [2J[1;1H spoof');
  });

  it('consoleSafe: no C0 / C1 controls or bidi overrides; line breaks only when asked', () => {
    expect(consoleSafe('a\u001b[31mb\u009b0m\u0000c\u007f‮d⁦e')).toBe('a[31mb0mcde');
    expect(consoleSafe('one\r\ntwo\n\tthree')).toBe('one two three');
    expect(consoleSafe('one\r\ntwo\rthree', true)).toBe('one\ntwo\nthree');
    expect(consoleSafe('Players — K7QP-4MXD …')).toBe('Players — K7QP-4MXD …');
  });
});
