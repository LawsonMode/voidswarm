// Title / login screen.
// Default view is a simple login (Username + Password + [Log in]) with small links underneath:
// Create account · Forgot password? · Continue as guest · Play offline. The server URL sits behind
// a "Server…" link. Logging in (or registering / resetting) connects straight to Command.
// Passwords only ever go into the request body; password fields are cleared after every submit and
// nothing password-related is logged. Email is only asked for in Create account and Forgot password.
// v0.3.1: an animated attract scene (title/TitleScene.ts) runs behind the panel while this screen is
// active and is destroyed when it leaves; the logo gets a chrome shine, a one-time glitch intro and a beat
// glow (title/logoFx.ts); a feature ticker sits under the tagline. On a static host (GitHub Pages, or
// window.VOIDSWARM_STATIC) with the page's default server, "Play offline vs bots" leads and the login form
// folds away behind "or log in to a server" until it is opened or a server address is entered.
import { NAME_MAX_LEN } from '../../shared/constants';
import { PASSWORD_MIN, type AccountInfo, type AuthResponse } from '../../shared/protocol';
import { GAME_VERSION } from '../../shared/version';
import {
  AccountsApi, apiBaseFromServerUrl, ApiError, clearSession, isInsecureRemote, loadSession, saveSession,
  validateNewPassword, validateRegistration, type StoredSession,
} from '../net/accounts';
import { isPrivateHost, isStaticHost, normalizeServerUrl, serverHost, type ResolvedServer } from '../net/serverUrl';
import { featureLines } from '../title/features';
import { LogoFx } from '../title/logoFx';
import { TitleScene } from '../title/TitleScene';
import { h } from './dom';

export interface TitleCallbacks {
  /** token = session token (logged in) or undefined (guest). */
  onOnline(name: string, url: string, token: string | undefined): void;
  onOffline(name: string): void;
  onSettings(): void;
  onControls(): void;
}

export type TitleView = 'login' | 'register' | 'guest' | 'forgot' | 'reset';
type View = TitleView;

export interface TitleOptions {
  name: string;
  /** Resolved server (main.ts → resolveServer). `pending` = an untrusted ?server= awaiting confirmation. */
  server: ResolvedServer;
  /** One-time token from a ?reset= email link, or null. */
  resetToken: string | null;
  /** The server that issues ?reset= links: this page's own server (PUBLIC_URL). Never the saved / ?server= one. */
  resetServerUrl: string;
  /** location.hostname of this page (account servers on other hosts are flagged). */
  pageHost: string;
  /** Static host with no game server of its own (default: net/serverUrl isStaticHost for pageHost). */
  staticHost?: boolean;
}

/** Copy under the offline button on a static host (followed by a "Server…" link, which ends the sentence). */
export const STATIC_NOTE = 'Online play needs a Voidswarm server — enter its address under';

/** Keystrokes in the panel mark the screen as "typing" this long: the border and the ticker hold still. */
const TYPING_MS = 2500;

/** v0.3 guest copy (§1.3 / §2.1). */
export const GUEST_COPY = 'Items you find stay on this device and only you see them. Create an account to keep them everywhere and show them off.';

export class TitleScreen {
  readonly root: HTMLElement;
  private urlInput: HTMLInputElement;
  private serverBox: HTMLElement;
  private serverLink: HTMLButtonElement;
  private insecure: HTMLElement;
  private status: HTMLElement;
  private accountBox: HTMLElement;
  private callsign: HTMLInputElement;
  private view: View;
  private session: StoredSession | null = null;
  private sessionNote = '';
  private busy = false;
  private checkSeq = 0;
  private resetToken: string | null;
  private readonly resetServerUrl: string;
  private readonly pageHost: string;
  /** Untrusted ?server= URL waiting for "Connect to <host>?" — never used for anything until confirmed. */
  private pendingServer: string | null;
  /** A ?server= URL in use (trusted, or confirmed by the user): used this visit but never persisted. */
  private sessionOnlyUrl: string | null;
  /** "Account server: <host>" line, moved into whichever auth form is showing. */
  private apiHost: HTMLElement;
  /** Static host + the page's own (non-existent) server: offline play leads, online is secondary. */
  readonly offlineFirst: boolean;
  // --- attract scene + logo FX (alive only while this screen is active)
  private readonly bg: HTMLElement;
  private readonly wrap: HTMLElement;
  private readonly logoWrap: HTMLElement;
  private readonly logo: HTMLElement;
  private readonly logoGlow: HTMLElement;
  private readonly tagline: HTMLElement;
  private readonly panel: HTMLElement;
  private scene: TitleScene | null = null;
  private logoFx: LogoFx | null = null;
  private shown = false;
  private measureQueued = 0;
  private readonly reducedMq: MediaQueryList | null;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  /** Offline-first layout: the login fields were opened ("or log in to a server"). */
  private loginOpen = false;
  /** Offline-first login form parts, toggled without a re-render (so typed values survive). */
  private loginFold: { more: HTMLElement; expand: HTMLElement; divider: HTMLElement } | null = null;
  /** Window / visual-viewport resize: the column moves without changing size (ResizeObserver misses that). */
  private readonly onViewport = (): void => this.queueMeasure();

