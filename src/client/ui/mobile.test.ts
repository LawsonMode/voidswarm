import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  canFullscreen, countPads, fullscreenButtonVisible, isFullscreen, isMobileLike, isStandalone, NARROW_SCREEN_PX,
  padPromptReducer, padPromptVisible, playFullscreen, readMobileEnv, rotateOverlayVisible,
  type EnvSource, type MobileEnv, type MobileScreen, type PadPromptEvent, type PadPromptState,
} from './mobile';

const env = (over: Partial<MobileEnv>): MobileEnv => ({
  coarsePointer: false, anyFinePointer: true, anyHover: true, touchPoints: 0, screenWidth: 1920, screenHeight: 1080, ...over,
});
const PHONE = env({ coarsePointer: true, anyFinePointer: false, anyHover: false, touchPoints: 5, screenWidth: 390, screenHeight: 844 });
const TABLET = env({ coarsePointer: true, anyFinePointer: false, anyHover: false, touchPoints: 5, screenWidth: 820, screenHeight: 1180 });
const DESKTOP = env({});
const LEGACY = { coarsePointer: null, anyFinePointer: null, anyHover: null } as const;

describe('isMobileLike', () => {
  it('phones and tablets without a mouse are mobile-like', () => {
    expect(isMobileLike(PHONE)).toBe(true);
    expect(isMobileLike(TABLET)).toBe(true);
    // landscape: the screen size does not matter when the pointer features answer
    expect(isMobileLike({ ...PHONE, screenWidth: 844, screenHeight: 390 })).toBe(true);
  });

  it('a desktop with a mouse never is, whatever its window or screen size', () => {
    expect(isMobileLike(DESKTOP)).toBe(false);
    expect(isMobileLike(env({ screenWidth: 375, screenHeight: 667 }))).toBe(false);
  });

  it('a mouse / trackpad anywhere wins over touch: touch laptops, tablets with a trackpad, coarse misreports', () => {
    expect(isMobileLike(env({ touchPoints: 10 }))).toBe(false); // touch-screen laptop
    expect(isMobileLike(env({ coarsePointer: true, touchPoints: 10 }))).toBe(false); // tablet mode + mouse / iPad + Magic Keyboard
  });

  it('touch points with no fine pointer and no hover count even when the primary pointer is not reported coarse', () => {
    expect(isMobileLike(env({ coarsePointer: false, anyFinePointer: false, anyHover: false, touchPoints: 5 }))).toBe(true);
    // a fine pointer (pen) or hover next to the touch screen: not mobile-like
    expect(isMobileLike(env({ coarsePointer: false, anyFinePointer: true, anyHover: false, touchPoints: 5 }))).toBe(false);
    expect(isMobileLike(env({ coarsePointer: false, anyFinePointer: false, anyHover: true, touchPoints: 5 }))).toBe(false);
  });

  it('no touch and no mouse (a TV / console browser) is not mobile-like', () => {
    expect(isMobileLike(env({ coarsePointer: false, anyFinePointer: false, anyHover: false, touchPoints: 0 }))).toBe(false);
  });

  it('browsers without pointer / hover media features fall back to a narrow device screen', () => {
    expect(isMobileLike(env({ ...LEGACY, screenWidth: 375, screenHeight: 667 }))).toBe(true);
    expect(isMobileLike(env({ ...LEGACY, screenWidth: 667, screenHeight: 375 }))).toBe(true);
    expect(isMobileLike(env({ ...LEGACY, screenWidth: NARROW_SCREEN_PX, screenHeight: 900 }))).toBe(true);
    expect(isMobileLike(env({ ...LEGACY, screenWidth: NARROW_SCREEN_PX + 1, screenHeight: 900 }))).toBe(false);
    expect(isMobileLike(env({ ...LEGACY, screenWidth: 1920, screenHeight: 1080 }))).toBe(false);
    expect(isMobileLike(env({ ...LEGACY, screenWidth: 0, screenHeight: 0 }))).toBe(false); // unknown screen
    // touch still counts there
    expect(isMobileLike(env({ ...LEGACY, touchPoints: 5, screenWidth: 1024, screenHeight: 1366 }))).toBe(true);
  });
});

