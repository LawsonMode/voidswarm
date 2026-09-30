// OWNER: PACKAGING (LAN task B11). The in-place updater and rollback: `Update Voidswarm.cmd` (tool update) and
// `Update Voidswarm.cmd --rollback` (docs/LAN-EDITION-proposal.md §2.5, §2.1; T-LAN-17).
//
// Update, always with the host stopped (the host lock is held for the whole run, so no host can start meanwhile):
//   1. find the newest voidswarm-lan-<version>-win-x64.zip in the folder or in updates\ (or --zip <file>); only a
//      NEWER version is installed (an older one: use --rollback);
//   2. show its version and SHA-256, compared with the .sha256 file beside the zip when there is one (a mismatch
//      refuses), and ask Y/N;
//   3. extract it with Windows tar into update.staging\, then check it: exactly one top folder, "Voidswarm LAN"; no
//      links; every file listed in its SHA256SUMS.txt with a matching hash and nothing unlisted; the required files;
//      app\build-info.json naming the zip's version and Node 24; runtime\node.exe's Authenticode signature Valid and
//      from the OpenJS Foundation;
//   4. an encrypted backup, pre-update-<version> (when there is a database), made only now that nothing can fail
//      before the swap except the swap itself;
//   5. the swap (journaled in update.journal.json, undone on failure or at the next run after a crash): the old
//      previous\ goes, app\ and web\ (and the root text files, in previous\root\) move into previous\, the new ones
//      come in. The stubs are never rewritten (their contract is frozen for 0.6.x and one of them is running); a stub
//      a newer version adds is copied in. When node.exe changed, the new runtime waits in runtime.next\: Update
//      Voidswarm.cmd switches it after this process exits (a running node.exe's folder can't be renamed), moving the
//      old one to previous\runtime\. Each "X → previous\X" is followed at once by "staging\X → X", and before the
//      swap app\tool.mjs is copied to update.recover.mjs at the root: the Update stub runs that copy when a crash
//      left app\ out (the stubs check app\tool.mjs first), and the Start stub refuses while a journal exists. The stub
//      never switches the runtime while a journal exists (the undo may still need runtime.next\);
//   6. previous\update.json records the versions, the pre-update backup and the database schema before the update.
// data\, the folder path, the firewall / AppLocker / Bitdefender rules (they name runtime\node.exe by path) and the
// shortcuts stay as they are.
//
// Rollback swaps previous\ back in (a second --rollback goes forward again). When the newer version migrated the
// database (its schema is above the one recorded before the update), the pre-update backup is restored first, after
// a confirmation, unchanged (restore.ts with migrate: false), which re-applies the deletion ledger (§6.4).
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupsDir, createBackup, pepperIdOf, type StatfsFn } from '../server/maint';
import { openFileSecrets } from '../server/secrets';
import { configPath, readConfigFile } from '../server/settings';
import { GAME_VERSION } from '../shared/version';
import { envGet, execTool, LAN_FOLDER_NAME, lanPaths, pathApi, rootFromLauncher, runPowerShell, STUB_FILES, type Env, type ExecFn, type LanPaths, type Platform } from './paths';
import { acquireLock } from './pipe';
import { consoleIo, restoreBackup, type ToolIo } from './restore';

export const UPDATE_STAGING = 'update.staging';
/** The new runtime, switched in by Update Voidswarm.cmd after node exits. */
export const RUNTIME_NEXT = 'runtime.next';
export const UPDATES_DIR = 'updates';
export const UPDATE_JOURNAL = 'update.journal.json';
/**
 * A copy of app\tool.mjs at the root, made before every swap: while app\ is moved out (one rename of the swap), the
 * Update stub runs this copy to undo the journal (the stubs check app\tool.mjs first). Removed with the journal.
 */
export const RECOVER_TOOL = 'update.recover.mjs';
/** previous\update.json */
export const UPDATE_INFO = 'update.json';
/** previous\root\: the root text files the update replaced. */
export const PREVIOUS_ROOT = 'root';
export const SUMS_FILE = 'SHA256SUMS.txt';
/** The root text files an update replaces (never the stubs). */
export const ROOT_DOCS: readonly string[] = ['START HERE.html', 'FOR SCHOOL IT.txt', 'VERSION.txt', 'THIRD-PARTY-NOTICES.txt', SUMS_FILE];
/** 0.6.x runs on Node 24 (§2.1). */
export const REQUIRED_NODE_MAJOR = 24;
export const NODE_SIGNER = 'OpenJS Foundation';
/** What a package must hold (paths inside "Voidswarm LAN"). */
export const REQUIRED_FILES: readonly string[] = [
  'app/launch.mjs', 'app/server.mjs', 'app/tool.mjs', 'app/maint.mjs', 'app/build-info.json', 'runtime/node.exe', 'web/index.html', SUMS_FILE,
  'Start Voidswarm Host.cmd', 'Update Voidswarm.cmd',
];
export const ZIP_NAME_RE = /^voidswarm-lan-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-win-x64\.zip$/i;
export const UPDATE_EXIT = { OK: 0, FAILED: 1, USAGE: 4 } as const;

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------
// Versions and zips
// ------------------------------------------------------------------------------------------

export interface Version { major: number; minor: number; patch: number; pre: string | null }

export function parseVersion(v: string): Version | null {
  const m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.]{1,40}))?$/.exec(String(v ?? '').trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null } : null;
}

/** < 0 when a is older than b. A pre-release sorts before its release. Unparsable versions sort first. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  if (x.major !== y.major) return x.major - y.major;
  if (x.minor !== y.minor) return x.minor - y.minor;
  if (x.patch !== y.patch) return x.patch - y.patch;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return comparePre(x.pre, y.pre);
}

/**
 * Semver §11 for pre-release tags: dot-separated identifiers left to right; numeric ones compare as numbers and sort
 * before alphanumeric ones; a shorter list that is a prefix of the other sorts first (rc.9 < rc.10 < rc.10.1).
 */