  constructor(private cb: TitleCallbacks, opts: TitleOptions) {
    const { name, server, resetToken } = opts;
    this.resetToken = resetToken;
    this.resetServerUrl = opts.resetServerUrl;
    this.pageHost = opts.pageHost.toLowerCase().replace(/^\[|\]$/g, '');
    this.view = resetToken ? 'reset' : 'login';
    // A reset link belongs to the server that sent the email (this page's own): ignore saved and ?server= values.
    const url = resetToken ? opts.resetServerUrl : server.url;
    this.pendingServer = resetToken ? null : server.pending;
    this.sessionOnlyUrl = !resetToken && server.source === 'query' ? server.url : null;
    this.apiHost = h('div', { class: 'api-host small', role: 'note' });
    this.urlInput = h('input', {
      type: 'url', class: 'field', value: url, spellcheck: 'false', 'data-nav': 'url', 'aria-label': 'Server URL', autocomplete: 'url',
    });
    // net/serverUrl.ts isStaticHost: *.github.io, the Pages build (vite --mode pages), or window.VOIDSWARM_STATIC.
    const isStatic = opts.staticHost ?? isStaticHost({ protocol: '', hostname: opts.pageHost, host: opts.pageHost, port: '', search: '' });
    this.serverBox = h('div', { class: 'server-box hidden' },
      h('label', { class: 'field-label' }, 'Server', this.urlInput),
      h('div', { class: 'muted small' }, isStatic
        // a static host (GitHub Pages) runs no game server, so there is no "this page's host" default
        ? 'The address of a Voidswarm game server, e.g. wss://play.example.com. Use wss:// for servers on the internet.'
        : 'Default: this page\'s host on port 7777. Use wss:// for servers on the internet.'));
    this.serverLink = h('button', {
      class: 'link subtle', type: 'button', 'data-nav': 'server-link', 'aria-expanded': 'false',
      onclick: () => this.toggleServer(),
    });
    this.insecure = h('div', { class: 'warn-line hidden', role: 'note' }, '⚠ Unencrypted connection — don’t reuse a real password.');
    this.callsign = h('input', {
      type: 'text', class: 'field', value: name, maxlength: NAME_MAX_LEN, autocomplete: 'nickname',
      spellcheck: 'false', 'data-nav': 'name', 'aria-label': 'Callsign',
    });
    this.status = h('div', { class: 'title-status', role: 'status', 'aria-live': 'polite' });
    this.accountBox = h('div', { class: 'account-box' });
    // Only while the page's own server is in use: a saved / linked server means online play is set up.
    this.offlineFirst = isStatic && !resetToken && !server.pending
      && normalizeServerUrl(url) === normalizeServerUrl(opts.resetServerUrl);
    this.reducedMq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

    let urlTimer: ReturnType<typeof setTimeout> | null = null;
    this.urlInput.addEventListener('input', () => {
      // Typing a server is an explicit choice: it replaces any link-supplied one.
      this.sessionOnlyUrl = null;
      if (this.pendingServer) { this.pendingServer = null; this.render(); }
      this.updateServerUi();
      if (urlTimer) clearTimeout(urlTimer);
      urlTimer = setTimeout(() => void this.checkSession(), 600);
    });

    // Logo: chrome wordmark + a pre-blurred glow layer (beat pulse) + RGB-split copies and scanlines (intro).
    this.logoGlow = h('div', { class: 'logo-glow', 'aria-hidden': 'true' }, 'VOIDSWARM');
    this.logo = h('h1', { class: 'logo', 'data-text': 'VOIDSWARM' }, 'VOIDSWARM');
    this.logoWrap = h('div', { class: 'logo-wrap' },
      this.logoGlow, this.logo,
      h('div', { class: 'logo-rgb c', 'aria-hidden': 'true' }, 'VOIDSWARM'),
      h('div', { class: 'logo-rgb m', 'aria-hidden': 'true' }, 'VOIDSWARM'),
      h('div', { class: 'logo-scan', 'aria-hidden': 'true' }));
    const features = featureLines();
    this.bg = h('div', { class: 'title-bg', 'aria-hidden': 'true' });
    // no-break spaces before each dot: when it wraps (phones) a line ends on a dot, never starts with one
    this.tagline = h('div', { class: 'tagline' }, 'Neon arena\u00a0· 32 pilots\u00a0· the swarm is hungry');
    this.panel = h('div', { class: 'panel title-panel' + (this.offlineFirst ? ' offline-first' : '') },
      this.accountBox,
      this.insecure,
      this.status,
      this.serverBox,
      h('div', { class: 'title-foot' },
        this.serverLink,
        h('span', { class: 'foot-sep' }, '·'),
        h('button', { class: 'link subtle', type: 'button', 'data-nav': 'settings', onclick: () => cb.onSettings() }, 'Settings'),
        h('span', { class: 'foot-sep' }, '·'),
        h('button', { class: 'link subtle', type: 'button', 'data-nav': 'controls', onclick: () => cb.onControls() }, 'Controls'),
        // in the panel (not on the scrolling grid, where a bright row could pass behind it)
        h('span', { class: 'foot-sep' }, '·'),
        h('span', { class: 'version' }, `v${GAME_VERSION}`)));
    this.wrap = h('div', { class: 'title-wrap' },
        this.logoWrap,
        this.tagline,
        // Rotating feature line (decorative: screen readers get the same facts once, from the line after it).
        h('div', { class: 'title-ticker', 'aria-hidden': 'true' },
          h('div', { class: 'ticker-track' }, [...features, features[0]].map((f) => h('div', { class: 'ticker-line' }, f)))),
        h('p', { class: 'title-sr' }, `${features.join('. ')}.`),
        this.panel);
    this.root = h('section', { class: 'screen screen-title' }, this.bg, this.wrap);
    // Typing in the panel: the neon border and the ticker hold still next to the fields.
    this.panel.addEventListener('input', () => {
      this.root.classList.add('typing');
      if (this.typingTimer) clearTimeout(this.typingTimer);
      this.typingTimer = setTimeout(() => { this.typingTimer = null; this.root.classList.remove('typing'); }, TYPING_MS);
    });

    this.updateServerUi();
    this.render();
    void this.checkSession();

    // main.ts shows / hides screens by toggling `.active`: follow it, so the scene only lives while shown.
    new MutationObserver(() => this.syncShown()).observe(this.root, { attributes: true, attributeFilter: ['class'] });
    if (typeof ResizeObserver === 'function') {
      // the logo's own box too: it changes width when the display font finishes loading
      const ro = new ResizeObserver(() => this.queueMeasure());
      ro.observe(this.wrap);
      ro.observe(this.logo);
    }
    void document.fonts?.ready.then(() => this.queueMeasure());
    this.root.addEventListener('scroll', () => this.queueMeasure(), { passive: true });
    this.reducedMq?.addEventListener?.('change', () => {
      this.root.classList.toggle('reduced-motion', this.reducedMotion());
      this.scene?.setReducedMotion(this.reducedMotion());
    });
    this.root.classList.toggle('reduced-motion', this.reducedMotion());
  }