/** A fake window whose matchMedia answers from a set of matching queries. */
function fakeWindow(matching: string[], extra: Partial<EnvSource> = {}): EnvSource {
  return { matchMedia: (q: string) => ({ matches: matching.includes(q) }), navigator: { maxTouchPoints: 0 }, screen: { width: 1920, height: 1080 }, ...extra };
}

describe('readMobileEnv', () => {
  it('reads the pointer / hover features, touch points and the device screen', () => {
    const phone = fakeWindow(['(pointer: coarse)', '(any-pointer: coarse)', '(any-hover: none)'],
      { navigator: { maxTouchPoints: 5 }, screen: { width: 390, height: 844 } });
    expect(readMobileEnv(phone)).toEqual({
      coarsePointer: true, anyFinePointer: false, anyHover: false, touchPoints: 5, screenWidth: 390, screenHeight: 844,
    });
    expect(isMobileLike(readMobileEnv(phone))).toBe(true);
    const desktop = fakeWindow(['(pointer: fine)', '(any-pointer: fine)', '(any-hover: hover)']);
    expect(readMobileEnv(desktop)).toMatchObject({ coarsePointer: false, anyFinePointer: true, anyHover: true, touchPoints: 0 });
    expect(isMobileLike(readMobileEnv(desktop))).toBe(false);
  });

  it('a feature that matches none of its values is unknown (null), and so is a missing matchMedia', () => {
    const old = fakeWindow([], { screen: { width: 360, height: 640 } });
    expect(readMobileEnv(old)).toMatchObject({ coarsePointer: null, anyFinePointer: null, anyHover: null });
    expect(isMobileLike(readMobileEnv(old))).toBe(true);
    const none: EnvSource = { navigator: {}, screen: { width: 1280, height: 800 } };
    expect(readMobileEnv(none)).toMatchObject({ coarsePointer: null, anyFinePointer: null, anyHover: null, touchPoints: 0 });
    const throws: EnvSource = { matchMedia: () => { throw new Error('nope'); } };
    expect(readMobileEnv(throws).coarsePointer).toBeNull();
  });

  it('a legacy ontouchstart-only browser counts one touch point', () => {
    expect(readMobileEnv({ ...fakeWindow([]), navigator: {}, ontouchstart: null }).touchPoints).toBe(1);
  });
});

describe('controller prompt state', () => {
  const start: PadPromptState = { mobile: true, padConnected: false, dismissed: false };

  it('visible = mobile, no pad connected, not dismissed', () => {
    for (const mobile of [false, true]) {
      for (const padConnected of [false, true]) {
        for (const dismissed of [false, true]) {
          expect(padPromptVisible({ mobile, padConnected, dismissed })).toBe(mobile && !padConnected && !dismissed);
        }
      }
    }
  });

  it('hides on gamepadconnected and comes back once the last pad is gone', () => {
    const run = (events: PadPromptEvent[]) => events.reduce(padPromptReducer, start);
    expect(padPromptVisible(start)).toBe(true);
    expect(padPromptVisible(run([{ type: 'connected' }]))).toBe(false);
    expect(padPromptVisible(run([{ type: 'connected' }, { type: 'disconnected', remaining: 1 }]))).toBe(false);
    expect(padPromptVisible(run([{ type: 'connected' }, { type: 'disconnected', remaining: 0 }]))).toBe(true);
  });

  it('a poll that finds a pad already connected hides it (on show / focus / visibility)', () => {
    expect(padPromptVisible(padPromptReducer(start, { type: 'pads', count: 1 }))).toBe(false);
    const polledEmpty = padPromptReducer(padPromptReducer(start, { type: 'pads', count: 2 }), { type: 'pads', count: 0 });
    expect(padPromptVisible(polledEmpty)).toBe(true);
  });

  it('dismissal sticks: pads coming and going do not bring it back', () => {
    const s = [
      { type: 'dismiss' }, { type: 'connected' }, { type: 'disconnected', remaining: 0 }, { type: 'pads', count: 0 },
    ].reduce((acc, e) => padPromptReducer(acc, e as PadPromptEvent), start);
    expect(s.dismissed).toBe(true);
    expect(padPromptVisible(s)).toBe(false);
  });

  it('never shows once detection says not mobile (a mouse was attached)', () => {
    const s = padPromptReducer(start, { type: 'mobile', mobile: false });
    expect(padPromptVisible(s)).toBe(false);
    expect(padPromptVisible(padPromptReducer(s, { type: 'disconnected', remaining: 0 }))).toBe(false);
    expect(padPromptVisible(padPromptReducer(s, { type: 'mobile', mobile: true }))).toBe(true);
  });

  it('the reducer does not mutate its input', () => {
    const s = { ...start };
    padPromptReducer(s, { type: 'connected' });
    padPromptReducer(s, { type: 'dismiss' });
    expect(s).toEqual(start);
  });

  it('countPads counts connected pads in a getGamepads() result, minus the one just disconnected', () => {
    expect(countPads(null)).toBe(0);
    expect(countPads([null, null, null, null])).toBe(0);
    const pads = [null, { index: 1, connected: true }, { index: 2, connected: false }, { index: 3 }];
    expect(countPads(pads)).toBe(2);
    expect(countPads(pads, 1)).toBe(1);
    expect(countPads(pads, 3)).toBe(1);
  });
});