function comparePre(a: string, b: string): number {
  const x = a.split('.');
  const y = b.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (i >= x.length) return -1;
    if (i >= y.length) return 1;
    const p = x[i]!;
    const q = y[i]!;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      const d = BigInt(p) - BigInt(q);
      if (d !== 0n) return d < 0n ? -1 : 1;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

export interface UpdateZip { file: string; name: string; version: string }

export function zipInfo(file: string): UpdateZip | null {
  const name = path.basename(file);
  const m = ZIP_NAME_RE.exec(name);
  return m ? { file: path.resolve(file), name, version: m[1]! } : null;
}

/** The update zips in the folder and in updates\, newest version first. */
export function findUpdateZips(root: string): UpdateZip[] {
  const out: UpdateZip[] = [];
  for (const dir of [root, path.join(root, UPDATES_DIR)]) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const z = zipInfo(path.join(dir, n));
      if (!z) continue;
      try { if (!fs.statSync(z.file).isFile()) continue; } catch { continue; }
      out.push(z);
    }
  }
  return out.sort((a, b) => compareVersions(b.version, a.version) || a.file.localeCompare(b.file));
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** The hash in a `.sha256` file (`<hex>  <name>` or just `<hex>`); when it names a file, it must be this zip. */
export function parseSha256File(text: string, zipName?: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([0-9a-fA-F]{64})(?:\s+\*?(.+))?$/.exec(line);
    if (!m) return null;
    if (zipName && m[2] && m[2].trim().toLowerCase() !== zipName.toLowerCase()) continue;
    return m[1]!.toLowerCase();
  }
  return null;
}

/** SHA256SUMS.txt → path → hash. Paths are relative with forward slashes; anything else is an error. */
export function parseSums(text: string): { entries: Map<string, string>; errors: string[] } {
  const entries = new Map<string, string>();
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(raw.replace(/\s+$/, ''));
    if (!m) { errors.push(`${SUMS_FILE} line ${i + 1} is not "<sha-256>  <file>"`); return; }
    const rel = m[2]!;
    if (rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').some((s) => s === '..' || s === '.' || s === '')) {
      errors.push(`${SUMS_FILE} line ${i + 1} names an unsafe path`);
      return;
    }
    if (entries.has(rel)) { errors.push(`${SUMS_FILE} lists ${rel} twice`); return; }
    entries.set(rel, m[1]!);
  });
  return { entries, errors };
}

/** Every file under dir (relative, forward slashes) and every link (never followed). */
export function walkTree(dir: string): { files: string[]; links: string[] } {
  const files: string[] = [];
  const links: string[] = [];
  const visit = (abs: string, rel: string): void => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) links.push(r);
      else if (ent.isDirectory()) {
        // A junction reads as a directory through Dirent on some Node builds: lstat says what it really is.
        if (fs.lstatSync(path.join(abs, ent.name)).isSymbolicLink()) links.push(r);
        else visit(path.join(abs, ent.name), r);
      } else if (ent.isFile()) files.push(r);
      else links.push(r);
    }
  };
  visit(dir, '');
  return { files: files.sort(), links: links.sort() };
}

export interface BuildInfo { version: string | null; node: string | null; buildDate: string | null }

export function readBuildInfo(appDir: string): BuildInfo | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(appDir, 'build-info.json'), 'utf8')) as Record<string, unknown>;
    const s = (v: unknown): string | null => (typeof v === 'string' && v.length <= 80 ? v : null);
    return { version: s(j.version), node: s(j.node), buildDate: s(j.buildDate) };
  } catch {
    return null;
  }
}

/** The installed version: app\build-info.json, else this program's own. */
export function installedVersion(paths: Pick<LanPaths, 'app'>): string {
  const v = readBuildInfo(paths.app)?.version;
  return v && parseVersion(v) ? v : GAME_VERSION;
}

/**
 * The checks on an extracted package's "Voidswarm LAN" folder (§2.5 step 5). Returns the problems (empty = ok).
 * The signature is checked separately (checkNodeSignature).
 */
export async function verifyStagedTree(dir: string, expectVersion: string | null): Promise<string[]> {
  const problems: string[] = [];
  const { files, links } = walkTree(dir);
  if (links.length) problems.push(`the package holds links or special files (${links.slice(0, 3).join(', ')}): refused`);
  const have = new Set(files);
  for (const f of REQUIRED_FILES) if (!have.has(f)) problems.push(`the package has no ${f.replace(/\//g, '\\')}`);
  if (!have.has(SUMS_FILE)) return problems;
  const sums = parseSums(fs.readFileSync(path.join(dir, SUMS_FILE), 'utf8'));
  problems.push(...sums.errors.slice(0, 5));
  for (const f of files) if (f !== SUMS_FILE && !sums.entries.has(f)) problems.push(`${f.replace(/\//g, '\\')} is not in ${SUMS_FILE}`);
  for (const [rel, want] of sums.entries) {
    if (!have.has(rel)) { problems.push(`${rel.replace(/\//g, '\\')} (in ${SUMS_FILE}) is missing`); continue; }
    if (await sha256File(path.join(dir, rel)) !== want) problems.push(`${rel.replace(/\//g, '\\')} does not match ${SUMS_FILE} (damaged or changed)`);
  }
  const info = readBuildInfo(path.join(dir, 'app'));
  if (!info?.version) problems.push('app\\build-info.json names no version');
  else if (expectVersion && info.version !== expectVersion) problems.push(`the zip's name says ${expectVersion} but its app\\build-info.json says ${info.version}`);
  const major = /^v(\d+)\./.exec(info?.node ?? '')?.[1];
  if (info && Number(major) !== REQUIRED_NODE_MAJOR) problems.push(`the package's runtime is Node ${info.node ?? '(unknown)'}; 0.6.x needs Node ${REQUIRED_NODE_MAJOR}`);
  return problems;
}

export interface SignatureCheck { ok: boolean; status: string; subject: string | null; detail?: string }

/** Get-AuthenticodeSignature: Valid, and the OpenJS Foundation as CN and O (§2.5 step 5, T-PKG-3). */
export async function checkNodeSignature(file: string, opts: { exec?: ExecFn; env?: Env; platform?: Platform } = {}): Promise<SignatureCheck> {
  if ((opts.platform ?? process.platform) !== 'win32') return { ok: false, status: 'NotWindows', subject: null, detail: 'the signature can only be checked on Windows' };
  const script = '$s = Get-AuthenticodeSignature -LiteralPath $env:VS_FILE; '
    + '[pscustomobject]@{ status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress';
  const r = await runPowerShell(script, { VS_FILE: file }, { exec: opts.exec, env: opts.env, timeoutMs: 60_000 });
  if (r.code !== 0) return { ok: false, status: 'Unknown', subject: null, detail: (r.stderr || r.error || '').trim().slice(0, 200) };
  try {
    const j = JSON.parse(r.stdout.trim()) as { status?: unknown; subject?: unknown };
    const status = String(j.status ?? 'Unknown');
    const subject = typeof j.subject === 'string' && j.subject ? j.subject : null;
    const signer = !!subject && /(^|,\s*)CN=OpenJS Foundation(,|$)/.test(subject) && /(^|,\s*)O=OpenJS Foundation(,|$)/.test(subject);
    return { ok: status === 'Valid' && signer, status, subject };
  } catch {
    return { ok: false, status: 'Unknown', subject: null, detail: r.stdout.trim().slice(0, 200) };
  }
}