  // ------------------------------------------------------------------ attract scene lifecycle
  private reducedMotion(): boolean { return !!this.reducedMq?.matches; }

  private syncShown(): void {
    const active = this.root.classList.contains('active');
    if (active === this.shown) return;
    this.shown = active;
    if (active) {
      try {
        this.scene = new TitleScene(this.bg, {
          reducedMotion: this.reducedMotion(),
          onFrame: (now, dt) => this.logoFx?.frame(now, dt),
          // A slow device (the governor stepped down): shed the page's own GPU cost too — an opaque panel with
          // no backdrop blur, a still border. Kept until the screen closes, so it doesn't flap.
          onQuality: (q) => { if (q <= 1) this.root.classList.add('title-lite'); },
        });
        this.root.classList.add('scene-live');
      } catch (e) {
        console.warn('[voidswarm] title scene unavailable; keeping the static backdrop', e);
        this.scene = null;
      }
      this.logoFx = new LogoFx(this.logoWrap, this.logoGlow, () => this.reducedMotion());
      this.logoFx.playIntro();
      window.addEventListener('resize', this.onViewport);
      window.visualViewport?.addEventListener('resize', this.onViewport);
      window.visualViewport?.addEventListener('scroll', this.onViewport);
      this.measureNow();
      this.scene?.start();
    } else {
      // Leaving the Title screen: tear everything down (no rAF, no canvas, no listeners left behind).
      this.scene?.destroy();
      this.scene = null;
      this.logoFx?.destroy();
      this.logoFx = null;
      window.removeEventListener('resize', this.onViewport);
      window.visualViewport?.removeEventListener('resize', this.onViewport);
      window.visualViewport?.removeEventListener('scroll', this.onViewport);
      this.root.classList.remove('scene-live', 'title-lite', 'typing');
      if (this.typingTimer) { clearTimeout(this.typingTimer); this.typingTimer = null; }
      if (this.measureQueued) { cancelAnimationFrame(this.measureQueued); this.measureQueued = 0; }
    }
  }