describe('rotate overlay', () => {
  const screens: MobileScreen[] = ['title', 'command', 'room', 'game'];

  it('shows only for mobile + portrait in the room lobby or a match', () => {
    for (const screen of screens) {
      for (const mobile of [false, true]) {
        for (const portrait of [false, true]) {
          expect(rotateOverlayVisible({ mobile, portrait, screen })).toBe(mobile && portrait && (screen === 'room' || screen === 'game'));
        }
      }
    }
  });

  it('never on Title / Command (their layouts work in portrait), never in landscape, never on a desktop', () => {
    expect(rotateOverlayVisible({ mobile: true, portrait: true, screen: 'title' })).toBe(false);
    expect(rotateOverlayVisible({ mobile: true, portrait: true, screen: 'command' })).toBe(false);
    expect(rotateOverlayVisible({ mobile: true, portrait: false, screen: 'game' })).toBe(false);
    expect(rotateOverlayVisible({ mobile: false, portrait: true, screen: 'game' })).toBe(false);
  });
});

describe('fullscreen', () => {
  it('canFullscreen: element fullscreen (prefixed or not) that is enabled', () => {
    expect(canFullscreen({ documentElement: { requestFullscreen: () => undefined }, fullscreenEnabled: true })).toBe(true);
    expect(canFullscreen({ documentElement: { webkitRequestFullscreen: () => undefined }, webkitFullscreenEnabled: true })).toBe(true);
    expect(canFullscreen({ documentElement: { requestFullscreen: () => undefined } })).toBe(true); // no *Enabled flag
    expect(canFullscreen({ documentElement: {}, fullscreenEnabled: false })).toBe(false); // iPhone Safari
    expect(canFullscreen({ documentElement: {} })).toBe(false);
    expect(canFullscreen({ documentElement: { requestFullscreen: () => undefined }, fullscreenEnabled: false })).toBe(false);
  });

  it('isFullscreen reads the standard or the webkit element', () => {
    expect(isFullscreen({ documentElement: {} })).toBe(false);
    expect(isFullscreen({ documentElement: {}, fullscreenElement: null })).toBe(false);
    expect(isFullscreen({ documentElement: {}, fullscreenElement: {} })).toBe(true);
    expect(isFullscreen({ documentElement: {}, webkitFullscreenElement: {} })).toBe(true);
  });

  it('isStandalone: launched from the home screen (display-mode or iOS navigator.standalone)', () => {
    expect(isStandalone(fakeWindow(['(display-mode: fullscreen)']))).toBe(true);
    expect(isStandalone(fakeWindow(['(display-mode: standalone)']))).toBe(true);
    expect(isStandalone({ ...fakeWindow([]), navigator: { standalone: true } })).toBe(true);
    expect(isStandalone(fakeWindow([]))).toBe(false);
    expect(isStandalone({})).toBe(false);
  });

  it('the button shows for mobile with fullscreen available, until fullscreen / installed', () => {
    const base = { mobile: true, canFullscreen: true, fullscreen: false, standalone: false };
    expect(fullscreenButtonVisible(base)).toBe(true);
    expect(fullscreenButtonVisible({ ...base, mobile: false })).toBe(false);
    expect(fullscreenButtonVisible({ ...base, canFullscreen: false })).toBe(false); // iPhone: rotate overlay + manifest instead
    expect(fullscreenButtonVisible({ ...base, fullscreen: true })).toBe(false);
    expect(fullscreenButtonVisible({ ...base, standalone: true })).toBe(false);
  });

  it('playFullscreen requests fullscreen inside the gesture (before any await), then locks landscape', async () => {
    const order: string[] = [];
    const requestFullscreen = vi.fn(async () => { order.push('fullscreen'); });
    const lock = vi.fn(async (o: string) => { order.push(`lock:${o}`); });
    const p = playFullscreen({ documentElement: { requestFullscreen } }, { lock });
    expect(requestFullscreen).toHaveBeenCalledTimes(1); // synchronously, still in the click handler
    expect(requestFullscreen).toHaveBeenCalledWith({ navigationUI: 'hide' });
    await expect(p).resolves.toBe(true);
    expect(order).toEqual(['fullscreen', 'lock:landscape']);
  });

  it('falls back to webkitRequestFullscreen', async () => {
    const webkitRequestFullscreen = vi.fn(() => undefined);
    await expect(playFullscreen({ documentElement: { webkitRequestFullscreen } }, null)).resolves.toBe(true);
    expect(webkitRequestFullscreen).toHaveBeenCalledTimes(1);
  });

  it('swallows every refusal: a rejected request, a rejected or throwing lock, no lock, no API at all', async () => {
    const lock = vi.fn(async () => { throw new Error('NotSupportedError'); });
    await expect(playFullscreen({ documentElement: { requestFullscreen: async () => { throw new Error('denied'); } } }, { lock })).resolves.toBe(false);
    expect(lock).toHaveBeenCalledTimes(1); // still tried
    await expect(playFullscreen({ documentElement: { requestFullscreen: async () => undefined } }, { lock: () => { throw new TypeError('no'); } })).resolves.toBe(true);
    await expect(playFullscreen({ documentElement: { requestFullscreen: () => { throw new Error('sync'); } } }, {})).resolves.toBe(false);
    await expect(playFullscreen({ documentElement: {} }, undefined)).resolves.toBe(false);
  });

  it('already fullscreen: no second request, the lock is still tried', async () => {
    const requestFullscreen = vi.fn(async () => undefined);
    const lock = vi.fn(async () => undefined);
    await expect(playFullscreen({ documentElement: { requestFullscreen }, fullscreenElement: {} }, { lock })).resolves.toBe(true);
    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(lock).toHaveBeenCalledWith('landscape');
  });
});

describe('web manifest', () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../public/manifest.webmanifest', import.meta.url)), 'utf8')) as Record<string, unknown>;

  it('launches fullscreen in landscape with base-relative start_url / scope', () => {
    expect(manifest.display).toBe('fullscreen');
    expect(manifest.orientation).toBe('landscape');
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
  });

  it('has no id: it defaults to the resolved start_url, so the app is /voidswarm/ on Pages, not the whole origin', () => {
    // an explicit "./" or "/" id resolves against the start_url's ORIGIN (W3C manifest spec, processing `id`)
    expect(manifest).not.toHaveProperty('id');
  });

  it('icons are relative paths with 192 and 512 px sizes, any + maskable', () => {
    const icons = manifest.icons as { src: string; sizes: string; purpose: string }[];
    for (const i of icons) expect(i.src.startsWith('/')).toBe(false);
    for (const size of ['192x192', '512x512']) {
      for (const purpose of ['any', 'maskable']) expect(icons.some((i) => i.sizes === size && i.purpose === purpose)).toBe(true);
    }
  });
});
