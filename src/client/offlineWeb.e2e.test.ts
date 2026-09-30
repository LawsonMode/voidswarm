// LAN edition §7 (offline operation), T-PKG-4 and T-CL-3. The client is built with Vite into a scratch folder (never
// dist/), then:
//   T-PKG-4: no http(s):// (or protocol-relative //host) address in the built html, css or web manifest;
//   T-CL-3:  headless Chrome with every host but localhost unresolvable (--host-resolver-rules) renders the title
//            screen within 3 s (timed after a same-origin warm-up page; on CI a slow load gets one more try), loads
//            the self-hosted fonts, starts an offline match's Command screen, and requests nothing from any host but
//            the page's own.
// Chrome (or Edge / Chromium) is found at its usual install path or CHROME_PATH; without one the browser part is skipped.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

const PROJECT = fileURLToPath(new URL('../..', import.meta.url));
/** §7: "must render the title screen within 3 s". */
const TITLE_BUDGET_MS = 3000;
/**
 * Timed title loads allowed: on a shared CI runner (the Pages job runs this suite) one slow load is tried once more;
 * locally the first one counts. Either way each load is measured after a warm-up page, so Chrome's start-up (its
 * renderer process for the site) is not counted against the page.
 */
const TITLE_TRIES = process.env.CI ? 2 : 1;
/** A throwaway same-origin page (not part of the build) the browser loads before each timed load. */
const WARMUP_PATH = '/__warmup';

let outDir = '';
/** Scratch folders a first removal could not delete yet (Windows lets go of a browser profile late): retried in afterAll. */
const leftovers: string[] = [];

/**
 * Best-effort removal of a scratch folder: never fails a test. On Windows a folder Chrome (or its helper processes)
 * just used can stay locked for a moment after the browser exits, so the removal retries, and a folder still
 * locked is left for afterAll to try again.
 */
async function removeScratch(dir: string, tries: number): Promise<boolean> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: tries, retryDelay: 250 });
    return true;
  } catch {
    return false;
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'voidswarm-web-'));
  const { build } = await import('vite');
  // A production build (vitest sets NODE_ENV=test, which Vite would otherwise build with): restored right after.
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await build({
      configFile: join(PROJECT, 'vite.config.ts'),
      root: join(PROJECT, 'src', 'client'),
      mode: 'production',
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
  }
}, 120_000);

afterAll(async () => {
  for (const dir of [...leftovers, outDir].filter(Boolean)) {
    if (!(await removeScratch(dir, 40))) console.warn(`[offlineWeb.e2e] could not remove scratch folder ${dir} (still locked)`);
  }
}, 60_000);

