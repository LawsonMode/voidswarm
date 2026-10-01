#!/usr/bin/env node
// OWNER: PACKAGING (LAN task B11). `npm run package:lan`: builds the Windows LAN edition zip
// (docs/LAN-EDITION-proposal.md §2.1 folder layout, §2.3 build script, §11.1 T-PKG-1…7).
//
//   node scripts/build-lan.mjs [--out <dir>] [--node <node.exe>] [--keep-stage] [--no-zip]
//     --out <dir>      where the stage and the zip go (default release/; never dist/, which a live server may serve)
//                      (checkOutDir: never dist/ however it is reached, never a network share or mapped drive, and
//                      inside the repository only where git ignores it)
//     --node <file>    the node.exe to ship (default: the Node running this script, process.execPath)
//     --keep-stage     keep <out>/stage/Voidswarm LAN after zipping (it is always kept with --no-zip)
//     --no-zip         stop after the staged tree and SHA256SUMS.txt (a quick local check)
//   node scripts/build-lan.mjs --run [-- <launcher flags>]   (`npm run lan`: the launcher from source, §10)
//     bundles app\ into <out>/dev/Voidswarm LAN (no zip, no runtime copy), uses the built client in dist/ when there
//     is one (`npm run build` first), and runs app\launch.mjs with this Node, flags passed through.
//
// Steps (§2.3):
//   1. the web client: vite build into <stage>\web (emptied first); it fails on any http(s):// or //host address in the
//      built html, css or web manifest (§7: the LAN edition is offline by design);
//   2. the esbuild JS API (0.28.2): src/server/index.ts → app/server.mjs, src/lan/launch.ts → app/launch.mjs,
//      src/lan/tool.ts → app/tool.mjs, src/server/maint/worker.ts → app/maint.mjs. platform node, target node24, esm,
//      unminified, legalComments 'inline', bufferutil / utf-8-validate external, a createRequire banner (ws, nodemailer);
//   3. the static pages: src/server/moderation/admin → app/admin, src/lan/display → app/display (and, once M2 lands
//      them, src/lan/landing → app/landing, src/lan/check → app/check): page files only, never tests or TypeScript;
//   4. the runtime: node.exe (Node 24, and on Windows an Authenticode signature that is Valid and from the OpenJS
//      Foundation; the copy keeps it) → runtime\node.exe, scripts/lan/vendor/node-LICENSE → runtime\LICENSE;
//   5. the text files from scripts/lan/templates (the stubs, START HERE.html, FOR SCHOOL IT.txt, the notices,
//      VERSION.txt) with the version filled in, and app/build-info.json. Windows text files get CRLF line endings;
//   6. SHA256SUMS.txt over every file, then Windows tar (-a: the .zip format) → <out>/voidswarm-lan-<v>-win-x64.zip
//      with its .sha256 beside it. The zip's top-level folder is "Voidswarm LAN" (it carries no version).
// Uses only this project's node_modules and the Node that runs it; no downloads.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The zip's top-level folder (§2.1: no version in it, so the root path survives updates). */
export const LAN_FOLDER = 'Voidswarm LAN';
/** 0.6.x ships Node 24 (§2.1, §2.3 step 4). */
export const NODE_MAJOR = 24;
/** T-PKG-1: the zip is 40 MB or less. */
export const ZIP_MAX_BYTES = 40 * 1024 * 1024;
/** Authenticode subject of the official node.exe. */
export const NODE_SIGNER = 'OpenJS Foundation';
export const SUMS_FILE = 'SHA256SUMS.txt';
export const TEMPLATES_DIR = path.join(PROJECT_ROOT, 'scripts', 'lan', 'templates');
export const NODE_LICENSE = path.join(PROJECT_ROOT, 'scripts', 'lan', 'vendor', 'node-LICENSE');

/** The four bundles (§2.3 step 2): output name → entry, relative to the project. */
export const APP_ENTRIES = Object.freeze({
  server: 'src/server/index.ts',
  launch: 'src/lan/launch.ts',
  tool: 'src/lan/tool.ts',
  maint: 'src/server/maint/worker.ts',
});

