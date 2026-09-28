// Minimal Chrome DevTools Protocol driver for the showcase capture (no puppeteer): launch a Chromium
// browser (Edge or Chrome) with --remote-debugging-port, attach to its page target over the 'ws' package,
// and expose send / evaluate / screenshot helpers.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

const BROWSERS = [
  process.env.SHOWCASE_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);

export function findBrowser() {
  const hit = BROWSERS.find((p) => existsSync(p));
  if (!hit) throw new Error('No Chromium browser found. Set SHOWCASE_BROWSER to the path of Chrome or Edge.');
  return hit;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 60) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (e) { last = e; }
    await sleep(250);
  }
  throw new Error(`CDP endpoint ${url} did not answer: ${last?.message ?? 'timeout'}`);
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method)?.delete(fn);
  }

  /** Evaluate an expression (or an async IIFE) in the page and return its JSON value. */
  async eval(expression, { timeout = 30000 } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true, timeout,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page eval failed: ${d.exception?.description ?? d.text}`);
    }
    return r.result?.value;
  }

  /** PNG screenshot of the viewport as a Buffer. */
  async screenshot() {
    const r = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    return Buffer.from(r.data, 'base64');
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/**
 * Launch the browser and return { cdp, close }. `headless` uses the new headless mode; WebGL runs on the
 * GPU where headless supports it, else on SwiftShader (both flags are passed; Chromium picks what works).
 */
export async function launch({ width = 1600, height = 900, port = 9391, tmpDir, headless = true, extraArgs = [] } = {}) {
  const exe = findBrowser();
  const profile = join(tmpDir, `profile-${Date.now()}`);
  mkdirSync(profile, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-features=Translate,msEdgeSidebarV2,msUndersideButton,EdgeCollections',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-device-scale-factor=1',
    '--hide-scrollbars',
    ...(headless ? ['--headless=new'] : []),
    ...extraArgs,
    'about:blank',
  ];
  const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const close = async () => {
    try { await cdp.send('Browser.close'); } catch { /* ignore */ }
    cdp.close();
    for (let i = 0; i < 40 && !exited; i++) await sleep(100);
    if (!exited) { try { proc.kill(); } catch { /* ignore */ } }
    for (let i = 0; i < 20; i++) {
      try { rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(250); }
    }
  };
  return { cdp, close, exe };
}

export function savePng(path, buf) { writeFileSync(path, buf); }
