// v0.5 mobile support. Owner: "regarding the mobile version, it should recommend a controller and play in landscape
// mode." There are NO touch controls (none are planned here): phones and tablets get
//   - a "plays best with a controller" card on Title and Command (hidden while a pad is connected; X dismisses it for
//     the session),
//   - a "Play fullscreen" button (fullscreen + a landscape orientation lock, where the browser has them),
//   - a "Rotate to landscape" overlay over the room lobby and the match while the device is held in portrait.
// A desktop / laptop with a mouse or trackpad never sees any of it (isMobileLike). The overlay only covers the view:
// it never pauses or changes the sim (online the match keeps running; offline too, the game has no pause hook).
// The rules are pure (mobile.test.ts); MobileSupport is the DOM wiring main.ts mounts.
import { h } from './dom';

// ============================================================================================ detection

/** What isMobileLike looks at. `null` = the browser doesn't know that media feature (or has no matchMedia). */
export interface MobileEnv {
  /** matchMedia('(pointer: coarse)'): the primary pointer is a finger. */
  coarsePointer: boolean | null;
  /** matchMedia('(any-pointer: fine)'): some mouse / trackpad / pen is present. */
  anyFinePointer: boolean | null;
  /** matchMedia('(any-hover: hover)'): some pointer can hover. */
  anyHover: boolean | null;
  /** navigator.maxTouchPoints (1 for a legacy `ontouchstart`-only browser). */
  touchPoints: number;
  /** screen.width / screen.height: the device's size in CSS px (not the window's, so a narrow desktop window never counts). */
  screenWidth: number;
  screenHeight: number;
}

/** Narrow-screen fallback (browsers without the pointer / hover media features): a phone's short side. */
export const NARROW_SCREEN_PX = 540;

/**
 * Phone / tablet (no mouse): true for a coarse primary pointer, or a touch screen with no fine pointer and no hover.
 * A fine pointer that can hover (a mouse or trackpad) anywhere always means false, so a desktop with a mouse never
 * sees the mobile UI, touch screen or not. Browsers that know none of the pointer features fall back to the screen size.
 */
export function isMobileLike(env: MobileEnv): boolean {
  if (env.anyFinePointer === true && env.anyHover === true) return false;
  if (env.coarsePointer === true) return true;
  if (env.touchPoints > 0 && env.anyFinePointer !== true && env.anyHover !== true) return true;
  if (env.coarsePointer === null && env.anyFinePointer === null && env.anyHover === null) {
    const short = Math.min(env.screenWidth, env.screenHeight);
    return short > 0 && short <= NARROW_SCREEN_PX;
  }
  return false;
}

/** The parts of `window` detection reads (a fake in tests). */
export interface EnvSource {
  matchMedia?: (q: string) => { matches: boolean };
  navigator?: { maxTouchPoints?: number };
  screen?: { width?: number; height?: number };
  ontouchstart?: unknown;
}

/**
 * `(feature: value)`, or null when the browser doesn't know the feature: one that does matches at least one of the
 * feature's values, one that doesn't matches none of them (serialising the query can't tell: Chrome keeps it as is).
 */
function mediaFeature(src: EnvSource, feature: string, value: string, all: readonly string[]): boolean | null {
  if (typeof src.matchMedia !== 'function') return null;
  try {
    if (!all.some((v) => src.matchMedia!(`(${feature}: ${v})`).matches)) return null;
    return src.matchMedia(`(${feature}: ${value})`).matches;
  } catch {
    return null;
  }
}

export function readMobileEnv(src: EnvSource): MobileEnv {
  const pointers = ['none', 'coarse', 'fine'] as const;
  const tp = Number(src.navigator?.maxTouchPoints) || 0;
  return {
    coarsePointer: mediaFeature(src, 'pointer', 'coarse', pointers),
    anyFinePointer: mediaFeature(src, 'any-pointer', 'fine', pointers),
    anyHover: mediaFeature(src, 'any-hover', 'hover', ['none', 'hover']),
    touchPoints: tp > 0 ? tp : 'ontouchstart' in src ? 1 : 0,
    screenWidth: Number(src.screen?.width) || 0,
    screenHeight: Number(src.screen?.height) || 0,
  };
}