/** Windows tar (bsdtar reads zip). It refuses absolute paths and `..` (libarchive's default). */
export async function extractZip(zip: string, dest: string, opts: { exec?: ExecFn; env?: Env; platform?: Platform } = {}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const tar = platform === 'win32'
    ? path.win32.join(envGet(env, 'SystemRoot') ?? envGet(env, 'windir') ?? 'C:\\Windows', 'System32', 'tar.exe')
    : '/usr/bin/tar';
  const r = await (opts.exec ?? execTool)(tar, ['-x', '-f', zip, '-C', dest], { timeoutMs: 10 * 60_000 });
  if (r.code !== 0) throw new Error(`the zip could not be extracted (${(r.stderr || r.error || `tar exit ${r.code}`).trim().slice(0, 200)})`);
}

/** user_version of the database, or null (none, unreadable). */
export function readSchemaVersion(dbPath: string): number | null {
  if (!fs.existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* closed */ }
  }
}

// ------------------------------------------------------------------------------------------
// The journaled swap
// ------------------------------------------------------------------------------------------

export type SwapOp = { op: 'move'; from: string; to: string } | { op: 'mkdir'; path: string };

interface Journal { v: 1; kind: 'update' | 'rollback'; ops: SwapOp[]; done: number; complete: boolean; at: number; undoing?: boolean }

const journalPath = (root: string): string => path.join(root, UPDATE_JOURNAL);

/** The install root of a tool file: app\tool.mjs → the folder above app\; the root's update.recover.mjs → its folder. */
export function toolRoot(toolFile: string, platform: Platform = process.platform): string {
  const p = pathApi(platform);
  return p.basename(toolFile).toLowerCase() === RECOVER_TOOL ? p.dirname(p.resolve(toolFile)) : rootFromLauncher(toolFile, platform);
}

/**
 * Copies app\tool.mjs to the root's update.recover.mjs (write then rename), before a swap starts. Returns the problem,
 * or null. A swap never starts without it: a crash while app\ is out would leave the stubs nothing to run.
 */
function placeRecoveryTool(root: string, appDir: string): string | null {
  const src = path.join(appDir, 'tool.mjs');
  const dst = path.join(root, RECOVER_TOOL);
  if (!fs.existsSync(src)) return 'app\\tool.mjs is missing';
  try {
    fs.copyFileSync(src, `${dst}.tmp`);
    fs.renameSync(`${dst}.tmp`, dst);
    return null;
  } catch (e) {
    try { fs.rmSync(`${dst}.tmp`, { force: true }); } catch { /* gone */ }
    return errMsg(e);
  }
}

/** The swap is over (finished, or fully undone): the journal goes first, then the recovery copy. */
function clearJournal(root: string): void {
  fs.rmSync(journalPath(root), { force: true });
  try { fs.rmSync(path.join(root, RECOVER_TOOL), { force: true }); } catch { /* the next swap replaces it */ }
}

function writeJournal(root: string, j: Journal): void {
  const file = journalPath(root);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(j));
  fs.renameSync(`${file}.tmp`, file);
}

function readJournal(root: string): Journal | null {
  try {
    const j = JSON.parse(fs.readFileSync(journalPath(root), 'utf8')) as Journal;
    if (j?.v !== 1 || !Array.isArray(j.ops) || !Number.isInteger(j.done) || j.done < 0 || j.done > j.ops.length) return null;
    if (j.undoing !== undefined && typeof j.undoing !== 'boolean') return null;
    for (const op of j.ops) {
      const rels = op.op === 'move' ? [op.from, op.to] : [op.path];
      if (rels.some((r) => typeof r !== 'string' || path.isAbsolute(r) || r.split(/[\\/]/).includes('..'))) return null;
    }
    return j;
  } catch {
    return null;
  }
}

/** A rename that waits out a file briefly held open (antivirus scanning new files, a just-exited process). */
async function renameRetry(from: string, to: string, tries = 20): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (i >= tries - 1 || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) throw e;
      await sleep(250);
    }
  }
}

async function runOp(root: string, op: SwapOp): Promise<void> {
  if (op.op === 'mkdir') { fs.mkdirSync(path.join(root, op.path)); return; }
  await renameRetry(path.join(root, op.from), path.join(root, op.to));
}

/**
 * Undoes one op by what is on disk, so it is safe to repeat and safe on an op that may or may not have run (a crash
 * between the rename and the journal write): a move whose `to` is there and `from` is not is moved back; `from`
 * there and `to` gone means already undone (or never done); a mkdir'd folder is removed when it is there and empty.
 */
async function undoOp(root: string, op: SwapOp): Promise<void> {
  if (op.op === 'mkdir') {
    const dir = path.join(root, op.path);
    if (!exists(dir)) return;
    if (fs.readdirSync(dir).length) throw new Error(`${op.path} is not empty`);
    fs.rmdirSync(dir);
    return;
  }
  const from = path.join(root, op.from);
  const to = path.join(root, op.to);
  const hasFrom = exists(from);
  const hasTo = exists(to);
  if (hasFrom && !hasTo) return;
  if (hasFrom && hasTo) throw new Error(`both ${op.from} and ${op.to} exist, so it is not known which one to keep`);
  if (!hasTo) throw new Error(`neither ${op.from} nor ${op.to} exists`);
  await renameRetry(to, from);
}

/**
 * Where an undo (re)starts. Going forward, `done` = d means ops[0..d-1] ran and op d may have run (a crash between its
 * rename and the journal write). Once undoing (`undoing`), `done` = u means ops[u..] are undone and op u-1 may have
 * been (the same crash, in the undo). Either way exactly one op is uncertain, and undoOp's disk check settles it; two
 * uncertain ops could not be settled, since a pair "X → previous\X", "staging\X → X" shares X.
 */
function undoStart(j: Journal): number {
  return Math.min(j.undoing ? j.done - 1 : j.done, j.ops.length - 1);
}

/**
 * Undoes ops[start..0], newest first, stopping at the first one that can't be undone. The journal is marked as
 * undoing first, and after each op its `done` is lowered past it, so a run after a failure or a crash carries on from
 * there (never re-undoing a step). A journal that can't be written stops the undo too (it would leave two ops
 * uncertain). `probe` is test-only fault injection, as in swap().
 */