  private queueMeasure(): void {
    if (!this.scene || this.measureQueued) return;
    this.measureQueued = requestAnimationFrame(() => { this.measureQueued = 0; this.measureNow(); });
  }

  /**
   * Tell the scene where things are: the sun frames the logo and the horizon runs under it (above the tagline),
   * the action avoids the column, and only faint far flybys cross behind the panel.
   */
  private measureNow(): void {
    if (!this.scene) return;
    const logo = this.logo.getBoundingClientRect();
    const col = this.wrap.getBoundingClientRect();
    const tag = this.tagline.getBoundingClientRect();
    const panel = this.panel.getBoundingClientRect();
    this.scene.setAnchors({
      logo: logo.width > 0 ? logo : null, focus: col.width > 0 ? col : null,
      tagline: tag.height > 0 ? tag : null, panel: panel.width > 0 ? panel : null,
    });
  }

  // ------------------------------------------------------------------ public API (main.ts)
  get serverUrl(): string { return this.urlInput.value.trim(); }

  /** False for a URL that only came from a ?server= link: those are used for this visit but never saved. */
  isPersistable(url: string): boolean {
    return !this.sessionOnlyUrl || normalizeServerUrl(url) !== normalizeServerUrl(this.sessionOnlyUrl);
  }

  setBusy(busy: boolean, msg = ''): void {
    this.busy = busy;
    this.applyBusy();
    this.setStatus(msg, false);
  }