// ============================================================================================ controller prompt

export const PAD_PROMPT_TITLE = 'Voidswarm plays best with a controller.';
export const PAD_PROMPT_BODY = 'Connect a Bluetooth controller (Xbox, PlayStation or MFi) and press any button.';
export const PAD_PROMPT_TOUCH = 'Touch controls are not available yet.';
/** Only when the page can't read gamepads at all (no navigator.getGamepads: some browsers hide it off https). */
export const PAD_PROMPT_NO_API = 'This browser can’t read controllers on this page: open Voidswarm over https:// to use one.';
export const ROTATE_TITLE = 'Rotate to landscape to play';
export const ROTATE_MATCH_NOTE = 'The match keeps running while you turn your device.';
export const ROTATE_LOCK_NOTE = 'Screen won’t turn? Switch off rotation lock.';
export const FULLSCREEN_LABEL = 'Play fullscreen';

/** sessionStorage key: the X was pressed this session (the card stays away until the tab is closed). */
export const KEY_PAD_PROMPT_DISMISSED = 'voidswarm.mobile.padPromptDismissed';

export interface PadPromptState {
  mobile: boolean;
  /** A gamepad is connected (an event said so, or navigator.getGamepads() reports one). */
  padConnected: boolean;
  /** The X was pressed this session. */
  dismissed: boolean;
}

export type PadPromptEvent =
  /** navigator.getGamepads() was polled: on show, on window focus, when the page becomes visible. */
  | { type: 'pads'; count: number }
  /** 'gamepadconnected'. */
  | { type: 'connected' }
  /** 'gamepaddisconnected': `remaining` = pads still connected after it. */
  | { type: 'disconnected'; remaining: number }
  /** The X. */
  | { type: 'dismiss' }
  /** Detection re-ran (a mouse was attached / removed). */
  | { type: 'mobile'; mobile: boolean };

export function padPromptReducer(s: PadPromptState, e: PadPromptEvent): PadPromptState {
  switch (e.type) {
    case 'pads': return { ...s, padConnected: e.count > 0 };
    case 'connected': return { ...s, padConnected: true };
    case 'disconnected': return { ...s, padConnected: e.remaining > 0 };
    case 'dismiss': return { ...s, dismissed: true };
    case 'mobile': return { ...s, mobile: e.mobile };
  }
}

/** mobile, no pad, not dismissed → the card shows (on Title / Command; the screen gate is MobileSupport's). */
export function padPromptVisible(s: PadPromptState): boolean {
  return s.mobile && !s.padConnected && !s.dismissed;
}

/** Connected pads in a navigator.getGamepads() result, leaving out `ignoreIndex` (the one just disconnected). */
export function countPads(pads: ArrayLike<{ index: number; connected?: boolean } | null> | null | undefined, ignoreIndex = -1): number {
  if (!pads) return 0;
  let n = 0;
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (p && p.connected !== false && p.index !== ignoreIndex) n++;
  }
  return n;
}

// ============================================================================================ rotate overlay

export type MobileScreen = 'title' | 'command' | 'room' | 'game';

/** mobile + portrait + the room lobby or a match → "Rotate to landscape" covers the view. */
export function rotateOverlayVisible(s: { mobile: boolean; portrait: boolean; screen: MobileScreen }): boolean {
  return s.mobile && s.portrait && (s.screen === 'room' || s.screen === 'game');
}

// ============================================================================================ fullscreen

interface FsElement {
  requestFullscreen?: (opts?: { navigationUI?: 'auto' | 'hide' | 'show' }) => Promise<void> | void;
  webkitRequestFullscreen?: () => Promise<void> | void;
}
/** The parts of `document` the fullscreen helpers read (a fake in tests). */
export interface FsDocument {
  documentElement: object;
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
  fullscreenElement?: unknown;
  webkitFullscreenElement?: unknown;
}
/** screen.orientation (lock() is Chrome / Android only; iOS has none or always rejects). */
export interface OrientationLike { lock?: (orientation: string) => Promise<void> | void }

