// LAN edition: the console banner, the window title and the one-line notices (docs/LAN-EDITION-proposal.md §5.1).
//
// Pure text builders (no I/O): launch.ts gathers the facts, console.ts prints. The banner is what a teacher sees
// on a projector, so it shows only the canonical address pair, the setup code (first run only; also filled in
// through the URL fragment) and the data folder with the Windows account name elided. It is printed once; after it
// the console stays silent except fatal errors and rare one-line notices.
//
//  VOIDSWARM LAN HOST 0.6.0 — keep this running (closing it stops the game)
//
//  Host Control Panel (this PC):  http://localhost:7778
//  Players join at:               http://192.168.1.50:7777   (start page)
//                                 https://192.168.1.50:7777  (secure)
//  Certificate:                   root #1  SHA-256 3F:9A:…:C2   (this PC's address only)
//  Data folder:                   C:\Users\…\Voidswarm LAN\data
//  First run — setup code:        K7QP-4MXD   (already filled in on the setup page)
//  Stop: Ctrl+C here, or Stop in the control panel. Tip: don't click inside this window.

import path from 'node:path';

/** Why the game listener is loopback only (players can't join yet). */
export type NotServingReason = 'setup' | 'public-network' | 'no-address' | 'unapproved-network' | 'this-pc-only';

export interface BannerCertificate {
  /** The root's number (#1, #2 … a new root per approved network). */
  rootNumber: number;
  /** SHA-256 of the root, as hex (with or without colons). */
  fingerprint: string;
  /** e.g. "this PC's address only" or "this network". */
  scope: string;
}