async function undoOps(root: string, j: Journal, start: number, probe?: SwapProbe): Promise<string[]> {
  const from = Math.min(start, j.ops.length - 1);
  j.undoing = true;
  j.done = from + 1;
  try { writeJournal(root, j); } catch (e) { return [`${UPDATE_JOURNAL} could not be written (${errMsg(e)})`]; }
  for (let i = from; i >= 0; i--) {
    try {
      await undoOp(root, j.ops[i]!);
    } catch (e) {
      return [`${JSON.stringify(j.ops[i])}: ${errMsg(e)}`];
    }
    probe?.(i, 'moved');
    j.done = i;
    try { writeJournal(root, j); } catch (e) { return [`${UPDATE_JOURNAL} could not be written after undoing ${JSON.stringify(j.ops[i])} (${errMsg(e)})`]; }
    probe?.(i, 'journaled');
  }
  return [];
}

/**
 * Test-only fault injection: thrown from UpdateDeps.swapProbe, it stops the swap dead, as if the process died there
 * (no undo, the journal left as it is), and applyUpdate / applyRollback pass it on untouched.
 */
export class SimulatedCrash extends Error {
  constructor(where: string) { super(`simulated crash ${where}`); this.name = 'SimulatedCrash'; }
}

/** Where a swap may be interrupted: after op `index`'s rename, before ('moved') or after ('journaled') its journal write. */
export type SwapProbe = (index: number, phase: 'moved' | 'journaled') => void;

/** Runs the ops in order, journaled; on a failure undoes the ones done and rethrows. */
async function swap(root: string, kind: Journal['kind'], ops: SwapOp[], now: () => number, probe?: SwapProbe): Promise<void> {
  const j: Journal = { v: 1, kind, ops, done: 0, complete: false, at: now() };
  writeJournal(root, j);
  try {
    for (const [i, op] of ops.entries()) {
      await runOp(root, op);
      probe?.(i, 'moved');
      j.done++;
      writeJournal(root, j);
      probe?.(i, 'journaled');
    }
  } catch (e) {
    if (e instanceof SimulatedCrash) throw e;
    // The op that threw did not happen (a rename or mkdir that fails changes nothing): undo from the one before it.
    const errors = await undoOps(root, j, j.done - 1);
    if (!errors.length) { try { clearJournal(root); } catch { /* next run */ } }
    const extra = errors.length ? ` Putting the old files back also failed (${errors.slice(0, 2).join('; ')}); run Update Voidswarm.cmd again to finish putting them back.` : ' Nothing was changed.';
    throw new Error(`Replacing the files failed: ${errMsg(e)}.${extra}`);
  }
  j.complete = true;
  writeJournal(root, j);
}

/**
 * An update or rollback that was interrupted (power loss, the window closed): an unfinished swap is undone (the
 * version from before it comes back), a finished one only tidied. Returns a note, or null when there was nothing.
 * Safe to call at every start (the launcher's §2.2 step 8 "clean up update leftovers", and the tool).
 */
export async function recoverInterruptedUpdate(root: string, opts: { probe?: SwapProbe } = {}): Promise<string | null> {
  const file = journalPath(root);
  if (!fs.existsSync(file)) {
    // A staging folder with no journal: an update that stopped before the swap. Its files are just leftovers.
    const staging = path.join(root, UPDATE_STAGING);
    if (fs.existsSync(staging)) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* held: next time */ } }
    try { fs.rmSync(path.join(root, RECOVER_TOOL), { force: true }); } catch { /* the next swap replaces it */ }
    return null;
  }
  const j = readJournal(root);
  if (!j) return `${UPDATE_JOURNAL} could not be read: the update's files were left as they are. Unzip the new version again if Voidswarm doesn't start.`;
  if (j.complete) {
    clearJournal(root);
    try { fs.rmSync(path.join(root, UPDATE_STAGING), { recursive: true, force: true }); } catch { /* next time */ }
    return null;
  }
  // From the one uncertain op (undoStart): it may or may not have run, and undoOp checks the disk.
  const errors = await undoOps(root, j, undoStart(j), opts.probe);
  if (errors.length) return `An interrupted ${j.kind} could not be fully undone (${errors.slice(0, 2).join('; ')}). Close every Voidswarm window, then run Update Voidswarm.cmd again: it carries on from this step.`;
  clearJournal(root);
  try { fs.rmSync(path.join(root, UPDATE_STAGING), { recursive: true, force: true }); } catch { /* next time */ }
  return `An interrupted ${j.kind === 'update' ? 'update' : 'rollback'} was undone: the version from before it is back.`;
}

/**
 * Notes for the launcher's staged-work step (§2.2 step 8): a runtime switch still waiting, or an unreadable journal.
 * (recoverInterruptedUpdate does the tidying.)
 */
export function updateLeftoverNotes(root: string): string[] {
  const notes: string[] = [];
  if (fs.existsSync(path.join(root, RUNTIME_NEXT, 'node.exe'))) {
    notes.push('An update installed a new Node.js runtime that is not switched in yet: stop the host and run Update Voidswarm.cmd once to finish.');
  }
  if (fs.existsSync(journalPath(root))) notes.push('An update was interrupted: stop the host and run Update Voidswarm.cmd to finish or undo it.');
  return notes;
}

// ------------------------------------------------------------------------------------------
// Update
// ------------------------------------------------------------------------------------------

export interface UpdateInfo {
  v: 1;
  kind: 'update' | 'rollback';
  /** the version now in previous\ */
  from: string;
  /** the version now in app\ */
  to: string;
  at: number;
  /** the pre-update backup (data\backups), when one was made */
  backup: string | null;
  /** the database's user_version before the change (null: no database) */
  schemaBefore: number | null;
  runtimeChanged: boolean;
}

export function readUpdateInfo(paths: Pick<LanPaths, 'previous'>): UpdateInfo | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(paths.previous, UPDATE_INFO), 'utf8')) as UpdateInfo;
    if (j?.v !== 1 || typeof j.from !== 'string' || typeof j.to !== 'string') return null;
    if (j.backup !== null && (typeof j.backup !== 'string' || j.backup !== path.basename(j.backup))) return null;
    if (j.schemaBefore !== null && !Number.isInteger(j.schemaBefore)) return null;
    return j;
  } catch {
    return null;
  }
}

function writeUpdateInfo(paths: Pick<LanPaths, 'previous'>, info: UpdateInfo): void {
  fs.writeFileSync(path.join(paths.previous, UPDATE_INFO), `${JSON.stringify(info, null, 2)}\n`);
}

export interface UpdateDeps {
  platform?: Platform;
  env?: Env;
  exec?: ExecFn;
  now?: () => number;
  log?: (line: string) => void;
  /** the node.exe signature check (default checkNodeSignature; tests inject) */
  verifySignature?: (nodeExe: string) => Promise<SignatureCheck>;
  /** default extractZip */
  extract?: (zip: string, dest: string) => Promise<void>;
  /** the backups' disk check (tests) */
  statfs?: StatfsFn;
  /** test-only fault injection in the swap (throw SimulatedCrash to model the process dying there) */
  swapProbe?: SwapProbe;
}