/** The static page folders (§2.3 step 3): source → app\ subfolder. `later` ones arrive with M2 and are copied once they exist. */
export const STATIC_PAGES = Object.freeze([
  { from: 'src/server/moderation/admin', to: 'admin', later: false },
  { from: 'src/lan/display', to: 'display', later: false },
  { from: 'src/lan/landing', to: 'landing', later: true },
  { from: 'src/lan/check', to: 'check', later: true },
]);

/** The page files a static folder may ship (never TypeScript, tests or test helpers). */
const PAGE_EXT = new Set(['.html', '.css', '.js', '.mjs', '.svg', '.png', '.ico', '.woff2', '.txt', '.json', '.webmanifest']);
export function isPageFile(name) {
  const lower = name.toLowerCase();
  if (/\.(test|testutil|spec)\./.test(lower) || lower.endsWith('.d.ts')) return false;
  return PAGE_EXT.has(path.extname(lower));
}

/**
 * The .cmd stubs at the root (§2.1). Their contract (entry points) is frozen for 0.6.x. `later` = made by a later task
 * (the firewall stub is B14, M2): shipped once its template exists. "Allow Voidswarm (for IT).cmd" (0.6.0-m1.1) is the
 * one file meant to run elevated, by IT: it only calls System32's netsh / PowerShell (adds the inbound program rule for
 * runtime\node.exe on the Domain and Private profiles), never node.exe.
 */
export const STUBS = Object.freeze([
  { name: 'Start Voidswarm Host.cmd', later: false },
  { name: 'Update Voidswarm.cmd', later: false },
  { name: 'Reset admin password.cmd', later: false },
  { name: 'Restore a backup.cmd', later: false },
  { name: 'Allow Voidswarm (for IT).cmd', later: false },
  { name: 'Allow through firewall (admin).cmd', later: true },
]);

/** The root text files besides the stubs (§2.1). */
export const ROOT_DOCS = Object.freeze(['START HERE.html', 'FOR SCHOOL IT.txt', 'VERSION.txt', 'THIRD-PARTY-NOTICES.txt', SUMS_FILE]);

/** `import.meta.url` is the bundle's own file: `require` for ws and nodemailer's CommonJS inside the ESM bundle. */
export const CREATE_REQUIRE_BANNER = "import { createRequire as __vsCreateRequire } from 'node:module'; const require = __vsCreateRequire(import.meta.url);";

export const zipName = (version) => `voidswarm-lan-${version}-win-x64.zip`;

const CRLF_EXT = new Set(['.cmd', '.bat', '.txt']);
const toCrlf = (s) => s.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
const errMsg = (e) => String(e?.message ?? e);

class BuildError extends Error {}

export function readVersion(projectRoot = PROJECT_ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? '')) throw new BuildError(`package.json has no usable version (${pkg.version})`);
  return pkg.version;
}

/** Every file under dir (relative, forward slashes), sorted. Links are reported, never followed. */
export function walkFiles(dir) {
  const out = [];
  const visit = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) throw new BuildError(`${r} is a link: the package must hold plain files only`);
      if (ent.isDirectory()) visit(a, r);
      else if (ent.isFile()) out.push(r);
    }
  };
  visit(dir, '');
  return out.sort();
}

// ---------------------------------------------------------------------------------------------- 1. the web client

/**
 * The http:// strings the built JS / SVG may hold that are never fetched: XML namespace names (createElementNS, the
 * SVG xmlns) and pixi.js's console banner. Exact matches only; anything else is an offender (T-PKG-4).
 */
export const NON_FETCH_URLS = Object.freeze([
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/XML/1998/namespace',
  'http://www.w3.org/2000/xmlns/',
  'http://www.w3.org/1998/Math/MathML',
  'http://www.pixijs.com/',
]);

/**
 * http(s):// addresses in the built web files (html, css, web manifest, js, mjs, svg, json) and protocol-relative
 * //host addresses in the html, css and manifest (§7, T-PKG-4). In JS and SVG the NON_FETCH_URLS are allowed.
 * Licence texts (.txt) and binary assets are not scanned.
 */