describe('T-PKG-4: the built web client names no other host', () => {
  it('built into the scratch folder, not dist/', () => {
    expect(resolve(outDir).startsWith(resolve(PROJECT) + sep)).toBe(false);
    expect(existsSync(join(outDir, 'index.html'))).toBe(true);
  });

  it('no http(s):// or //host address in any html, css or web manifest', () => {
    const files = walk(outDir).filter((f) => ['.html', '.css', '.webmanifest'].includes(extname(f)));
    expect(files.map((f) => relative(outDir, f).split(sep).join('/')).sort()).toEqual(
      expect.arrayContaining(['index.html', 'manifest.webmanifest']));
    expect(files.some((f) => f.endsWith('.css'))).toBe(true);
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/https?:\/\/[^\s"'<>)]*/gi)) offenders.push(`${relative(outDir, f)}: ${m[0]}`);
      for (const m of text.matchAll(/(?:\b(?:href|src)\s*=\s*["']?|url\(\s*["']?)\/\/[^\s"'<>)]*/gi)) offenders.push(`${relative(outDir, f)}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the fonts are self-hosted: the latin woff2 files and their licence ship with the client', () => {
    for (const f of ['orbitron-latin-wght-normal.woff2', 'rajdhani-latin-500-normal.woff2', 'rajdhani-latin-600-normal.woff2',
      'rajdhani-latin-700-normal.woff2', 'OFL.txt']) {
      expect(existsSync(join(outDir, 'fonts', f))).toBe(true);
    }
    const woff2 = readdirSync(join(outDir, 'fonts')).filter((f) => f.endsWith('.woff2'));
    expect(woff2).toHaveLength(4);
    for (const f of woff2) expect(readFileSync(join(outDir, 'fonts', f)).subarray(0, 4).toString('latin1')).toBe('wOF2');
    const css = walk(outDir).filter((f) => f.endsWith('.css')).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(css).toMatch(/@font-face\s*\{[^}]*font-family:\s*["']?Orbitron/);
    expect(css).toMatch(/url\(["']?\/fonts\/orbitron-latin-wght-normal\.woff2/);
    expect(css).toMatch(/font-display:\s*swap/);
    const ofl = readFileSync(join(outDir, 'fonts', 'OFL.txt'), 'utf8');
    expect(ofl).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(ofl).toContain('The Orbitron Project Authors');
    expect(ofl).toContain('Indian Type Foundry');
    // no Google Fonts left anywhere in the build (scripts included)
    for (const f of walk(outDir).filter((p) => /\.(html|css|js|webmanifest)$/.test(p))) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    }
  });
});

// ---------------------------------------------------------------------------------------------- headless Chrome

function findChrome(): string | null {
  const env = process.env.CHROME_PATH;
  if (env && existsSync(env)) return env;
  const pf = process.env.PROGRAMFILES ?? 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA ?? '';
  const candidates = process.platform === 'win32'
    ? [
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      local ? `${local}\\Google\\Chrome\\Application\\chrome.exe` : '',
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
        '/snap/bin/chromium', '/usr/bin/microsoft-edge'];
  return candidates.find((c) => c && existsSync(c)) ?? null;
}

const CHROME = findChrome();

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
};

/** The built client on localhost (127.0.0.1):<ephemeral>, recording every path asked for. */
async function serveBuild(dir: string): Promise<{ server: Server; origin: string; paths: string[] }> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    paths.push(path);
    if (path === WARMUP_PATH) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><title>warm-up</title>');
      return;
    }
    const file = resolve(dir, `.${path.endsWith('/') ? `${path}index.html` : path}`);
    if (!file.startsWith(resolve(dir) + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  // "localhost", not 127.0.0.1: the resolver rules map every other name (IP literals included) to ~NOTFOUND
  return { server, origin: `http://localhost:${(server.address() as AddressInfo).port}`, paths };
}

/** A tiny Chrome DevTools Protocol client (flattened sessions) over `ws`. */
class Cdp {
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly events: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.reject(new Error(m.error.message)); else p?.resolve(m.result);
      } else if (m.method) {
        this.events.push({ method: m.method, params: m.params ?? {}, sessionId: m.sessionId });
      }
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
    return new Cdp(ws);
  }
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
  /** Send without waiting for (or caring about) the answer: Browser.close never gets one, the socket just ends. */
  fire(method: string, params: Record<string, unknown> = {}): void {
    try { this.ws.send(JSON.stringify({ id: ++this.seq, method, params })); } catch { /* gone */ }
  }
  close(): void { try { this.ws.close(); } catch { /* gone */ } }
}

/**
 * Shut Chrome down the way a user closing it would (CDP Browser.close): the browser then waits for its renderer,
 * GPU and utility processes, which let go of the profile folder. A plain kill() ends only the main process, and on
 * Windows its children keep the profile locked for a while. kill() stays as the fallback for a browser that hangs.
 */
async function closeChrome(proc: ChildProcess, cdp: Cdp | null): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((r) => proc.once('exit', () => r()));
  const exitWithin = (ms: number) => Promise.race([
    exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);
  if (cdp) {
    cdp.fire('Browser.close');
    if (await exitWithin(10_000)) return;
  }
  proc.kill();
  await exitWithin(5000);
}

async function launchChrome(exe: string, profile: string): Promise<{ proc: ChildProcess; wsUrl: string }> {
  const args = [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--disable-component-update', '--mute-audio', '--window-size=1280,720',
    // no crash-reporter process (it would outlive the browser and hold the profile's Crashpad folder)
    '--disable-breakpad', '--disable-crash-reporter',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    // every name but localhost fails to resolve: a request to any other host can only fail (and is recorded)
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
  ];
  if (process.platform === 'linux' && process.env.CI) args.push('--no-sandbox'); // CI containers lack the user-ns sandbox
  args.push('about:blank');
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise<string>((res, rej) => {
    let buf = '';
    const timer = setTimeout(() => rej(new Error(`Chrome did not start: ${buf.slice(-500)}`)), 30_000);
    proc.stderr!.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) { clearTimeout(timer); res(m[1]!); }
    });
    proc.once('exit', (code) => { clearTimeout(timer); rej(new Error(`Chrome exited (${code}): ${buf.slice(-500)}`)); });
  });
  return { proc, wsUrl };
}