export type UpdateResult =
  | { ok: true; from: string; to: string; backup: string | null; runtimeChanged: boolean; addedStubs: string[]; notes: string[] }
  | { ok: false; message: string };

function settingsBits(dataDir: string): { installId: string; sizeCapMB: number | null } {
  try {
    const raw = readConfigFile(configPath(dataDir)).raw as { installId?: unknown; backups?: { sizeCapMB?: unknown } } | null;
    return {
      installId: typeof raw?.installId === 'string' ? raw.installId.slice(0, 64) : '',
      sizeCapMB: typeof raw?.backups?.sizeCapMB === 'number' ? raw.backups.sizeCapMB : null,
    };
  } catch {
    return { installId: '', sizeCapMB: null };
  }
}

const exists = (p: string): boolean => fs.existsSync(p);

/**
 * The encrypted pre-update-<detail> backup of data\voidswarm.db, made just before a swap (an update, or a rollback
 * going either way), so the next --rollback has the data from before this change to go back to.
 */
async function preSwapBackup(paths: LanPaths, detail: string, appVersion: string, deps: UpdateDeps): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
  const secrets = openFileSecrets(paths.data, { platform: deps.platform });
  let key: Buffer | null = null;
  try { key = secrets.has('backup.key') ? secrets.read('backup.key') : null; } catch { key = null; }
  if (!key) return { ok: false, message: 'The backup before the update could not be made: data\\secrets\\backup.key is missing or damaged. Start the host once, or restore the key from the recovery file.' };
  let pepper: Buffer | null = null;
  try { pepper = secrets.has('pepper.key') ? secrets.read('pepper.key') : null; } catch { pepper = null; }
  const bits = settingsBits(paths.data);
  const b = await createBackup({
    dataDir: paths.data, dbPath: paths.db, key, reason: 'pre-update', detail, now: (deps.now ?? Date.now)(), appVersion,
    installId: bits.installId, sizeCapMB: bits.sizeCapMB, pepperId: pepper ? pepperIdOf(pepper) : null, statfs: deps.statfs,
  });
  if (!b.ok) return { ok: false, message: `The backup before the update could not be made (${'skipped' in b ? b.text : b.error}).` };
  return { ok: true, name: b.name };
}

/**
 * Installs an update zip (steps 3–6 above). The caller holds the host lock, has shown the zip and asked. Never
 * throws: a refusal or failure comes back as { ok: false, message } with the install as it was.
 */
export async function applyUpdate(paths: LanPaths, zip: UpdateZip, deps: UpdateDeps = {}): Promise<UpdateResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const root = paths.root;
  const staging = path.join(root, UPDATE_STAGING);
  const from = installedVersion(paths);
  const fail = (message: string): UpdateResult => {
    // With a journal left (a swap that could not be undone) the staging folder may hold the old files: keep it.
    if (!exists(journalPath(root))) { try { fs.rmSync(staging, { recursive: true, force: true }); fs.rmSync(path.join(root, RECOVER_TOOL), { force: true }); } catch { /* next run */ } }
    return { ok: false, message };
  };
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    log(`extracting ${zip.name}`);
    try {
      await (deps.extract ?? ((z: string, d: string) => extractZip(z, d, deps)))(zip.file, staging);
    } catch (e) {
      return fail(`${errMsg(e)}. Nothing was changed.`);
    }
    const top = fs.readdirSync(staging);
    if (top.length !== 1 || top[0] !== LAN_FOLDER_NAME) return fail(`The zip must hold one folder, "${LAN_FOLDER_NAME}" (it holds ${top.slice(0, 3).join(', ') || 'nothing'}). Nothing was changed.`);
    const s = path.join(staging, LAN_FOLDER_NAME);
    const problems = await verifyStagedTree(s, zip.version);
    if (problems.length) return fail(`The update was refused: ${problems.slice(0, 6).join('; ')}${problems.length > 6 ? ` (+${problems.length - 6} more)` : ''}. Download the zip again. Nothing was changed.`);
    const sig = await (deps.verifySignature ?? ((f: string) => checkNodeSignature(f, deps)))(path.join(s, 'runtime', 'node.exe'));
    if (!sig.ok) return fail(`The update was refused: its runtime\\node.exe is not the official Node.js signed by the ${NODE_SIGNER} (${sig.status}${sig.subject ? `, ${sig.subject}` : ''}${sig.detail ? `: ${sig.detail}` : ''}). Nothing was changed.`);

    const sameFile = async (a: string, b: string): Promise<boolean> => exists(a) && exists(b) && (await sha256File(a)) === (await sha256File(b));
    const runtimeChanged = !(await sameFile(path.join(s, 'runtime', 'node.exe'), paths.nodeExe)
      && (!exists(path.join(s, 'runtime', 'LICENSE')) || await sameFile(path.join(s, 'runtime', 'LICENSE'), path.join(paths.runtime, 'LICENSE'))));

    // The copy of this tool that can undo the swap while app\ is out (the Update stub runs it then).
    const noCopy = placeRecoveryTool(root, paths.app);
    if (noCopy) return fail(`The update could not start: the recovery copy of the tool (${RECOVER_TOOL}) could not be written (${noCopy}). Nothing was changed.`);

    // The backup, now that only the swap is left.
    const schemaBefore = readSchemaVersion(paths.db);
    let backup: string | null = null;
    if (exists(paths.db)) {
      log('backing up the data first');
      const b = await preSwapBackup(paths, zip.version, from, deps);
      if (!b.ok) return fail(`${b.message} Nothing was changed.`);
      backup = b.name;
    }

    // The swap. Each "X → previous\X" is followed at once by "staging\X → X", so app\ (and web\, a doc) is missing
    // for one rename at a time; update.recover.mjs covers that window.
    const rel = (p: string): string => path.relative(root, p);
    const sRel = rel(s);
    const ops: SwapOp[] = [];
    if (exists(paths.previous)) ops.push({ op: 'move', from: 'previous', to: path.join(UPDATE_STAGING, 'previous.old') });
    ops.push({ op: 'mkdir', path: 'previous' }, { op: 'mkdir', path: path.join('previous', PREVIOUS_ROOT) });
    ops.push({ op: 'move', from: 'app', to: path.join('previous', 'app') });
    ops.push({ op: 'move', from: path.join(sRel, 'app'), to: 'app' });
    if (exists(paths.web)) ops.push({ op: 'move', from: 'web', to: path.join('previous', 'web') });
    ops.push({ op: 'move', from: path.join(sRel, 'web'), to: 'web' });
    for (const d of ROOT_DOCS) {
      if (exists(path.join(root, d))) ops.push({ op: 'move', from: d, to: path.join('previous', PREVIOUS_ROOT, d) });
      if (exists(path.join(s, d))) ops.push({ op: 'move', from: path.join(sRel, d), to: d });
    }
    const addedStubs = STUB_FILES.filter((st) => !exists(path.join(root, st)) && exists(path.join(s, st)));
    for (const st of addedStubs) ops.push({ op: 'move', from: path.join(sRel, st), to: st });
    if (runtimeChanged) {
      if (exists(path.join(root, RUNTIME_NEXT))) fs.rmSync(path.join(root, RUNTIME_NEXT), { recursive: true, force: true });
      ops.push({ op: 'move', from: path.join(sRel, 'runtime'), to: RUNTIME_NEXT });
    }
    try {
      await swap(root, 'update', ops, now, deps.swapProbe);
    } catch (e) {
      if (e instanceof SimulatedCrash) throw e;
      // swap() undid what it did (fail() keeps the staging folder when it could not: it may hold the old previous\).
      return fail(errMsg(e));
    }
    const notes: string[] = [];
    try {
      writeUpdateInfo(paths, { v: 1, kind: 'update', from, to: zip.version, at: now(), backup, schemaBefore, runtimeChanged });
    } catch (e) {
      notes.push(`previous\\${UPDATE_INFO} could not be written (${errMsg(e)}): --rollback will refuse while there is a database; restore ${backup ?? 'a backup'} instead if you need to go back.`);
    }
    clearJournal(root);
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* the next run tidies it */ }
    if (addedStubs.length) notes.push(`New in this version: ${addedStubs.join(', ')}.`);
    if (runtimeChanged) notes.push('The Node.js runtime changes too: it is switched when this program has finished (Update Voidswarm.cmd does it).');
    return { ok: true, from, to: zip.version, backup, runtimeChanged, addedStubs, notes };
  } catch (e) {
    if (e instanceof SimulatedCrash) throw e;
    const note = await recoverInterruptedUpdate(root).catch((x: unknown) => errMsg(x));
    return fail(`The update failed: ${errMsg(e)}.${note ? ` ${note}` : ' Nothing was changed.'}`);
  }
}