export function findExternalUrls(webDir) {
  const offenders = [];
  for (const rel of walkFiles(webDir)) {
    const markup = /\.(html|css|webmanifest)$/i.test(rel);
    const code = /\.(m?js|svg|json)$/i.test(rel);
    if (!markup && !code) continue;
    const text = fs.readFileSync(path.join(webDir, rel), 'utf8');
    for (const m of text.matchAll(/https?:\/\/[^\s"'`<>)\\]*/gi)) {
      if (code && NON_FETCH_URLS.includes(m[0])) continue;
      offenders.push(`${rel}: ${m[0]}`);
    }
    if (markup) for (const m of text.matchAll(/(?:\b(?:href|src)\s*=\s*["']?|url\(\s*["']?)\/\/[^\s"'<>)]*/gi)) offenders.push(`${rel}: ${m[0]}`);
  }
  return offenders;
}

export async function buildWeb(webDir, { projectRoot = PROJECT_ROOT, log = () => {}, quiet = false } = {}) {
  const { build } = await import('vite');
  // A production build (vitest sets NODE_ENV=test) with the root base: the LAN server serves the client at /.
  const saved = { NODE_ENV: process.env.NODE_ENV, VITE_BASE: process.env.VITE_BASE };
  process.env.NODE_ENV = 'production';
  delete process.env.VITE_BASE;
  try {
    await build({
      configFile: path.join(projectRoot, 'vite.config.ts'),
      root: path.join(projectRoot, 'src', 'client'),
      mode: 'production',
      logLevel: quiet ? 'silent' : 'warn',
      build: { outDir: webDir, emptyOutDir: true },
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  if (!fs.existsSync(path.join(webDir, 'index.html'))) throw new BuildError('the web build made no index.html');
  const offenders = findExternalUrls(webDir);
  if (offenders.length) throw new BuildError(`the built client names another host (the LAN edition must work offline):\n  ${offenders.join('\n  ')}`);
  log(`web client: ${walkFiles(webDir).length} files`);
}

// ---------------------------------------------------------------------------------------------- 2. the bundles

/** The esbuild options of §2.3 step 2 (the tests bundle a fixture with the same ones). */
export function appBuildOptions(appDir, { projectRoot = PROJECT_ROOT, entryPoints = APP_ENTRIES } = {}) {
  return {
    absWorkingDir: projectRoot,
    entryPoints: { ...entryPoints },
    outdir: appDir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    minify: false,
    legalComments: 'inline',
    charset: 'utf8',
    external: ['bufferutil', 'utf-8-validate'],
    banner: { js: CREATE_REQUIRE_BANNER },
    metafile: true,
    logLevel: 'silent',
  };
}

export async function bundleApp(appDir, { projectRoot = PROJECT_ROOT, log = () => {} } = {}) {
  const esbuild = await import('esbuild');
  const r = await esbuild.build(appBuildOptions(appDir, { projectRoot }));
  for (const w of r.warnings) log(`esbuild: ${w.text}${w.location ? ` (${w.location.file}:${w.location.line})` : ''}`);
  for (const name of Object.keys(APP_ENTRIES)) {
    if (!fs.existsSync(path.join(appDir, `${name}.mjs`))) throw new BuildError(`esbuild made no app/${name}.mjs`);
  }
  return r.metafile;
}

/** The licence comments (`/*!`, @license, @preserve) in the files esbuild bundled into one output (T-PKG-7). */
export function legalCommentsOf(metafile, output, projectRoot = PROJECT_ROOT) {
  const out = metafile.outputs[output];
  if (!out) return [];
  const found = new Set();
  for (const input of Object.keys(out.inputs)) {
    let text;
    try { text = fs.readFileSync(path.resolve(projectRoot, input), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/\/\*[!*][\s\S]*?\*\//g)) {
      if (m[0].startsWith('/*!') || /@license|@preserve/.test(m[0])) found.add(m[0]);
    }
    for (const m of text.matchAll(/\/\/[!].*|\/\/.*@(?:license|preserve).*/g)) found.add(m[0].trimEnd());
  }
  return [...found];
}

// ---------------------------------------------------------------------------------------------- 3. the static pages

export function copyStaticPages(appDir, { projectRoot = PROJECT_ROOT, log = () => {} } = {}) {
  const copied = {};
  for (const p of STATIC_PAGES) {
    const src = path.join(projectRoot, p.from);
    if (!fs.existsSync(src)) {
      if (!p.later) throw new BuildError(`${p.from} is missing`);
      continue;
    }
    const dest = path.join(appDir, p.to);
    fs.mkdirSync(dest, { recursive: true });
    const files = fs.readdirSync(src, { withFileTypes: true }).filter((e) => e.isFile() && isPageFile(e.name)).map((e) => e.name).sort();
    if (!files.some((f) => f.endsWith('.html'))) throw new BuildError(`${p.from} has no page (.html)`);
    for (const f of files) fs.copyFileSync(path.join(src, f), path.join(dest, f));
    copied[p.to] = files;
    log(`app/${p.to}: ${files.join(', ')}`);
  }
  return copied;
}

// ---------------------------------------------------------------------------------------------- 4. the runtime

function systemExe(name) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  if (name === 'powershell') return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return path.win32.join(root, 'System32', `${name}.exe`);
}

/** Get-AuthenticodeSignature of a file (Windows): the path goes in an env var, never into the script text. */
export function authenticode(file) {
  const script = '$s = Get-AuthenticodeSignature -LiteralPath $env:VS_FILE; '
    + '[pscustomobject]@{ status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress';
  // Drop an inherited PowerShell 7 PSModulePath: Windows PowerShell 5.1 would load PS7's modules and the cmdlet fails silently.
  const env = { ...process.env, VS_FILE: file };
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'psmodulepath') delete env[k];
  const r = spawnSync(systemExe('powershell'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env, encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  if (r.status !== 0) return { status: 'Unknown', subject: null, error: (r.stderr || r.error?.message || '').trim().slice(0, 300) };
  try {
    const j = JSON.parse(r.stdout.trim());
    return { status: String(j.status ?? 'Unknown'), subject: j.subject ? String(j.subject) : null };
  } catch {
    return { status: 'Unknown', subject: null, error: r.stdout.trim().slice(0, 300) };
  }
}

/** True for a signer subject naming the OpenJS Foundation (CN and O). */
export const isOpenJsSubject = (subject) => typeof subject === 'string'
  && /(^|,\s*)CN=OpenJS Foundation(,|$)/.test(subject) && /(^|,\s*)O=OpenJS Foundation(,|$)/.test(subject);

/** §2.3 step 4 (T-PKG-3): Node major 24 and, on Windows, a Valid Authenticode signature from the OpenJS Foundation. */
export function checkNodeRuntime(nodeExe, { platform = process.platform } = {}) {
  let version;
  if (path.resolve(nodeExe) === path.resolve(process.execPath)) version = process.version;
  else {
    const r = spawnSync(nodeExe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    version = (r.stdout ?? '').trim();
  }
  const m = /^v(\d+)\.\d+\.\d+/.exec(version ?? '');
  if (!m) throw new BuildError(`${nodeExe} did not report a Node version`);
  if (Number(m[1]) !== NODE_MAJOR) throw new BuildError(`the runtime must be Node ${NODE_MAJOR}.x; ${nodeExe} is ${version}`);
  let signature = null;
  if (platform === 'win32') {
    signature = authenticode(nodeExe);
    if (signature.status !== 'Valid' || !isOpenJsSubject(signature.subject)) {
      throw new BuildError(`${nodeExe} must carry a Valid signature from the ${NODE_SIGNER} (found ${signature.status}${signature.subject ? `, ${signature.subject}` : ''}${signature.error ? `: ${signature.error}` : ''}). Use the official node.exe from nodejs.org.`);
    }
  }
  return { version, major: Number(m[1]), signature };
}

export function copyRuntime(runtimeDir, nodeExe) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(nodeExe, path.join(runtimeDir, 'node.exe'));
  if (!fs.existsSync(NODE_LICENSE)) throw new BuildError('scripts/lan/vendor/node-LICENSE is missing');
  fs.writeFileSync(path.join(runtimeDir, 'LICENSE'), toCrlf(fs.readFileSync(NODE_LICENSE, 'utf8')));
}

// ---------------------------------------------------------------------------------------------- 5. the text files

/** {{NAME}} placeholders: VERSION, NODE_VERSION, BUILD_DATE, BUILD_DAY, NOTICES. An unknown one is an error. */
export function fillTemplate(text, values) {
  return text.replace(/\{\{\s*([A-Z_]+)\s*\}\}/g, (all, k) => {
    if (!(k in values)) throw new BuildError(`unknown template placeholder ${all}`);
    return String(values[k]);
  });
}

/** The production dependencies (package-lock, not dev, not @types), with their licence texts. */
export function productionPackages(projectRoot = PROJECT_ROOT) {
  const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
  const out = [];
  for (const [key, v] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/') || v.dev || key.includes('/@types/')) continue;
    const dir = path.join(projectRoot, key);
    if (!fs.existsSync(dir)) continue; // an optional one not installed on this platform
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    let text = null;
    const lic = fs.readdirSync(dir).filter((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f)).sort()[0];
    if (lic) text = fs.readFileSync(path.join(dir, lic), 'utf8').trim();
    let author = null;
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      author = typeof pj.author === 'string' ? pj.author : pj.author?.name ?? null;
    } catch { /* none */ }
    out.push({ name, version: v.version ?? '?', license: v.license ?? 'see the package', author, text });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function noticesText(projectRoot = PROJECT_ROOT) {
  const parts = [];
  for (const p of productionPackages(projectRoot)) {
    parts.push([
      '-'.repeat(78),
      `${p.name} ${p.version} (${p.license})`,
      '-'.repeat(78),
      p.text ?? `Licensed under ${p.license}${p.author ? ` by ${p.author}` : ''}. (The package ships no licence file.)`,
    ].join('\n'));
  }
  return parts.join('\n\n');
}

export function writeTexts(stageRoot, values, { templatesDir = TEMPLATES_DIR, log = () => {} } = {}) {
  const written = [];
  for (const name of fs.readdirSync(templatesDir).sort()) {
    const src = path.join(templatesDir, name);
    if (!fs.statSync(src).isFile()) continue;
    if (name.toLowerCase().endsWith('.cmd') && !STUBS.some((s) => s.name === name)) throw new BuildError(`${name} is not one of the stubs in §2.1`);
    let text = fillTemplate(fs.readFileSync(src, 'utf8'), values);
    if (CRLF_EXT.has(path.extname(name).toLowerCase())) text = toCrlf(text);
    fs.writeFileSync(path.join(stageRoot, name), text);
    written.push(name);
  }
  for (const s of STUBS) if (!s.later && !written.includes(s.name)) throw new BuildError(`the template for ${s.name} is missing`);
  log(`root: ${written.join(', ')}`);
  return written;
}

// ---------------------------------------------------------------------------------------------- 6. sums and zip

export function sha256Of(file) {
  const h = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/** SHA256SUMS.txt: `<hex>  <path>` for every file but itself, forward slashes, sorted, CRLF. */
export function writeSums(stageRoot) {
  const lines = walkFiles(stageRoot).filter((f) => f !== SUMS_FILE).map((f) => `${sha256Of(path.join(stageRoot, f))}  ${f}`);
  fs.writeFileSync(path.join(stageRoot, SUMS_FILE), `${lines.join('\r\n')}\r\n`);
  return lines.length;
}

/**
 * The staged tree against §2.1 (T-PKG-2): the stubs (a later task's may be missing), the root text files,
 * runtime\node.exe + LICENSE, the four bundles and build-info.json, the page folders, web\index.html. Nothing else at
 * the top level, and never data\ or previous\ (those are made on the host). Returns the problems (empty = ok).
 */
export function checkStageManifest(stageRoot) {
  const problems = [];
  const files = new Set(walkFiles(stageRoot));
  const top = new Set(fs.readdirSync(stageRoot));
  const allowedTop = new Set([...STUBS.map((s) => s.name), ...ROOT_DOCS, 'runtime', 'app', 'web']);
  for (const t of top) if (!allowedTop.has(t)) problems.push(`unexpected at the top level: ${t}`);
  for (const s of STUBS) if (!s.later && !files.has(s.name)) problems.push(`missing stub: ${s.name}`);
  for (const d of ROOT_DOCS) if (!files.has(d)) problems.push(`missing: ${d}`);
  for (const f of ['runtime/node.exe', 'runtime/LICENSE', 'app/build-info.json', 'web/index.html', ...Object.keys(APP_ENTRIES).map((n) => `app/${n}.mjs`)]) {
    if (!files.has(f)) problems.push(`missing: ${f}`);
  }
  const runtimeFiles = [...files].filter((f) => f.startsWith('runtime/'));
  if (runtimeFiles.length !== 2) problems.push(`runtime\\ must hold only node.exe and LICENSE (found ${runtimeFiles.join(', ')})`);
  const appTop = new Set([...files].filter((f) => f.startsWith('app/')).map((f) => f.slice(4).split('/')[0]));
  const allowedApp = new Set([...Object.keys(APP_ENTRIES).map((n) => `${n}.mjs`), 'build-info.json', ...STATIC_PAGES.map((p) => p.to)]);
  for (const a of appTop) if (!allowedApp.has(a)) problems.push(`unexpected in app\\: ${a}`);
  for (const p of STATIC_PAGES) {
    const inDir = [...files].filter((f) => f.startsWith(`app/${p.to}/`));
    if (!p.later && !inDir.length) problems.push(`missing: app/${p.to}/`);
    for (const f of inDir) if (!isPageFile(path.basename(f)) || f.split('/').length !== 3) problems.push(`not a page file: ${f}`);
  }
  return problems;
}

export function makeZip(stageParent, zipFile) {
  fs.rmSync(zipFile, { force: true });
  const tar = process.platform === 'win32' ? systemExe('tar') : 'tar';
  // -a picks the format from the .zip suffix (bsdtar/libarchive: Windows 10+ ships it as System32\tar.exe).
  const r = spawnSync(tar, ['-a', '-c', '-f', zipFile, '-C', stageParent, LAN_FOLDER], { encoding: 'utf8', windowsHide: true, timeout: 10 * 60_000 });
  if (r.status !== 0 || !fs.existsSync(zipFile)) throw new BuildError(`tar could not make the zip: ${(r.stderr || r.error?.message || '').trim()}`);
  const hex = sha256Of(zipFile);
  fs.writeFileSync(`${zipFile}.sha256`, `${hex}  ${path.basename(zipFile)}\r\n`);
  return { hex, size: fs.statSync(zipFile).size };
}

// ---------------------------------------------------------------------------------------------- the whole build

const stamp = () => new Date().toISOString();

const platform0 = (opts) => opts.platform ?? process.platform;

/** Is `p` the folder `dir` or inside it? Case-insensitive on Windows (so --out ...\DIST is caught), with real paths when they exist. */
export function isInside(p, dir, platform = process.platform) {
  const a = normPath(p, platform);
  const b = normPath(dir, platform);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

function normPath(x, platform) {
  let r = path.resolve(x);
  try { r = path.resolve(fs.realpathSync.native(r)); } catch { /* not there yet */ }
  return platform === 'win32' ? r.toLowerCase() : r;
}

/** dev:ino of a folder or file, or null (missing, or a file system that reports none). */
function identityOf(p) {
  try {
    const s = fs.statSync(p, { bigint: true });
    return s.dev && s.ino ? `${s.dev}:${s.ino}` : null;
  } catch {
    return null;
  }
}

/**
 * Where `p` lands inside `dir`, spelled under dir, or null when it is outside. Found by path (isInside), or by
 * identity: an existing ancestor of p that IS dir reached another way (a mapped drive such as A:\ = C:\AI Bins, a
 * share, a junction, subst), which a path comparison can't see.
 */
export function placeUnder(p, dir, platform = process.platform) {
  const base = path.resolve(dir);
  if (isInside(p, dir, platform)) return path.join(base, path.relative(normPath(dir, platform), normPath(p, platform)));
  const want = identityOf(base);
  if (!want) return null;
  const tail = [];
  for (let cur = path.resolve(p); ;) {
    if (identityOf(cur) === want) return path.join(base, ...tail.reverse());
    const up = path.dirname(cur);
    if (up === cur) return null;
    tail.push(path.basename(cur));
    cur = up;
  }
}

/** A path on a network share (UNC, or a mapped drive: its nearest existing folder's real path is \\server\share\…). */
export function isNetworkPath(p, platform = process.platform) {
  if (platform !== 'win32') return false;
  const unc = (x) => /^[\\/]{2}/.test(x) && !/^[\\/]{2}[?.][\\/][A-Za-z]:/.test(x);
  if (unc(path.resolve(p))) return true;
  for (let cur = path.resolve(p); ;) {
    try { return unc(fs.realpathSync.native(cur)); } catch { /* not there yet: its parent */ }
    const up = path.dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

/** git check-ignore: true / false, or null when there is no git or no repository. */
export function gitIgnores(projectRoot, file) {
  const r = spawnSync('git', ['-C', projectRoot, 'check-ignore', '-q', '--', file], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (r.error || r.status === null) return null;
  return r.status === 0 ? true : r.status === 1 ? false : null;
}

/**
 * The output folder guard (both the package build and `npm run lan`): never dist/ (a live server may be serving it),
 * however it is spelled or reached; never a network share (it can alias dist/ in ways no check sees, and the build
 * writes node.exe and a 35 MB zip); and inside this repository only where git ignores it (the owner's sync routine
 * runs `git add -A` and pushes to a public repo; the dev run writes data\secrets there).
 */
export function checkOutDir(out, { projectRoot = PROJECT_ROOT, platform = process.platform, gitIgnored = gitIgnores } = {}) {
  const dist = path.resolve(projectRoot, 'dist');
  if (placeUnder(out, dist, platform) !== null) throw new BuildError('--out must not be dist/ (the built client a running server may be serving)');
  if (isNetworkPath(out, platform)) throw new BuildError(`--out must be a folder on this PC, not a network share or mapped drive (${out})`);
  const inRepo = placeUnder(out, projectRoot, platform);
  if (inRepo !== null) {
    const ignored = gitIgnored(projectRoot, path.join(inRepo, '.voidswarm-lan-probe'));
    if (ignored === false) {
      throw new BuildError(`--out ${path.relative(projectRoot, inRepo) || '.'} is inside the repository but git does not ignore it: add it to .gitignore (/release/) or pass --out <folder outside the project>`);
    }
  }
}

/**
 * Builds the package. Returns { version, stageRoot, zip, sha256, size, node }. `out` must not be dist/ (a live server
 * may be serving it); the stage is <out>/stage/Voidswarm LAN.
 */
export async function buildLan(opts = {}) {
  const projectRoot = opts.projectRoot ?? PROJECT_ROOT;
  const log = opts.log ?? ((l) => process.stdout.write(`${l}\n`));
  const out = path.resolve(opts.out ?? path.join(projectRoot, 'release'));
  checkOutDir(out, { projectRoot, platform: platform0(opts), gitIgnored: opts.gitIgnored });
  const nodeExe = path.resolve(opts.node ?? process.execPath);
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32' && !opts.node) throw new BuildError('package:lan builds the Windows (win-x64) zip: run it on Windows, or pass --node <node.exe>');
  const version = opts.version ?? readVersion(projectRoot);
  const runtime = checkNodeRuntime(nodeExe, { platform });
  log(`Voidswarm LAN ${version}: runtime ${runtime.version}${runtime.signature ? ` (${runtime.signature.status}, ${NODE_SIGNER})` : ''}`);

  const stageParent = path.join(out, 'stage');
  const stageRoot = path.join(stageParent, LAN_FOLDER);
  fs.rmSync(stageParent, { recursive: true, force: true });
  fs.mkdirSync(stageRoot, { recursive: true });
  const app = path.join(stageRoot, 'app');

  await buildWeb(path.join(stageRoot, 'web'), { projectRoot, log, quiet: opts.quiet === true });
  const metafile = await bundleApp(app, { projectRoot, log });
  const serverOut = Object.keys(metafile.outputs).find((o) => /(^|\/)server\.mjs$/.test(o));
  copyStaticPages(app, { projectRoot, log });
  copyRuntime(path.join(stageRoot, 'runtime'), nodeExe);
  const buildDate = opts.buildDate ?? stamp();
  fs.writeFileSync(path.join(app, 'build-info.json'), `${JSON.stringify({
    name: 'voidswarm-lan', version, node: runtime.version, platform: 'win-x64', buildDate,
  }, null, 2)}\n`);
  writeTexts(stageRoot, {
    VERSION: version, NODE_VERSION: runtime.version, BUILD_DATE: buildDate, BUILD_DAY: buildDate.slice(0, 10),
    NOTICES: noticesText(projectRoot),
  }, { log });
  const n = writeSums(stageRoot);
  const problems = checkStageManifest(stageRoot);
  if (problems.length) throw new BuildError(`the staged tree does not match §2.1:\n  ${problems.join('\n  ')}`);
  log(`staged ${n + 1} files in ${stageRoot}`);

  const result = { version, stageRoot, zip: null, sha256: null, size: 0, node: runtime.version, metafile, serverOutput: serverOut ?? null };
  if (opts.zip === false) return result;
  const zipFile = path.join(out, zipName(version));
  const z = makeZip(stageParent, zipFile);
  if (z.size > ZIP_MAX_BYTES) throw new BuildError(`the zip is ${(z.size / 1048576).toFixed(1)} MB: more than the ${ZIP_MAX_BYTES / 1048576} MB budget (T-PKG-1)`);
  log(`${zipFile}  ${(z.size / 1048576).toFixed(1)} MB\nSHA-256 ${z.hex}`);
  if (!opts.keepStage) fs.rmSync(stageParent, { recursive: true, force: true });
  return { ...result, zip: zipFile, sha256: z.hex, size: z.size, stageRoot: opts.keepStage ? stageRoot : null };
}

/**
 * `npm run lan` (§10: the launcher from source). Bundles app\ into <out>/dev/Voidswarm LAN (the admin and display
 * pages beside it), points web\ at a copy of dist/ when it exists, and runs app\launch.mjs with this Node.
 */
export async function devRun(argv, opts = {}) {
  const projectRoot = opts.projectRoot ?? PROJECT_ROOT;
  const log = opts.log ?? ((l) => process.stdout.write(`${l}\n`));
  const out = path.resolve(opts.out ?? path.join(projectRoot, 'release'));
  checkOutDir(out, { projectRoot, platform: opts.platform ?? process.platform, gitIgnored: opts.gitIgnored });
  const root = path.join(out, 'dev', LAN_FOLDER);
  const app = path.join(root, 'app');
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(app, { recursive: true });
  await bundleApp(app, { projectRoot, log });
  copyStaticPages(app, { projectRoot });
  fs.writeFileSync(path.join(app, 'build-info.json'), `${JSON.stringify({ name: 'voidswarm-lan', version: readVersion(projectRoot), node: process.version, platform: 'dev', buildDate: stamp() }, null, 2)}\n`);
  const dist = path.join(projectRoot, 'dist');
  const web = path.join(root, 'web');
  fs.rmSync(web, { recursive: true, force: true });
  if (fs.existsSync(path.join(dist, 'index.html'))) fs.cpSync(dist, web, { recursive: true });
  else log('No built client in dist/ (npm run build): the game page is not served, the control panel is.');
  log(`Running ${path.join(app, 'launch.mjs')}`);
  const child = spawn(process.execPath, [path.join(app, 'launch.mjs'), ...argv], { stdio: 'inherit' });
  for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) { try { process.on(s, () => {}); } catch { /* not here */ } }
  return new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 1)));
}

// ---------------------------------------------------------------------------------------------- the command line

export function parseArgs(argv) {
  const o = { out: undefined, node: undefined, keepStage: false, zip: true, run: false, rest: [] };
  let passThrough = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // After `--` everything is for the launcher (npm run lan -- <flags>).
    if (passThrough) { o.rest.push(a); continue; }
    if (a === '--') { passThrough = true; continue; }
    if (a === '--out') o.out = argv[++i];
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (a === '--node') o.node = argv[++i];
    else if (a.startsWith('--node=')) o.node = a.slice(7);
    else if (a === '--keep-stage') o.keepStage = true;
    else if (a === '--no-zip') o.zip = false;
    else if (a === '--run') o.run = true;
    else throw new BuildError(`unknown option ${a}`);
    if ((a === '--out' || a === '--node') && !argv[i]) throw new BuildError(`${a} needs a value`);
  }
  return o;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const real = (p) => { try { return fs.realpathSync.native(path.resolve(p)); } catch { return path.resolve(p); } };
  const a = real(process.argv[1]);
  const b = real(fileURLToPath(import.meta.url));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
})();

if (isMain) {
  (async () => {
    try {
      const o = parseArgs(process.argv.slice(2));
      if (o.run) { process.exitCode = await devRun(o.rest, { out: o.out }); return; }
      await buildLan({ out: o.out, node: o.node, keepStage: o.keepStage || !o.zip, zip: o.zip });
    } catch (e) {
      process.stderr.write(`package:lan failed: ${e instanceof BuildError ? e.message : e?.stack ?? e}\n`);
      process.exitCode = 1;
    }
  })();
}

export { BuildError };
