// Quark adapter (docs/QUARK.md): optional school sign-in, an after-action note for the teacher, and the class chat panel.
// Quark is the school's local hub (student SSO, monitored chat, standards progress). It exists only when Voidswarm is
// served by Quark's games host, which also serves /quark-hub.js (sets window.QUARK_HUB). Anywhere else (GitHub Pages, the
// Voidswarm server, `npm run dev`) that file is missing, `available` stays false and nothing in the game changes.
//
// Rules (Quark integration guide): the hub address comes ONLY from /quark-hub.js (never the page URL); the token stays
// inside the SDK (never read, logged or stored here); the game sees just the gamertag and an opaque id; no student data
// goes anywhere else. Reports are for student-written work only: playing, winning and levels are never reported.

export const QUARK_APP_ID = 'app_voidswarm';
/** Activity ids are permanent (quark-manifest.json). */
export const ACTIVITY_AFTER_ACTION = 'after-action-note';
export const AFTER_ACTION_MIN = 20;
/** Lag Lab activities (quark-manifest.lag-lab.draft.json). Reporting stays OFF until Quark's catalog has the networking
 *  standards and a teacher has approved the manifest that lists these ids: reports for ids not in the approved manifest are refused. */
export const ACTIVITY_LAG_QUIZ = 'lag-lab-quiz';
export const ACTIVITY_LAG_REPORT = 'lag-lab-report';
export const LAG_LAB_REPORTING = false;
export const AFTER_ACTION_MAX = 2000;

export interface QuarkUser { id: string; name: string; role: string }
export interface QuarkLimit { code: string; message: string; until?: string | number | null }

interface QuarkSdk {
  init(o: { appId: string }): Promise<void>;
  signIn(o?: { silent?: boolean }): Promise<QuarkUser>;
  signOut(): Promise<void>;
  report(e: { verb: string; activity: string; result?: { score?: number; response?: string } }): void;
  on(name: string, cb: (...a: never[]) => void): () => void;
  chat: { mount(el: HTMLElement, o?: { channel?: string }): () => void };
  user: QuarkUser | null;
}
declare global {
  interface Window { QUARK_HUB?: unknown; Quark?: QuarkSdk }
}

function loadScript(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => { s.remove(); resolve(false); };
    document.head.appendChild(s);
  });
}

export class QuarkLink {
  /** True once the hub's SDK loaded and initialised: the UI shows its entries only then. */
  available = false;
  user: QuarkUser | null = null;
  /** Set while a teacher has limited this student (gameplay stops); cleared when it lapses or on sign-in / sign-out. */
  limit: QuarkLimit | null = null;
  notice = '';
  private sdk: QuarkSdk | null = null;
  private listeners = new Set<() => void>();
  private limitTimer: ReturnType<typeof setTimeout> | null = null;

  /** True while gameplay must stop (a teacher's access limit). */
  get blocked(): boolean { return this.limit?.code === 'access_limited'; }

  onChange(cb: () => void): void { this.listeners.add(cb); }
  private emit(): void { for (const cb of this.listeners) { try { cb(); } catch { /* a UI listener must not break the SDK */ } } }

  /** Never throws; resolves with `available`. */
  async start(): Promise<boolean> {
    // The static Pages build has no hub, so don't even ask for /quark-hub.js there.
    if (import.meta.env.MODE === 'pages' || typeof document === 'undefined') return false;
    try {
      if (!(await loadScript('/quark-hub.js'))) return false;
      const hub = window.QUARK_HUB;
      if (typeof hub !== 'string' || !/^https?:\/\/[^\s/]+$/.test(hub)) return false; // Vite's dev server answers any path with index.html
      if (!(await loadScript(`${hub}/sdk/v1/quark-sdk.js`)) || !window.Quark) return false;
      const sdk = window.Quark;
      await sdk.init({ appId: QUARK_APP_ID });
      this.sdk = sdk;
      this.user = sdk.user;
      sdk.on('signedIn', ((u: QuarkUser) => { this.user = u; this.setLimit(null); this.notice = ''; this.emit(); }) as never);
      sdk.on('signedOut', (() => { this.user = null; this.setLimit(null); this.emit(); }) as never);
      sdk.on('limited', ((l: QuarkLimit) => { this.setLimit(l); this.emit(); }) as never);
      sdk.on('incompatible', ((i: { message?: string }) => { this.notice = String(i?.message ?? 'Quark needs a newer game build.'); this.emit(); }) as never);
      // 'rejected' means one of our reports was refused: our bug, not the student's. Log it (never the token).
      sdk.on('rejected', ((r: { event?: unknown; error?: unknown }) => console.warn('[voidswarm] Quark rejected a report', r?.event, r?.error)) as never);
      this.available = true;
      this.emit();
      return true;
    } catch (e) {
      console.warn('[voidswarm] Quark unavailable', e);
      return false;
    }
  }

  private setLimit(l: QuarkLimit | null): void {
    if (this.limitTimer) { clearTimeout(this.limitTimer); this.limitTimer = null; }
    this.limit = l;
    const until = l?.until == null ? NaN : new Date(l.until).getTime();
    if (l && Number.isFinite(until)) {
      // The server enforces the limit; this only lifts the on-screen notice when its end time passes.
      this.limitTimer = setTimeout(() => { this.limitTimer = null; this.limit = null; this.emit(); }, Math.max(0, until - Date.now()) + 500);
    }
  }

  /** Call from a click (it opens a pop-up). Rejects with the SDK's error code. */
  async signIn(): Promise<void> {
    if (!this.sdk) throw new Error('not_available');
    await this.sdk.signIn();
  }

  async signOut(): Promise<void> { await this.sdk?.signOut(); }

  /** The student's own written reflection (private student work, shown to their teacher). No score: free writing isn't auto-graded. */
  submitAfterAction(text: string): boolean {
    const response = text.trim().slice(0, AFTER_ACTION_MAX);
    if (!this.sdk || !this.user || response.length < AFTER_ACTION_MIN) return false;
    this.sdk.report({ verb: 'submitted', activity: ACTIVITY_AFTER_ACTION, result: { response } });
    return true;
  }

  /** Whether a Lag Lab report can go to a teacher right now. */
  get canReportLagLab(): boolean { return LAG_LAB_REPORTING && !!this.sdk && !!this.user; }

  /** Lag Lab quiz: one report per session, an honest 0..1 score (the fraction right). 1.0 is `completed`, otherwise `failed`. */
  reportLagQuiz(score: number): void {
    if (!this.canReportLagLab || !(score >= 0 && score <= 1)) return;
    this.sdk?.report({ verb: score >= 1 ? 'completed' : 'failed', activity: ACTIVITY_LAG_QUIZ, result: { score } });
  }

  /** Lag Lab report: the student's own trial notebook and explanation (private student work). No score. */
  submitLagReport(text: string): boolean {
    const response = text.slice(0, 8000);
    if (!this.canReportLagLab || response.trim().length < 60) return false;
    this.sdk?.report({ verb: 'submitted', activity: ACTIVITY_LAG_REPORT, result: { response } });
    return true;
  }

  /** Quark's own class-chat panel (monitored and filtered by Quark). Returns the remover. */
  mountChat(el: HTMLElement): () => void {
    return this.sdk ? this.sdk.chat.mount(el) : () => {};
  }
}