// ------------------------------------------------------------------------------------------
// Rollback
// ------------------------------------------------------------------------------------------

export interface RollbackPlan {
  from: string;
  to: string;
  info: UpdateInfo | null;
  schemaNow: number | null;
  /** the pre-update backup to restore (the newer version migrated the database) */
  restore: string | null;
  /** a refusal (nothing to roll back to, or the backup it needs is gone) */
  refusal: string | null;
}

export function planRollback(paths: LanPaths): RollbackPlan {
  const info = readUpdateInfo(paths);
  const from = installedVersion(paths);
  const to = readBuildInfo(path.join(paths.previous, 'app'))?.version ?? info?.from ?? 'the previous version';
  const schemaNow = readSchemaVersion(paths.db);
  const base: RollbackPlan = { from, to, info, schemaNow, restore: null, refusal: null };
  if (!exists(path.join(paths.previous, 'app', 'launch.mjs'))) return { ...base, refusal: 'There is no previous version to go back to (previous\\ is empty).' };
  const migrated = schemaNow !== null && info?.schemaBefore !== null && info?.schemaBefore !== undefined && schemaNow > info.schemaBefore;
  if (schemaNow !== null && !info) {
    return { ...base, refusal: 'previous\\update.json is missing or damaged, so it is not known whether the newer version changed the database. Nothing was changed; restore a backup instead ("Restore a backup.cmd").' };
  }
  if (migrated) {
    if (!info!.backup || !exists(path.join(backupsDir(paths.data), info!.backup))) {
      return { ...base, refusal: `The newer version changed the database (schema v${info!.schemaBefore} → v${schemaNow}) and the backup made before the update${info!.backup ? ` (${info!.backup})` : ''} is gone, so ${to} could not open the data. Nothing was changed.` };
    }
    return { ...base, restore: info!.backup };
  }
  return base;
}

export type RollbackResult =
  | { ok: true; from: string; to: string; restored: string | null; runtimeSwitch: boolean; notes: string[] }
  | { ok: false; message: string };