async function evaluate<T>(cdp: Cdp, sessionId: string, expression: string, awaitPromise = false): Promise<T> {
  const r = await cdp.send<{ result: { value?: T }; exceptionDetails?: { text: string } }>(
    'Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId);
  if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.text}`);
  return r.result.value as T;
}

async function pollPage(cdp: Cdp, sessionId: string, expression: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluate<boolean>(cdp, sessionId, expression).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe.skipIf(!CHROME)('T-CL-3 (offline e2e): headless Chrome, no other host resolvable', () => {
  it('renders the title within 3 s, uses the self-hosted fonts, plays offline, and asks no other host for anything', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'voidswarm-chrome-'));
    const site = await serveBuild(outDir);
    let chrome: ChildProcess | null = null;
    let cdp: Cdp | null = null;
    try {
      const launched = await launchChrome(CHROME!, profile);
      chrome = launched.proc;
      cdp = await Cdp.connect(launched.wsUrl);
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Network.enable', {}, sessionId);
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      /** What the page said, for a failure message. */
      const diagnostics = async (): Promise<string> => {
        const logs = cdp!.events
          .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning')))
          .map((e) => JSON.stringify(e.params).slice(0, 400));
        const state = await evaluate<string>(cdp!, sessionId,
          `JSON.stringify({ href: location.href, ready: document.readyState, ui: (document.getElementById('ui')?.innerHTML ?? '').slice(0, 300) })`).catch((e) => String(e));
        return [`page: ${state}`, `served: ${site.paths.join(' ')}`, ...logs].join('\n');
      };

      const loadTitle = async (): Promise<{ up: boolean; ms: number }> => {
        // the warm-up page first: the site's renderer is running, and no title from an earlier load is on screen
        await cdp!.send('Page.navigate', { url: `${site.origin}${WARMUP_PATH}` }, sessionId);
        const warm = await pollPage(cdp!, sessionId,
          `location.pathname === ${JSON.stringify(WARMUP_PATH)} && document.readyState === 'complete'`, 15_000);
        expect(warm, warm ? '' : await diagnostics()).toBe(true);
        const t0 = Date.now();
        await cdp!.send('Page.navigate', { url: `${site.origin}/` }, sessionId);
        const up = await pollPage(cdp!, sessionId, `(() => {
          if (location.pathname !== '/') return false;
          const logo = document.querySelector('.screen-title.active .logo');
          const play = document.querySelector('.screen-title.active [data-nav="offline"]');
          return !!logo && !!play && logo.getBoundingClientRect().width > 0;
        })()`, 15_000);
        return { up, ms: Date.now() - t0 };
      };
      const loads: number[] = [];
      let title = { up: false, ms: Infinity };
      for (let i = 0; i < TITLE_TRIES && !(title.up && title.ms < TITLE_BUDGET_MS); i++) {
        title = await loadTitle();
        loads.push(title.ms);
      }
      expect(title.up, title.up ? '' : await diagnostics()).toBe(true);
      expect(title.ms, `the title took ${loads.join(' ms, then ')} ms`).toBeLessThan(TITLE_BUDGET_MS);

      // The fonts came from this server (the woff2 files), not from a font CDN or the system.
      const fonts = await evaluate<{ family: string; status: string }[]>(cdp, sessionId,
        `document.fonts.ready.then(() => document.fonts.load('900 1em Orbitron')).then(() => document.fonts.load('600 1em Rajdhani'))
          .then(() => [...document.fonts].map((f) => ({ family: f.family.replace(/["']/g, ''), status: f.status })))`, true);
      expect(fonts.some((f) => f.family === 'Orbitron' && f.status === 'loaded')).toBe(true);
      expect(fonts.some((f) => f.family === 'Rajdhani' && f.status === 'loaded')).toBe(true);
      expect(site.paths).toContain('/fonts/orbitron-latin-wght-normal.woff2');

      // Offline vs bots: the in-page zone lands on Command (still nothing from the network).
      await evaluate(cdp, sessionId, `document.querySelector('.screen-title.active [data-nav="offline"]').click()`);
      const commandUp = await pollPage(cdp, sessionId, `!!document.querySelector('.screen-command.active')`, 15_000);
      expect(commandUp, commandUp ? '' : await diagnostics()).toBe(true);
      await new Promise((r) => setTimeout(r, 750)); // stragglers

      const urls = [
        ...cdp.events.filter((e) => e.method === 'Network.requestWillBeSent').map((e) => String((e.params.request as { url: string }).url)),
        ...cdp.events.filter((e) => e.method === 'Network.webSocketCreated').map((e) => String(e.params.url)),
      ];
      expect(urls.length).toBeGreaterThan(3);
      const foreign = urls.filter((u) => {
        if (/^(data|blob|about):/i.test(u)) return false;
        try { return new URL(u).host !== new URL(site.origin).host; } catch { return true; }
      });
      expect(foreign).toEqual([]);
      const failed = cdp.events.filter((e) => e.method === 'Network.loadingFailed' && !e.params.canceled);
      expect(failed.map((e) => e.params.errorText)).toEqual([]);
    } finally {
      // Cleanup never fails the test: the browser closes politely, and the profile folder is removed best-effort.
      if (chrome) await closeChrome(chrome, cdp).catch(() => { /* already gone */ });
      cdp?.close();
      site.server.closeAllConnections();
      await new Promise<void>((r) => site.server.close(() => r()));
      if (!(await removeScratch(profile, 8))) leftovers.push(profile);
    }
  }, 90_000);
});