export interface BannerInfo {
  version: string;
  /** http://localhost:<A>/ */
  panelUrl: string;
  gamePort: number;
  /** The canonical LAN address (null: none found). */
  primary: string | null;
  /** Null when players can join; otherwise why not (the banner says so instead of an address). */
  notServing: NotServingReason | null;
  /** True when the game port also speaks https (B12's TLS identity exists). */
  https?: boolean;
  certificate?: BannerCertificate | null;
  dataDir: string;
  /** The first-run setup code (null once the host admin exists). Shown formatted (K7QP-4MXD). */
  setupCode?: string | null;
  /** Short warnings printed under the banner (elevated at Home, permissions at Home, marked files, …). */
  notes?: string[];
  /** For eliding the account name in the data path. */
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

/** The label column is this wide (the spec's layout). */
const LABEL_WIDTH = 32;
/** Notes printed under the banner at most. */
export const MAX_BANNER_NOTES = 6;
/** A note longer than this is cut (the full text is on the panel). */
export const NOTE_MAX_CHARS = 110;

const row = (label: string, value: string): string => ` ${label.padEnd(LABEL_WIDTH - 1)}${value}`;

/** K7QPMXD2 → K7QP-4MXD. Anything that is not 8 characters is shown as it is. */
export function formatSetupCode(code: string): string {
  const c = code.replace(/[\s-]/g, '').toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/** 3F9A…C2 (64 hex) → "3F:9A:…:C2": the first two bytes and the last one, as the spec shows it. */
export function shortFingerprint(fp: string): string {
  const hex = fp.replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length < 6) return hex;
  return `${hex.slice(0, 2)}:${hex.slice(2, 4)}:…:${hex.slice(-2)}`;
}

/**
 * The data folder for the banner: the Windows account's folder name is elided
 * (C:\Users\capta\Voidswarm LAN\data → C:\Users\…\Voidswarm LAN\data), and anything very long is shortened in the
 * middle. The projector audience never needs the account name.
 */
export function displayPath(p: string, opts: { env?: Record<string, string | undefined>; platform?: NodeJS.Platform; max?: number } = {}): string {
  const platform = opts.platform ?? process.platform;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const env = opts.env ?? process.env;
  const home = platform === 'win32' ? env.USERPROFILE ?? env.userprofile : env.HOME;
  let out = p;
  if (home) {
    const h = api.resolve(home);
    const target = api.resolve(p);
    const same = platform === 'win32' ? target.toLowerCase() : target;
    const base = platform === 'win32' ? h.toLowerCase() : h;
    if (same === base || same.startsWith(base.endsWith(api.sep) ? base : base + api.sep)) {
      out = api.join(api.dirname(h), '…') + target.slice(h.length);
    }
  }
  const max = opts.max ?? 70;
  if (out.length <= max) return out;
  const parts = out.split(api.sep);
  if (parts.length <= 4) return `${out.slice(0, 20)}…${out.slice(-(max - 21))}`;
  return [...parts.slice(0, 2), '…', ...parts.slice(-2)].join(api.sep);
}

function notServingText(reason: NotServingReason): string {
  switch (reason) {
    case 'setup':
      return 'after setup (only this PC until then)';
    case 'public-network':
      return "not on this network: it is set to Public (see the control panel)";
    case 'unapproved-network':
      return 'not on this new network until you approve it in the control panel';
    case 'this-pc-only':
      return 'this PC only (started with --this-pc-only)';
    case 'no-address':
    default:
      return 'no network address found (connect to Wi-Fi or Ethernet, then restart)';
  }
}

/** The banner, as lines (no trailing newline). */
export function bannerLines(info: BannerInfo): string[] {
  const lines: string[] = [];
  lines.push(` VOIDSWARM LAN HOST ${info.version} — keep this running (closing it stops the game)`);
  lines.push('');
  lines.push(row('Host Control Panel (this PC):', info.panelUrl.replace(/\/$/, '')));
  if (!info.notServing && info.primary) {
    const http = `http://${info.primary}:${info.gamePort}`;
    lines.push(row('Players join at:', `${http.padEnd(26)} (start page)`));
    if (info.https) lines.push(row('', `${`https://${info.primary}:${info.gamePort}`.padEnd(26)} (secure)`));
  } else {
    lines.push(row('Players join at:', notServingText(info.notServing ?? 'no-address')));
  }
  if (info.certificate) {
    const c = info.certificate;
    lines.push(row('Certificate:', `root #${c.rootNumber}  SHA-256 ${shortFingerprint(c.fingerprint)}   (${c.scope})`));
  }
  lines.push(row('Data folder:', displayPath(info.dataDir, { env: info.env, platform: info.platform })));
  if (info.setupCode) {
    lines.push(row('First run — setup code:', `${formatSetupCode(info.setupCode)}   (already filled in on the setup page)`));
  }
  lines.push(" Stop: Ctrl+C here, or Stop in the control panel. Tip: don't click inside this window.");
  const notes = (info.notes ?? []).filter((n) => n && n.trim());
  if (notes.length) {
    lines.push('');
    for (const n of notes.slice(0, MAX_BANNER_NOTES)) lines.push(` ! ${clip(oneLine(n), NOTE_MAX_CHARS)}`);
    if (notes.length > MAX_BANNER_NOTES) lines.push(` ! … and ${notes.length - MAX_BANNER_NOTES} more on the control panel`);
  }
  return lines;
}

export function formatBanner(info: BannerInfo): string {
  return `${bannerLines(info).join('\n')}\n`;
}

export interface TitleInfo {
  state: 'starting' | 'running' | 'restarting' | 'stopping';
  online?: number | null;
  rooms?: number | null;
  primary?: string | null;
  gamePort?: number | null;
  /** Players can't join (loopback only). */
  notServing?: boolean;
}

/** The console window title, updated every 5 s: `Voidswarm Host · 12 online · 3 rooms · 192.168.1.50:7777`. */
export function windowTitle(t: TitleInfo): string {
  const parts = ['Voidswarm Host'];
  if (t.state === 'starting') parts.push('starting…');
  else if (t.state === 'restarting') parts.push('restarting…');
  else if (t.state === 'stopping') parts.push('stopping…');
  else {
    if (typeof t.online === 'number') parts.push(`${t.online} online`);
    if (typeof t.rooms === 'number') parts.push(`${t.rooms} room${t.rooms === 1 ? '' : 's'}`);
  }
  if (t.gamePort) parts.push(t.notServing || !t.primary ? `this PC only (:${t.gamePort})` : `${t.primary}:${t.gamePort}`);
  return parts.join(' · ');
}

/** HH:MM in local time (the notices and the restart banner). */
export function clockTime(at: number | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The panel banner and console line after a supervised restart (§2.2 step 14). */
export function restartNotice(at: number | Date): string {
  return `The server restarted after an error at ${clockTime(at)}.`;
}

/** One console notice line: `10:14 <text>` (a single line, however the text came in). */
export function noticeLine(text: string, at: number | Date = Date.now()): string {
  return `${clockTime(at)} ${oneLine(text)}`;
}

/**
 * C0 / C1 control characters (ESC starts a VT sequence: clear the window, move the cursor, retitle it) and the
 * bidirectional overrides. \n is handled by the callers.
 */
const CONSOLE_UNSAFE_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/**
 * Text that is safe to print in the console window. Notices and error messages can come from the server child (the
 * network-facing process), so an escape sequence in one must never clear the window or fake the banner's address
 * or setup code. Tabs become spaces, other control characters and bidi overrides are removed; `multiline` keeps
 * line breaks (a refusal's full message), otherwise they collapse to one space.
 */
export function consoleSafe(s: string, multiline = false): string {
  const t = String(s).replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(CONSOLE_UNSAFE_RE, '');
  return multiline ? t : t.replace(/\s*\n\s*/g, ' ');
}

function oneLine(s: string): string {
  return consoleSafe(s).trim();
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