/** Element fullscreen exists and is allowed (false on iPhone Safari, which only fullscreens <video>). */
export function canFullscreen(doc: FsDocument): boolean {
  const el = doc.documentElement as FsElement;
  const api = typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function';
  const enabled = doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled ?? true;
  return api && enabled !== false;
}

export function isFullscreen(doc: FsDocument): boolean {
  return !!(doc.fullscreenElement ?? doc.webkitFullscreenElement);
}

/** Installed and launched from the home screen (the manifest's fullscreen / standalone display). */
export function isStandalone(src: EnvSource & { navigator?: { standalone?: boolean } }): boolean {
  try {
    if (src.matchMedia?.('(display-mode: fullscreen)').matches || src.matchMedia?.('(display-mode: standalone)').matches) return true;
  } catch { /* no display-mode support */ }
  return src.navigator?.standalone === true;
}

/**
 * The "Play fullscreen" button shows for mobile-like devices whose browser can fullscreen the page, until it is
 * fullscreen (or runs installed). Without element fullscreen (iPhone Safari) there is nothing it could do: an
 * orientation lock needs fullscreen in Chrome and doesn't exist / always rejects on iOS, so the button hides and only
 * the rotate overlay asks for landscape (WebKit ignores the manifest's `orientation`; only Android Chrome honours it).
 */
export function fullscreenButtonVisible(s: { mobile: boolean; canFullscreen: boolean; fullscreen: boolean; standalone: boolean }): boolean {
  return s.mobile && s.canFullscreen && !s.fullscreen && !s.standalone;
}

/**
 * Fullscreen the whole page, then lock it to landscape. Call it straight from the click (the fullscreen request needs
 * the user gesture; it runs before the first await). Every refusal is swallowed: no fullscreen API, a denied request,
 * no orientation lock (iOS) or a rejected one. Resolves true when the page went (or already was) fullscreen.
 */
export async function playFullscreen(doc: FsDocument, orientation: OrientationLike | null | undefined): Promise<boolean> {
  const el = doc.documentElement as FsElement;
  let full = isFullscreen(doc);
  if (!full) {
    try {
      if (typeof el.requestFullscreen === 'function') { await el.requestFullscreen({ navigationUI: 'hide' }); full = true; }
      else if (typeof el.webkitRequestFullscreen === 'function') { await el.webkitRequestFullscreen(); full = true; }
    } catch { /* refused: no gesture, a permissions policy, an unsupported device */ }
  }
  try {
    if (orientation && typeof orientation.lock === 'function') await orientation.lock('landscape');
  } catch { /* no lock on this device (iOS) or not while windowed */ }
  return full;
}

// ============================================================================================ DOM wiring

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgIcon(cls: string, viewBox: string, parts: [string, Record<string, string>][]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, attrs] of parts) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