/** Swaps previous\ back in, restoring the pre-update backup first when plan.restore names one. The caller holds the lock and asked. */
export async function applyRollback(paths: LanPaths, plan: RollbackPlan, deps: UpdateDeps = {}): Promise<RollbackResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const root = paths.root;
  if (plan.refusal) return { ok: false, message: plan.refusal };
  const notes: string[] = [];
  let restored: string | null = null;
  // The copy of this tool that can undo the swap while app\ is out; first, so a refusal here changes nothing.
  const noCopy = placeRecoveryTool(root, paths.app);
  if (noCopy) return { ok: false, message: `Going back could not start: the recovery copy of the tool (${RECOVER_TOOL}) could not be written (${noCopy}). Nothing was changed.` };
  if (plan.restore) {
    log(`restoring ${plan.restore}`);
    const r = await restoreBackup({
      dataDir: paths.data, backupFile: path.join(backupsDir(paths.data), plan.restore), by: 'cli', migrate: false, restoreConfig: false,
      now, statfs: deps.statfs, log,
    });
    if (!r.ok) return { ok: false, message: `The backup from before the update could not be restored: ${r.message} Nothing else was changed.` };
    restored = plan.restore;
    notes.push(r.message, ...r.notes);
  }
  const staging = path.join(root, UPDATE_STAGING);
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(path.join(staging, PREVIOUS_ROOT), { recursive: true });
    const st = (p: string): string => path.join(UPDATE_STAGING, p);
    const prev = (p: string): string => path.join('previous', p);
    const docsNow = ROOT_DOCS.filter((d) => exists(path.join(root, d)));
    const docsPrev = ROOT_DOCS.filter((d) => exists(path.join(paths.previous, PREVIOUS_ROOT, d)));
    const webNow = exists(paths.web);
    const webPrev = exists(path.join(paths.previous, 'web'));
    // Each "X → staging\X" is followed at once by "previous\X → X" (app\ is missing for one rename; update.recover.mjs
    // covers it), then the version going out moves from staging\ into previous\.
    const ops: SwapOp[] = [{ op: 'move', from: 'app', to: st('app') }, { op: 'move', from: prev('app'), to: 'app' }];
    if (webNow) ops.push({ op: 'move', from: 'web', to: st('web') });
    if (webPrev) ops.push({ op: 'move', from: prev('web'), to: 'web' });
    for (const d of ROOT_DOCS) {
      if (docsNow.includes(d)) ops.push({ op: 'move', from: d, to: st(path.join(PREVIOUS_ROOT, d)) });
      if (docsPrev.includes(d)) ops.push({ op: 'move', from: prev(path.join(PREVIOUS_ROOT, d)), to: d });
    }
    if (!exists(path.join(paths.previous, PREVIOUS_ROOT))) ops.push({ op: 'mkdir', path: prev(PREVIOUS_ROOT) });
    ops.push({ op: 'move', from: st('app'), to: prev('app') });
    if (webNow) ops.push({ op: 'move', from: st('web'), to: prev('web') });
    for (const d of docsNow) ops.push({ op: 'move', from: st(path.join(PREVIOUS_ROOT, d)), to: prev(path.join(PREVIOUS_ROOT, d)) });
    const runtimeSwitch = exists(path.join(paths.previous, 'runtime', 'node.exe'));
    if (runtimeSwitch) {
      if (exists(path.join(root, RUNTIME_NEXT))) fs.rmSync(path.join(root, RUNTIME_NEXT), { recursive: true, force: true });
      ops.push({ op: 'move', from: prev('runtime'), to: RUNTIME_NEXT });
    }
    // A backup of the data as the version going in first sees it (after any restore above), so that the next
    // --rollback (which goes the other way) can undo a migration this version makes at its next start.
    const schemaBefore = readSchemaVersion(paths.db);
    let backup: string | null = null;
    if (exists(paths.db)) {
      log('backing up the data first');
      const b = await preSwapBackup(paths, plan.to, plan.from, deps);
      if (b.ok) backup = b.name;
      else notes.push(`${b.message} Going back anyway; if ${plan.to} changes the database when it starts, a later --rollback to ${plan.from} will need a backup restored by hand ("Restore a backup.cmd").`);
    }
    await swap(root, 'rollback', ops, now, deps.swapProbe);
    writeUpdateInfo(paths, {
      v: 1, kind: 'rollback', from: plan.from, to: plan.to, at: now(), backup, schemaBefore, runtimeChanged: runtimeSwitch,
    });
    clearJournal(root);
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* next run */ }
    if (runtimeSwitch) notes.push('The Node.js runtime goes back too: it is switched when this program has finished (Update Voidswarm.cmd does it).');
    return { ok: true, from: plan.from, to: plan.to, restored, runtimeSwitch, notes };
  } catch (e) {
    if (e instanceof SimulatedCrash) throw e;
    const held = exists(journalPath(root));
    if (!held) { try { fs.rmSync(staging, { recursive: true, force: true }); fs.rmSync(path.join(root, RECOVER_TOOL), { force: true }); } catch { /* next run */ } }
    return { ok: false, message: `${errMsg(e)}${restored ? ` The database was already restored from ${restored} (the data from just before is in the pre-restore backup).` : ''}` };
  }
}

// ------------------------------------------------------------------------------------------
// Update Voidswarm.cmd (tool update)
// ------------------------------------------------------------------------------------------

export const UPDATE_USAGE = [
  'Usage: Update Voidswarm.cmd [--zip <file.zip>] [--yes] [--data <folder>]',
  '       Update Voidswarm.cmd --rollback [--yes] [--data <folder>]',
  '  (no option)        install the newest voidswarm-lan-<version>-win-x64.zip in this folder or in updates\\',
  '  --zip <file>       install this zip',
  '  --rollback         go back to the version before the last update (run it again to go forward)',
  '  --yes              don\'t ask for the confirmations',
  '  --data <folder>    (advanced) the data folder',
].join('\n');

export interface UpdateToolFlags { rollback: boolean; zip: string | null; yes: boolean; data: string | null }

export function parseUpdateArgs(argv: readonly string[], cwd = process.cwd()): UpdateToolFlags | { error: string } {
  const f: UpdateToolFlags = { rollback: false, zip: null, yes: false, data: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (flag: string): string | null => {
      if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1) || null;
      const v = argv[++i];
      return v && !v.startsWith('--') ? v : null;
    };
    if (a === 'update' && i === 0) continue;
    if (a === '--rollback') f.rollback = true;
    else if (a === '--yes' || a === '-y') f.yes = true;
    else if (a === '--zip' || a.startsWith('--zip=')) { const v = value('--zip'); if (!v) return { error: '--zip needs a .zip file.' }; f.zip = path.resolve(cwd, v); }
    else if (a === '--data' || a.startsWith('--data=')) { const v = value('--data'); if (!v) return { error: '--data needs a folder.' }; f.data = path.resolve(cwd, v); }
    else return { error: `Unknown option: ${a.slice(0, 60)}` };
  }
  if (f.rollback && f.zip) return { error: '--rollback and --zip don\'t go together.' };
  return f;
}

export interface UpdateToolDeps extends UpdateDeps {
  io?: ToolIo;
  /** the install root (default: from the tool's own file, app\tool.mjs) */
  root?: string;
  toolFile?: string;
  cwd?: string;
  /** the pipe path (tests) */
  pipe?: string;
  /**
   * Only undo an interrupted swap, then stop (default: true when the tool file is the root's update.recover.mjs,
   * which the Update stub runs while app\ is out).
   */
  recoverOnly?: boolean;
}

const sizeMb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;
const yes = (a: string | null): boolean => !!a && /^y(es)?$/i.test(a.trim());