  /** Play / submit buttons follow `busy`, including ones created by a later render(). */
  private applyBusy(): void {
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-play]')) b.disabled = this.busy;
  }

  setStatus(msg: string, error: boolean): void {
    this.status.textContent = msg;
    this.status.classList.toggle('error', error);
  }

  focusDefault(): void {
    const el = this.accountBox.querySelector<HTMLElement>('[data-autofocus]') ?? this.accountBox.querySelector<HTMLElement>('input, button');
    el?.focus({ preventScroll: true });
  }

  /** The server rejected our token (or it expired): forget it and show the login form. */
  expireSession(msg: string): void {
    clearSession();
    this.session = null;
    this.sessionNote = '';
    this.view = 'login';
    this.render();
    this.setStatus(msg, true);
  }

  /**
   * Show one of the forms (Command's guest banner opens 'register'). A stored session is set aside for
   * 'register' / 'guest' so the form actually shows; 'reset' needs a ?reset= token and falls back to login.
   */
  showView(v: TitleView): void {
    if (v === 'reset' && !this.resetToken) v = 'login';
    this.pendingServer = null;
    if ((v === 'register' || v === 'guest') && this.session) {
      this.session = null;
      this.sessionNote = '';
    }
    this.setView(v);
  }

  /** The zone told us who we are (welcome.account): keep the stored username fresh. */
  noteAccount(account: AccountInfo | null): void {
    if (!account || !this.session) return;
    if (this.session.username !== account.username) {
      this.session = { ...this.session, username: account.username };
      saveSession(this.session);
      this.render();
    }
  }

  // ------------------------------------------------------------------ internals
  private api(): AccountsApi | null {
    const base = apiBaseFromServerUrl(this.serverUrl);
    return base ? new AccountsApi(base) : null;
  }

  private guestName(): string {
    return this.callsign.value.trim().slice(0, NAME_MAX_LEN) || 'Pilot';
  }

  private offlineName(): string {
    return this.session?.username ? this.session.username.slice(0, NAME_MAX_LEN) : this.guestName();
  }

  private toggleServer(open?: boolean): void {
    const show = open ?? this.serverBox.classList.contains('hidden');
    this.serverBox.classList.toggle('hidden', !show);
    this.serverLink.setAttribute('aria-expanded', String(show));
    if (show) this.urlInput.focus();
  }

  private updateServerUi(): void {
    const url = this.accountServerUrl();
    this.insecure.classList.toggle('hidden', !isInsecureRemote(url));
    const label = serverHost(this.serverUrl) || this.serverUrl;
    // A blank address only happens on a static host (no default server there): say so, not "default".
    this.serverLink.textContent = `Server: ${label || (this.offlineFirst ? 'not set' : 'default')}…`;
    // Where passwords go, spelled out on every auth form.
    const host = serverHost(url);
    let hostname = '';
    try { hostname = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { /* invalid */ }
    const foreign = !!hostname && hostname !== this.pageHost && !isPrivateHost(hostname);
    this.apiHost.classList.toggle('foreign', foreign);
    // No address at all (static host, nothing entered yet): nothing to point at, so no line.
    this.apiHost.classList.toggle('hidden', !url.trim());
    this.apiHost.replaceChildren(
      h('span', { class: 'muted' }, 'Account server: '),
      h('span', { class: 'strong' }, host || 'invalid address'),
      foreign ? h('span', null, ' — not this site') : '');
    this.syncLoginFold();
  }

  /** Offline-first: the login fields show once opened, or as soon as a server address is set. */
  private syncLoginFold(): void {
    const f = this.loginFold;
    if (!f) return;
    const open = this.loginOpen || !!this.serverUrl;
    f.more.classList.toggle('hidden', !open);
    f.divider.classList.toggle('hidden', !open);
    f.expand.classList.toggle('hidden', open);
  }

  /** Server whose accounts API the visible form talks to (the reset form always uses the issuing server). */
  private accountServerUrl(): string {
    return this.view === 'reset' && this.resetToken ? this.resetServerUrl : this.serverUrl;
  }

  private setView(v: View): void {
    this.view = v;
    this.setStatus('', false);
    this.render();
    this.focusDefault();
  }

  /** Validate a stored token against the current server's accounts API. */
  private async checkSession(): Promise<void> {
    const seq = ++this.checkSeq;
    const base = apiBaseFromServerUrl(this.serverUrl);
    const stored = loadSession();
    // The reset view never depends on the session: don't rebuild it (that would wipe typed passwords).
    const renderIfNeeded = () => { if (this.view !== 'reset') this.render(); };
    if (!stored || !base || stored.apiBase !== base) {
      if (this.session) { this.session = null; renderIfNeeded(); }
      return;
    }
    this.session = stored;
    this.sessionNote = 'Checking session…';
    renderIfNeeded();
    try {
      const res = await new AccountsApi(base).me(stored.token);
      if (seq !== this.checkSeq) return;
      this.session = { ...stored, username: res.account.username };
      saveSession(this.session);
      this.sessionNote = '';
    } catch (e) {
      if (seq !== this.checkSeq) return;
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        clearSession();
        this.session = null;
        this.sessionNote = '';
        // Never kick the user out of a password reset because an old session expired.
        if (this.view !== 'reset') {
          this.view = 'login';
          this.setStatus('Session expired — please log in again', true);
        }
      } else {
        // Server unreachable: keep the token; the game server verifies it on connect anyway.
        this.sessionNote = 'Could not verify your session right now.';
      }
    }
    renderIfNeeded();
  }

  private async run(form: HTMLFormElement, work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    const buttons = form.querySelectorAll<HTMLButtonElement>('button');
    buttons.forEach((b) => { b.disabled = true; });
    this.busy = true;
    try {
      await work();
    } catch (e) {
      this.setStatus(e instanceof Error ? e.message : 'Something went wrong.', true);
    } finally {
      this.busy = false;
      buttons.forEach((b) => { b.disabled = false; });
      // Never leave passwords sitting in the DOM.
      for (const pw of form.querySelectorAll<HTMLInputElement>('input[type="password"]')) pw.value = '';
    }
  }

  /** Store the session, then go straight to the zone lobby (on the server whose API issued the token). */
  private loggedIn(auth: AuthResponse, base: string, serverUrl: string, msg: string): void {
    this.session = { token: auth.token, apiBase: base, username: auth.account.username };
    saveSession(this.session);
    this.sessionNote = '';
    this.view = 'login';
    if (serverUrl !== this.serverUrl) this.urlInput.value = serverUrl;
    this.render();
    this.setStatus(msg, false);
    this.cb.onOnline(auth.account.username, serverUrl, auth.token);
  }

  private render(): void {
    this.loginFold = null;
    let body: HTMLElement;
    if (this.pendingServer && this.view !== 'reset') body = this.confirmServerView(this.pendingServer);
    else if (this.session && this.view !== 'reset') body = this.loggedInView(this.session);
    else {
      switch (this.view) {
        case 'register': body = this.registerForm(); break;
        case 'guest': body = this.guestForm(); break;
        case 'forgot': body = this.forgotForm(); break;
        case 'reset': body = this.resetForm(); break;
        default: body = this.loginForm(); break;
      }
    }
    this.accountBox.replaceChildren(body);
    this.updateServerUi();
    this.applyBusy();
    this.queueMeasure();
  }

  /** A ?server= link pointed at someone else's host: ask before anything (login, token, socket) goes there. */
  private confirmServerView(url: string): HTMLElement {
    const host = serverHost(url) || url;
    const stay = serverHost(this.serverUrl) || 'the default server';
    return h('div', { class: 'server-confirm', role: 'alertdialog', 'aria-label': 'Confirm server' },
      h('div', { class: 'form-title' }, 'Connect to another server?'),
      h('p', { class: 'confirm-text' }, 'This link wants to connect you to ', h('span', { class: 'strong accent-c' }, host), '.'),
      h('p', { class: 'warn-line' }, `Connect to ${host}? Your login will be sent there.`),
      h('div', { class: 'muted small' }, 'Only continue if you trust whoever gave you this link.'),
      h('button', {
        class: 'btn btn-primary btn-big btn-fit', type: 'button', 'data-nav': 'server-stay', 'data-autofocus': true,
        title: `Stay on ${stay}`, 'aria-label': `Stay on ${stay}`,
        onclick: () => { this.pendingServer = null; this.setView('login'); },
      }, h('span', { class: 'btn-fit-label' }, 'Stay on'), h('span', { class: 'btn-fit-host' }, stay)),
      h('button', {
        class: 'btn btn-danger btn-fit', type: 'button', 'data-nav': 'server-accept',
        // Long hosts (e.g. *.trycloudflare.com) shrink + ellipsize inside the button; full name on hover.
        title: `Connect to ${host}`, 'aria-label': `Connect to ${host}`,
        onclick: () => {
          this.pendingServer = null;
          this.sessionOnlyUrl = url;
          this.urlInput.value = url;
          this.setView('login');
          void this.checkSession();
        },
      }, h('span', { class: 'btn-fit-label' }, 'Connect to'), h('span', { class: 'btn-fit-host' }, host)),
      h('div', { class: 'title-links' }, this.offlineLink()));
  }

  private offlineLink(): HTMLElement {
    return h('button', {
      class: 'link subtle offline-link', type: 'button', 'data-nav': 'offline', 'data-play': true,
      onclick: () => this.cb.onOffline(this.offlineName()),
    }, 'Play offline vs bots');
  }

  private backLink(label = 'Back to log in'): HTMLElement {
    return h('button', { class: 'link', type: 'button', 'data-nav': 'back-login', onclick: () => this.setView('login') }, label);
  }

  private loggedInView(s: StoredSession): HTMLElement {
    return h('div', { class: 'logged-in' },
      h('div', { class: 'who' },
        h('span', { class: 'muted' }, 'Logged in as '), h('span', { class: 'strong accent-c' }, s.username || '…'),
        h('button', { class: 'btn btn-small btn-ghost', type: 'button', 'data-nav': 'logout', onclick: () => void this.logout() }, 'Log out')),
      this.sessionNote ? h('div', { class: 'muted small' }, this.sessionNote) : null,
      this.apiHost,
      h('button', {
        class: 'btn btn-primary btn-big', type: 'button', 'data-nav': 'online', 'data-play': true, 'data-autofocus': true,
        onclick: () => this.cb.onOnline(s.username || this.guestName(), this.serverUrl, s.token),
      }, 'Enter Command'),
      h('div', { class: 'title-links' }, this.offlineLink()));
  }

  /** Forget the stored session (and revoke it server-side), then show the login form. Command's "Log out". */
  async logout(): Promise<void> {
    const s = this.session;
    clearSession();
    this.session = null;
    this.view = 'login';
    this.render();
    this.setStatus('Logged out.', false);
    this.focusDefault();
    if (s) {
      try { await new AccountsApi(s.apiBase).logout(s.token); } catch { /* token already forgotten locally */ }
    }
  }

  private field(label: string, input: HTMLInputElement): HTMLElement {
    return h('label', { class: 'field-label' }, label, input);
  }

  private input(attrs: Record<string, unknown>): HTMLInputElement {
    return h('input', { class: 'field', spellcheck: 'false', autocapitalize: 'off', ...attrs });
  }

  /** Static host: the big offline button, with the "bring a server" note under it. */
  private offlineHero(): HTMLElement {
    return h('div', { class: 'offline-hero' },
      h('button', {
        class: 'btn btn-primary btn-big btn-hero', type: 'button', 'data-nav': 'offline', 'data-play': true, 'data-autofocus': true,
        onclick: () => this.cb.onOffline(this.offlineName()),
      }, 'Play offline vs bots'),
      h('div', { class: 'static-note', role: 'note' }, `${STATIC_NOTE} `,
        h('button', { class: 'link', type: 'button', 'data-nav': 'static-server', onclick: () => this.toggleServer(true) }, 'Server…')));
  }

  private loginForm(): HTMLElement {
    const lead = this.offlineFirst;
    // Labelled "Username"; the server also accepts the account email here.
    const login = this.input({ type: 'text', name: 'username', autocomplete: 'username', 'data-nav': 'login-user', 'data-autofocus': !lead, required: true, maxlength: 254 });
    const pw = this.input({ type: 'password', name: 'password', autocomplete: 'current-password', 'data-nav': 'login-pw', required: true });
    const links = h('div', { class: 'title-links' },
      h('button', { class: 'link', type: 'button', 'data-nav': 'to-register', onclick: () => this.setView('register') }, 'Create account'),
      h('span', { class: 'foot-sep' }, '·'),
      h('button', { class: 'link', type: 'button', 'data-nav': 'forgot', onclick: () => this.setView('forgot') }, 'Forgot password?'),
      h('span', { class: 'foot-sep' }, '·'),
      h('button', { class: 'link', type: 'button', 'data-nav': 'to-guest', onclick: () => this.setView('guest') }, 'Continue as guest'));
    const fields = [
      this.apiHost,
      this.field('Username', login),
      this.field('Password', pw),
      h('button', { class: lead ? 'btn btn-login' : 'btn btn-primary btn-big', type: 'submit', 'data-nav': 'login-submit', 'data-play': true }, 'Log in'),
      links,
    ];
    let body: (HTMLElement | null)[];
    if (lead) {
      // Static host: the fields do nothing until a server is set, so they fold away behind the divider.
      const more = h('div', { class: 'login-more', id: 'title-login-more' }, ...fields);
      const expand = h('button', {
        class: 'divider divider-btn', type: 'button', 'data-nav': 'login-expand', 'aria-expanded': 'false', 'aria-controls': 'title-login-more',
        onclick: () => {
          this.loginOpen = true;
          this.syncLoginFold();
          // no server yet: that comes first (the Server box opens and takes focus), else straight to the username
          if (!this.serverUrl) this.toggleServer(true); else login.focus();
        },
      }, 'or log in to a server', h('span', { class: 'divider-caret', 'aria-hidden': 'true' }, '▾'));
      const divider = h('div', { class: 'divider' }, 'or log in to a server');
      this.loginFold = { more, expand, divider };
      body = [this.offlineHero(), expand, divider, more];
    } else {
      body = [...fields, h('div', { class: 'title-links' }, this.offlineLink())];
    }
    const form = h('form', { class: 'auth-form', novalidate: true, autocomplete: 'on' }, ...body);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const user = login.value.trim(), pass = pw.value;
      if (!user || !pass) { this.setStatus('Enter your username and password.', true); pw.value = ''; return; }
      const api = this.api();
      if (!api) { this.setStatus('The server address is invalid — check "Server…".', true); pw.value = ''; return; }
      this.setStatus('Logging in…', false);
      void this.run(form, async () => {
        const res = await api.login(user, pass);
        this.loggedIn(res, api.base, this.serverUrl, `Welcome back, ${res.account.username}.`);
      });
    });
    return form;
  }

  private registerForm(): HTMLElement {
    const user = this.input({ type: 'text', name: 'username', autocomplete: 'username', 'data-nav': 'reg-user', 'data-autofocus': true, maxlength: 16, required: true });
    const email = this.input({ type: 'email', name: 'email', autocomplete: 'email', 'data-nav': 'reg-email', maxlength: 254, required: true });
    const pw = this.input({ type: 'password', name: 'new-password', autocomplete: 'new-password', 'data-nav': 'reg-pw', minlength: PASSWORD_MIN, required: true });
    const pw2 = this.input({ type: 'password', name: 'confirm-password', autocomplete: 'new-password', 'data-nav': 'reg-pw2', minlength: PASSWORD_MIN, required: true });
    const form = h('form', { class: 'auth-form', novalidate: true, autocomplete: 'on' },
      h('div', { class: 'form-title' }, 'Create account'),
      this.apiHost,
      this.field('Username (3–16: letters, numbers, _ -)', user),
      this.field('Email (required — only used for password resets)', email),
      this.field(`Password (${PASSWORD_MIN}+ characters)`, pw),
      this.field('Confirm password', pw2),
      h('button', { class: 'btn btn-primary btn-big', type: 'submit', 'data-nav': 'reg-submit', 'data-play': true }, 'Create account'),
      h('div', { class: 'title-links' }, this.backLink()));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = validateRegistration({ username: user.value, email: email.value, password: pw.value, confirm: pw2.value });
      if (err) { this.setStatus(err, true); pw.value = ''; pw2.value = ''; return; }
      const api = this.api();
      if (!api) { this.setStatus('The server address is invalid — check "Server…".', true); pw.value = ''; pw2.value = ''; return; }
      const username = user.value.trim(), mail = email.value.trim(), pass = pw.value;
      this.setStatus('Creating your account…', false);
      void this.run(form, async () => {
        const res = await api.register(username, mail, pass);
        this.loggedIn(res, api.base, this.serverUrl, `Welcome aboard, ${res.account.username}!`);
      });
    });
    return form;
  }

  private guestForm(): HTMLElement {
    const form = h('form', { class: 'auth-form', novalidate: true },
      h('div', { class: 'form-title' }, 'Continue as guest'),
      this.field('Callsign', this.callsign),
      h('div', { class: 'muted small' }, GUEST_COPY),
      h('button', { class: 'btn btn-primary btn-big', type: 'submit', 'data-nav': 'guest-play', 'data-play': true }, 'Play as guest'),
      h('div', { class: 'title-links' }, this.backLink(), h('span', { class: 'foot-sep' }, '·'), this.offlineLink()));
    this.callsign.dataset.autofocus = '';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.cb.onOnline(this.guestName(), this.serverUrl, undefined);
    });
    return form;
  }

  private forgotForm(): HTMLElement {
    const email = this.input({ type: 'email', name: 'email', autocomplete: 'email', 'data-nav': 'forgot-email', 'data-autofocus': true, maxlength: 254, required: true });
    const form = h('form', { class: 'auth-form', novalidate: true },
      h('div', { class: 'form-title' }, 'Reset your password'),
      this.apiHost,
      this.field('Account email', email),
      h('button', { class: 'btn btn-primary', type: 'submit', 'data-nav': 'forgot-submit' }, 'Send reset link'),
      h('div', { class: 'title-links' }, this.backLink()));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const mail = email.value.trim();
      if (!mail || !mail.includes('@')) { this.setStatus('Please enter a valid email address.', true); return; }
      const api = this.api();
      if (!api) { this.setStatus('The server address is invalid — check "Server…".', true); return; }
      this.setStatus('Sending…', false);
      void this.run(form, async () => {
        await api.forgot(mail);
        email.value = '';
        this.setStatus('If that email is registered, a reset link is on its way.', false);
      });
    });
    return form;
  }

  private resetForm(): HTMLElement {
    const pw = this.input({ type: 'password', name: 'new-password', autocomplete: 'new-password', 'data-nav': 'reset-pw', 'data-autofocus': true, minlength: PASSWORD_MIN, required: true });
    const pw2 = this.input({ type: 'password', name: 'confirm-password', autocomplete: 'new-password', 'data-nav': 'reset-pw2', minlength: PASSWORD_MIN, required: true });
    const form = h('form', { class: 'auth-form', novalidate: true },
      h('div', { class: 'form-title' }, 'Choose a new password'),
      this.apiHost,
      this.field(`New password (${PASSWORD_MIN}+ characters)`, pw),
      this.field('Confirm new password', pw2),
      h('button', { class: 'btn btn-primary btn-big', type: 'submit', 'data-nav': 'reset-submit', 'data-play': true }, 'Set password & log in'),
      h('div', { class: 'title-links' },
        h('button', { class: 'link', type: 'button', 'data-nav': 'reset-cancel', onclick: () => { this.resetToken = null; this.setView('login'); } }, 'Cancel')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = validateNewPassword(pw.value, pw2.value);
      if (err) { this.setStatus(err, true); pw.value = ''; pw2.value = ''; return; }
      // The token goes back to the server that emailed it (this page's own), never the saved / ?server= one.
      const base = apiBaseFromServerUrl(this.resetServerUrl);
      const token = this.resetToken;
      if (!base || !token) { this.setStatus('This reset link can’t be used here — request a new one.', true); pw.value = ''; pw2.value = ''; return; }
      const api = new AccountsApi(base);
      const serverUrl = this.resetServerUrl;
      const pass = pw.value;
      this.setStatus('Updating password…', false);
      void this.run(form, async () => {
        const res = await api.reset(token, pass);
        this.resetToken = null;
        this.loggedIn(res, api.base, serverUrl, `Password updated. Logged in as ${res.account.username}.`);
      });
    });
    return form;
  }
}