const STROKE = { fill: 'none', stroke: 'currentColor', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
const DOT = { fill: 'currentColor' };

function gamepadIcon(): SVGSVGElement {
  return svgIcon('pad-prompt-icon', '0 0 48 34', [
    ['path', { ...STROKE, d: 'M15 5h18c6.2 0 9.6 4.2 11 10.6l1.7 7.6c.9 4.3-1.5 7.6-5 7.6-2.5 0-4.1-1.3-5.6-3.5L32.4 24H15.6l-2.7 3.9C11.4 30.1 9.8 31.4 7.3 31.4c-3.5 0-5.9-3.3-5-7.6L4 15.6C5.4 9.2 8.8 5 15 5z' }],
    ['path', { ...STROKE, d: 'M14 12.5v7M10.5 16h7' }],
    ['circle', { ...DOT, cx: '34', cy: '12.6', r: '1.9' }],
    ['circle', { ...DOT, cx: '38.2', cy: '16.4', r: '1.9' }],
    ['circle', { ...DOT, cx: '34', cy: '20.2', r: '1.9' }],
    ['circle', { ...DOT, cx: '29.8', cy: '16.4', r: '1.9' }],
  ]);
}

function fullscreenIcon(): SVGSVGElement {
  return svgIcon('fs-icon', '0 0 24 24', [['path', { ...STROKE, d: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5' }]]);
}

function rotateIcon(): HTMLElement {
  // the phone turns from portrait to landscape (CSS keyframes; still under prefers-reduced-motion), the arrow stays
  const phone = svgIcon('rotate-phone', '0 0 64 64', [
    ['rect', { ...STROKE, x: '21', y: '6', width: '22', height: '52', rx: '4.5' }],
    ['path', { ...STROKE, d: 'M29 51.5h6' }],
  ]);
  const arrow = svgIcon('rotate-arrow', '0 0 64 64', [
    ['path', { ...STROKE, d: 'M50 16a26 26 0 0 1 6 18' }],
    ['path', { ...STROKE, d: 'M51.5 29l4.5 5.5 4.5-6' }],
  ]);
  return h('div', { class: 'rotate-icon', 'aria-hidden': 'true' }, phone, arrow);
}

function loadDismissed(): boolean {
  try { return globalThis.sessionStorage?.getItem(KEY_PAD_PROMPT_DISMISSED) === '1'; } catch { return false; }
}

function saveDismissed(): void {
  try { globalThis.sessionStorage?.setItem(KEY_PAD_PROMPT_DISMISSED, '1'); } catch { /* storage blocked: this page only */ }
}

interface PromptRefs { root: HTMLElement; actions: HTMLElement; fullscreen: HTMLButtonElement }

export interface MobileSupportOptions {
  /** UI sound hook (main.ts `ui`). */
  onUi?(name: string): void;
  /**
   * The rotate overlay started / stopped covering `screen` (or the screen changed under it). main.ts makes what it
   * covers inert, so a keyboard or gamepad can't press hidden lobby / modal buttons.
   */
  onCover?(covered: boolean, screen: MobileScreen): void;
  /**
   * The card was dismissed from the keyboard / a gamepad and its X had focus (it is hidden now): focus a sensible
   * control on that screen instead of dropping it on <body>. (Title's solo "Play fullscreen" gets it first, if shown.)
   */
  onPromptDismissed?(screen: 'title' | 'command'): void;
}

/**
 * Owns the mobile-only DOM: `titleSlot` (TitleScreen.mountNotice), `commandSlot` (CommandScreen.mountNotice) and
 * `rotateOverlay` (#overlays). main.ts calls setScreen() on every screen change. On a desktop everything stays hidden.
 */
export class MobileSupport {
  readonly titleSlot: HTMLElement;
  readonly commandSlot: HTMLElement;
  readonly rotateOverlay: HTMLElement;
  private state: PadPromptState;
  private screen: MobileScreen = 'title';
  private portrait = false;
  private readonly prompts: PromptRefs[] = [];
  private readonly titleFullscreen: HTMLButtonElement;
  private readonly rotateFullscreen: HTMLButtonElement;
  private readonly rotateMatchNote: HTMLElement;
  private readonly portraitMq: MediaQueryList | null;
  private covered: { on: boolean; screen: MobileScreen } | null = null;

  constructor(private readonly opts: MobileSupportOptions = {}) {
    this.state = { mobile: isMobileLike(readMobileEnv(window)), padConnected: false, dismissed: loadDismissed() };
    this.portraitMq = safeMq('(orientation: portrait)');

    const titlePrompt = this.buildPrompt(false);
    const commandPrompt = this.buildPrompt(true);
    this.titleFullscreen = this.fullscreenButton('btn btn-ghost mobile-fs-solo', 'mobile-fullscreen');
    this.titleSlot = h('div', { class: 'mobile-slot mobile-slot-title' }, titlePrompt.root, this.titleFullscreen);
    this.commandSlot = h('div', { class: 'mobile-slot mobile-slot-command' }, commandPrompt.root);

    this.rotateFullscreen = this.fullscreenButton('btn btn-primary', 'rotate-fullscreen');
    this.rotateMatchNote = h('p', { class: 'rotate-note' }, ROTATE_MATCH_NOTE);
    this.rotateOverlay = h('div', { class: 'rotate-overlay hidden', role: 'alert', 'aria-live': 'assertive' },
      rotateIcon(),
      h('div', { class: 'rotate-title' }, ROTATE_TITLE),
      this.rotateMatchNote,
      h('p', { class: 'rotate-note muted-note' }, ROTATE_LOCK_NOTE),
      this.rotateFullscreen);

    this.listen();
    this.pollPads();
    this.readOrientation();
    this.sync();
  }

  /** Current screen (main.ts setScreen). Showing Title / Command re-checks for an already connected pad. */
  setScreen(screen: MobileScreen): void {
    this.screen = screen;
    if (screen === 'title' || screen === 'command') this.pollPads();
    this.readOrientation();
    this.sync();
  }

  get mobile(): boolean { return this.state.mobile; }

  /** "Rotate to landscape" is up: main.ts routes gamepad / keyboard menu input to it (activeLayer). */
  get rotateVisible(): boolean {
    return rotateOverlayVisible({ mobile: this.state.mobile, portrait: this.portrait, screen: this.screen });
  }

  // ------------------------------------------------------------------ internals

  private buildPrompt(compact: boolean): PromptRefs {
    const fullscreen = this.fullscreenButton('btn btn-primary btn-small pad-prompt-fs', compact ? 'cmd-mobile-fullscreen' : 'mobile-prompt-fullscreen');
    const actions = h('div', { class: 'pad-prompt-actions' }, fullscreen);
    const noApi = typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function';
    const root = h('section', { class: `pad-prompt${compact ? ' compact' : ''} hidden`, role: 'note', 'aria-label': 'Controller recommended' },
      gamepadIcon(),
      h('div', { class: 'pad-prompt-text' },
        h('div', { class: 'pad-prompt-title' }, PAD_PROMPT_TITLE),
        h('p', { class: 'pad-prompt-body' }, PAD_PROMPT_BODY),
        h('p', { class: 'pad-prompt-note' }, PAD_PROMPT_TOUCH),
        noApi ? h('p', { class: 'pad-prompt-note' }, PAD_PROMPT_NO_API) : null,
        actions),
      h('button', {
        class: 'pad-prompt-close', type: 'button', 'data-nav': compact ? 'cmd-pad-prompt-close' : 'pad-prompt-close',
        'aria-label': 'Dismiss controller tip', title: 'Dismiss',
        onclick: (e: MouseEvent) => {
          // detail 0 = Enter / Space or a gamepad's synthetic click (FocusNav): the X loses its focus when the card
          // hides, so hand it on. A tap never moves focus (it could pop the on-screen keyboard over a Title field).
          const refocus = e.detail === 0 && document.activeElement === e.currentTarget;
          saveDismissed(); this.dispatch({ type: 'dismiss' }); this.opts.onUi?.('click');
          if (refocus) this.refocusAfterDismiss(compact ? 'command' : 'title');
        },
      }, h('span', { 'aria-hidden': 'true' }, '×')));
    const refs = { root, actions, fullscreen };
    this.prompts.push(refs);
    return refs;
  }

  private refocusAfterDismiss(screen: 'title' | 'command'): void {
    if (screen === 'title' && !this.titleFullscreen.classList.contains('hidden') && !this.titleSlot.classList.contains('hidden')) {
      this.titleFullscreen.focus({ preventScroll: true });
      return;
    }
    this.opts.onPromptDismissed?.(screen);
  }

  private fullscreenButton(cls: string, nav: string): HTMLButtonElement {
    return h('button', {
      class: `${cls} hidden`, type: 'button', 'data-nav': nav,
      onclick: () => {
        this.opts.onUi?.('click');
        // straight from the gesture (playFullscreen requests before its first await)
        void playFullscreen(document as unknown as FsDocument, screen.orientation as unknown as OrientationLike).then(() => this.sync());
      },
    }, fullscreenIcon(), FULLSCREEN_LABEL);
  }

  private dispatch(e: PadPromptEvent): void {
    const next = padPromptReducer(this.state, e);
    if (next.mobile === this.state.mobile && next.padConnected === this.state.padConnected && next.dismissed === this.state.dismissed) return;
    this.state = next;
    this.sync();
  }

  private pollPads(): void {
    this.dispatch({ type: 'pads', count: countPads(readPads()) });
  }

  private readOrientation(): void {
    this.portrait = this.portraitMq ? this.portraitMq.matches : window.innerHeight > window.innerWidth;
  }

  private listen(): void {
    window.addEventListener('gamepadconnected', () => this.dispatch({ type: 'connected' }));
    window.addEventListener('gamepaddisconnected', (e) => {
      const gone = (e as GamepadEvent).gamepad?.index ?? -1;
      this.dispatch({ type: 'disconnected', remaining: countPads(readPads(), gone) });
    });
    window.addEventListener('focus', () => this.pollPads());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.pollPads(); });
    // orientation: the media query's change event, plus resize (some browsers are late with one or the other)
    const orient = () => { const was = this.portrait; this.readOrientation(); if (was !== this.portrait) this.sync(); };
    this.portraitMq?.addEventListener?.('change', orient);
    window.addEventListener('resize', orient);
    window.addEventListener('orientationchange', orient);
    // fullscreen entered / left (Esc, the system back gesture): the button follows
    document.addEventListener('fullscreenchange', () => this.sync());
    document.addEventListener('webkitfullscreenchange', () => this.sync());
    // a mouse attached to / removed from a tablet: detection re-runs
    const redetect = () => this.dispatch({ type: 'mobile', mobile: isMobileLike(readMobileEnv(window)) });
    for (const q of ['(pointer: coarse)', '(any-pointer: fine)', '(any-hover: hover)']) safeMq(q)?.addEventListener?.('change', redetect);
  }

  private sync(): void {
    const mobile = this.state.mobile;
    const prompt = padPromptVisible(this.state);
    const fsButton = fullscreenButtonVisible({
      mobile, canFullscreen: canFullscreen(document as unknown as FsDocument),
      fullscreen: isFullscreen(document as unknown as FsDocument), standalone: isStandalone(window),
    });
    for (const p of this.prompts) {
      p.root.classList.toggle('hidden', !prompt);
      p.fullscreen.classList.toggle('hidden', !fsButton);
      p.actions.classList.toggle('hidden', !fsButton);
    }
    // Title: the solo button stands in for the card's while the card is away (pad connected / dismissed)
    const solo = fsButton && !prompt;
    this.titleFullscreen.classList.toggle('hidden', !solo);
    this.titleSlot.classList.toggle('hidden', !prompt && !solo);
    this.commandSlot.classList.toggle('hidden', !prompt);
    const rotate = this.rotateVisible;
    this.rotateOverlay.classList.toggle('hidden', !rotate);
    this.rotateMatchNote.classList.toggle('hidden', this.screen !== 'game');
    this.rotateFullscreen.classList.toggle('hidden', !fsButton);
    if (!this.covered || this.covered.on !== rotate || this.covered.screen !== this.screen) {
      const first = this.covered === null;
      this.covered = { on: rotate, screen: this.screen };
      if (!first || rotate) this.opts.onCover?.(rotate, this.screen);
    }
  }
}

function safeMq(q: string): MediaQueryList | null {
  try { return typeof matchMedia === 'function' ? matchMedia(q) : null; } catch { return null; }
}

function readPads(): ArrayLike<Gamepad | null> | null {
  try { return typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : null; } catch { return null; }
}