/** `Update Voidswarm.cmd`: returns the exit code. */
export async function runUpdateTool(argv: readonly string[], deps: UpdateToolDeps = {}): Promise<number> {
  const io = deps.io ?? consoleIo();
  try {
    const flags = parseUpdateArgs(argv, deps.cwd);
    if ('error' in flags) { io.write(flags.error); io.write(UPDATE_USAGE); return UPDATE_EXIT.USAGE; }
    const toolFile = deps.toolFile ?? process.argv[1] ?? process.cwd();
    const root = path.resolve(deps.root ?? toolRoot(toolFile, deps.platform));
    const recoverOnly = deps.recoverOnly ?? pathApi(deps.platform).basename(toolFile).toLowerCase() === RECOVER_TOOL;
    const paths = lanPaths(root, { data: flags.data ?? undefined, platform: deps.platform });
    const log = deps.log ?? (() => undefined);

    // The host lock: a running host refuses the update, and no host can start while it runs.
    const secrets = openFileSecrets(paths.data, { platform: deps.platform });
    let pipeKey: Buffer | null = null;
    try { pipeKey = secrets.has('pipe.key') ? secrets.read('pipe.key') : null; } catch { pipeKey = null; }
    const got = await acquireLock({
      dataDir: paths.data, key: pipeKey && pipeKey.length >= 16 ? pipeKey : null, platform: deps.platform, pipe: deps.pipe, unref: true,
      handlers: { panelUrl: () => '', status: () => ({ updating: true }), version: GAME_VERSION },
    });
    if (!got.ok) {
      io.write('Voidswarm is running on this data folder. Stop the host first (Stop in the Host Control Panel, or Ctrl+C in the Voidswarm Host window), then run Update Voidswarm.cmd again.');
      return UPDATE_EXIT.FAILED;
    }
    try {
      // An interrupted swap first (before anything else looks at the folder, runtime.next\ included: the journal may
      // still have to move it back).
      const interrupted = await recoverInterruptedUpdate(root);
      if (interrupted) io.write(interrupted);
      if (exists(journalPath(root))) return UPDATE_EXIT.FAILED;
      if (recoverOnly) {
        io.write(interrupted
          ? 'Run Update Voidswarm.cmd again to install the update (or with --rollback to go back).'
          : 'There was no interrupted update to finish.');
        return UPDATE_EXIT.OK;
      }

      // A runtime switch still waiting: Update Voidswarm.cmd does it as soon as this program exits.
      if (exists(path.join(root, RUNTIME_NEXT, 'node.exe'))) {
        io.write('A new Node.js runtime from the last update is waiting to be switched in: it happens as this window finishes. Then run Update Voidswarm.cmd again if you wanted another update.');
        return UPDATE_EXIT.OK;
      }

      if (flags.rollback) {
        const plan = planRollback(paths);
        if (plan.refusal) { io.write(plan.refusal); return UPDATE_EXIT.FAILED; }
        io.write(`Installed: Voidswarm LAN ${plan.from}. Going back to: ${plan.to}.`);
        if (!flags.yes && !yes(await io.ask(`Go back to ${plan.to}? [y/N]: `))) { io.write('Cancelled: nothing was changed.'); return UPDATE_EXIT.FAILED; }
        if (plan.restore) {
          io.write(`${plan.from} changed the database (schema v${plan.info!.schemaBefore} → v${plan.schemaNow}), so ${plan.to} needs the backup made before the update: ${plan.restore}.`);
          io.write('Accounts, chat and records since then are replaced by that backup (a backup of the data now is made first). Students deleted since then stay deleted.');
          if (!flags.yes) {
            const a = await io.ask('Type YES to restore it and go back: ');
            if (!a || a.trim().toUpperCase() !== 'YES') { io.write('Cancelled: nothing was changed.'); return UPDATE_EXIT.FAILED; }
          }
        }
        const r = await applyRollback(paths, plan, { ...deps, log });
        if (!r.ok) { io.write(r.message); return UPDATE_EXIT.FAILED; }
        io.write(`Voidswarm LAN is back at ${r.to}${r.restored ? `, with the data from ${r.restored}` : ''}. Run Update Voidswarm.cmd --rollback again to return to ${r.from}.`);
        for (const n of r.notes) io.write(`  - ${n}`);
        io.write('Start Voidswarm Host.cmd to run it.');
        return UPDATE_EXIT.OK;
      }

      // The zip.
      let zip: UpdateZip | null;
      const current = installedVersion(paths);
      if (flags.zip) {
        zip = zipInfo(flags.zip);
        if (!zip) { io.write(`${path.basename(flags.zip)} is not a Voidswarm LAN update (voidswarm-lan-<version>-win-x64.zip).`); return UPDATE_EXIT.FAILED; }
        if (!exists(zip.file)) { io.write(`There is no file at ${zip.file}.`); return UPDATE_EXIT.FAILED; }
      } else {
        zip = findUpdateZips(root)[0] ?? null;
        if (!zip) {
          io.write(`Installed: Voidswarm LAN ${current}. No update zip was found.`);
          io.write(`Put the new voidswarm-lan-<version>-win-x64.zip in ${root} (or in its updates folder), then run Update Voidswarm.cmd again.`);
          return UPDATE_EXIT.FAILED;
        }
      }
      const cmp = compareVersions(zip.version, current);
      if (cmp === 0) { io.write(`Voidswarm LAN ${current} is already installed (${zip.name}).`); return UPDATE_EXIT.OK; }
      if (cmp < 0) {
        io.write(`${zip.name} is older (${zip.version}) than the installed version (${current}): nothing was changed.`);
        io.write('To go back to the version before the last update, run Update Voidswarm.cmd --rollback.');
        return UPDATE_EXIT.FAILED;
      }
      const size = fs.statSync(zip.file).size;
      io.write(`Installed: Voidswarm LAN ${current}`);
      io.write(`Update:    Voidswarm LAN ${zip.version}  (${zip.name}, ${sizeMb(size)})`);
      io.write('Checking the zip…');
      const hex = await sha256File(zip.file);
      io.write(`SHA-256:   ${hex}`);
      const side = `${zip.file}.sha256`;
      if (exists(side)) {
        const want = parseSha256File(fs.readFileSync(side, 'utf8').slice(0, 4096), zip.name);
        if (!want) { io.write(`${path.basename(side)} could not be read: nothing was changed. Download it again, or delete it and compare the SHA-256 above with the download page.`); return UPDATE_EXIT.FAILED; }
        if (want !== hex) { io.write(`The zip does NOT match ${path.basename(side)}: it is damaged or was changed. Download it again. Nothing was changed.`); return UPDATE_EXIT.FAILED; }
        io.write(`           matches ${path.basename(side)}`);
      } else {
        io.write('           (no .sha256 file beside the zip: compare this SHA-256 with the one on the download page)');
      }
      if (!flags.yes && !yes(await io.ask(`Install Voidswarm LAN ${zip.version}? Your data stays as it is, and a backup is made first. [y/N]: `))) {
        io.write('Cancelled: nothing was changed.');
        return UPDATE_EXIT.FAILED;
      }
      io.write('Updating…');
      const r = await applyUpdate(paths, zip, { ...deps, log });
      if (!r.ok) { io.write(r.message); return UPDATE_EXIT.FAILED; }
      io.write(`Updated to Voidswarm LAN ${r.to}.${r.backup ? ` The data was backed up first (${r.backup}).` : ''}`);
      for (const n of r.notes) io.write(`  - ${n}`);
      io.write(`${r.from} is kept in previous\\: Update Voidswarm.cmd --rollback goes back to it.`);
      io.write('Start Voidswarm Host.cmd to run it.');
      return UPDATE_EXIT.OK;
    } finally {
      await got.lock.close();
    }
  } catch (e) {
    io.write(`The update failed: ${errMsg(e)}`);
    return UPDATE_EXIT.FAILED;
  } finally {
    io.close?.();
  }
}
