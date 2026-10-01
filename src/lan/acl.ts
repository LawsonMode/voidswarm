// LAN edition: the folder-permission check and its one-click fix (§2.2 step 3, §2.4, T-LAN-11).
//
// The check covers the WHOLE install, every file and folder, not only its top level. Any account
// other than the user, SYSTEM and Administrators must not:
// - have write access (anything that lets it change a file or its permissions) anywhere under the
//   root outside data\: app\, runtime\, web\, previous\, the stubs, update leftovers, …;
// - have read access anywhere under data\: the DB, backups, exports, and data\secrets\ (§2.4:
//   "checked at every start");
// - own anything: an owner gets WRITE_DAC with no ACE at all, so it could grant itself access again
//   at any time after a fix. `icacls /save` has no owner, so owners are read with Get-Acl (one fixed
//   read-only PowerShell script). If PowerShell is blocked by policy that part is skipped with a
//   note: it doesn't block School, and the fix resets every owner anyway. The launcher can skip it
//   on routine starts (`checkOwners: false`) and run it with the cached preflight;
// - be reachable through a link: a junction or symbolic link inside the folder is refused outright,
//   because icacls /T follows links (the check would read, and the fix would reset, whatever they
//   point to).
// School refuses to start, and also when the permissions couldn't be read at all (fail closed);
// Home warns. Both offer the fix.
//
// The ACLs are read with `icacls <path> /save <file> [/t]`, which writes SDDL: SIDs, not the
// localized account names of icacls's normal output, so the check works on any Windows language.
// It only reads (the SDDL file goes to the temp folder and is deleted at once).
//
// The fix is the spec's command, with SIDs instead of names, then the tree below it:
//   icacls "<root>" /inheritance:r /grant:r *<user>:(OI)(CI)F *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F [/remove:g *<sid>…]
//   icacls "<root>\*" /reset /t /c /q        every file and folder inside: inherited permissions only
//   icacls "<root>" /setowner *<user> /t /c /q
//   icacls "<root>\data\secrets" /inheritance:r /grant:r …   (secrets keep their own protected ACL)
// `/remove:g` drops explicit grants on the root itself (inheritance:r only drops inherited ones).
// The same runs for a --data folder outside the root. Nothing recursive runs while links exist.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execTool, isUnder, pathApi, runPowerShell, STUB_FILES, systemTool, type ExecFn, type Platform, type Preset } from './paths';

export const SID_SYSTEM = 'S-1-5-18';
export const SID_ADMINS = 'S-1-5-32-544';
export const SID_AUTHENTICATED_USERS = 'S-1-5-11';
export const SID_USERS = 'S-1-5-32-545';
export const SID_EVERYONE = 'S-1-1-0';
const SID_CREATOR_OWNER = 'S-1-3-0';
const SID_OWNER_RIGHTS = 'S-1-3-4';

// --- SDDL ------------------------------------------------------------------------------------

/** SDDL SID aliases. Domain-relative ones map to `S-1-5-21-*-<rid>` (the domain part is unknown). */
const SDDL_ALIASES: Record<string, string> = {
  AN: 'S-1-5-7', AO: 'S-1-5-32-548', AU: 'S-1-5-11', AC: 'S-1-15-2-1', BA: 'S-1-5-32-544', BG: 'S-1-5-32-546',
  BO: 'S-1-5-32-551', BU: 'S-1-5-32-545', CG: 'S-1-3-1', CO: 'S-1-3-0', CD: 'S-1-5-32-574', CY: 'S-1-5-32-569',
  ED: 'S-1-5-9', ER: 'S-1-5-32-573', HI: 'S-1-16-12288', IS: 'S-1-5-32-568', IU: 'S-1-5-4', LS: 'S-1-5-19',
  LU: 'S-1-5-32-559', LW: 'S-1-16-4096', ME: 'S-1-16-8192', MP: 'S-1-16-8448', MU: 'S-1-5-32-558',
  NO: 'S-1-5-32-556', NS: 'S-1-5-20', NU: 'S-1-5-2', OW: 'S-1-3-4', PO: 'S-1-5-32-550', PS: 'S-1-5-10',
  PU: 'S-1-5-32-547', RC: 'S-1-5-12', RD: 'S-1-5-32-555', RE: 'S-1-5-32-552', RM: 'S-1-5-32-580',
  RU: 'S-1-5-32-554', SI: 'S-1-16-16384', SO: 'S-1-5-32-549', SS: 'S-1-18-2', AS: 'S-1-18-1', SU: 'S-1-5-6',
  SY: 'S-1-5-18', WD: 'S-1-1-0', WR: 'S-1-5-33', AA: 'S-1-5-32-579', HA: 'S-1-5-32-578', UD: 'S-1-5-84-0-0-0-0-0',
  LA: 'S-1-5-21-*-500', LG: 'S-1-5-21-*-501', RO: 'S-1-5-21-*-498', DA: 'S-1-5-21-*-512', DU: 'S-1-5-21-*-513',
  DG: 'S-1-5-21-*-514', DC: 'S-1-5-21-*-515', DD: 'S-1-5-21-*-516', CA: 'S-1-5-21-*-517', SA: 'S-1-5-21-*-518',
  EA: 'S-1-5-21-*-519', PA: 'S-1-5-21-*-520', CN: 'S-1-5-21-*-522', AP: 'S-1-5-21-*-525', KA: 'S-1-5-21-*-526',
  EK: 'S-1-5-21-*-527', RS: 'S-1-5-21-*-553',
};

const WELL_KNOWN_NAMES: Record<string, string> = {
  'S-1-1-0': 'Everyone', 'S-1-5-11': 'Authenticated Users', 'S-1-5-32-545': 'Users', 'S-1-5-32-546': 'Guests',
  'S-1-5-32-547': 'Power Users', 'S-1-5-4': 'INTERACTIVE', 'S-1-5-2': 'NETWORK', 'S-1-5-7': 'ANONYMOUS LOGON',
  'S-1-5-6': 'SERVICE', 'S-1-5-19': 'LOCAL SERVICE', 'S-1-5-20': 'NETWORK SERVICE', 'S-1-3-0': 'CREATOR OWNER',
  'S-1-3-1': 'CREATOR GROUP', 'S-1-3-4': 'OWNER RIGHTS', 'S-1-15-2-1': 'ALL APPLICATION PACKAGES',
  'S-1-15-2-2': 'ALL RESTRICTED APPLICATION PACKAGES', 'S-1-5-18': 'SYSTEM', 'S-1-5-32-544': 'Administrators',
  'S-1-5-32-555': 'Remote Desktop Users', 'S-1-5-32-568': 'IIS_IUSRS', 'S-1-5-10': 'SELF', 'S-1-5-12': 'RESTRICTED',
  'S-1-5-33': 'WRITE RESTRICTED', 'S-1-2-0': 'LOCAL', 'S-1-2-1': 'CONSOLE LOGON', 'S-1-5-14': 'REMOTE INTERACTIVE LOGON',
  'S-1-5-15': 'This Organization', 'S-1-5-113': 'Local account', 'S-1-5-114': 'Local account and member of Administrators group',
  'S-1-5-21-*-512': 'Domain Admins', 'S-1-5-21-*-513': 'Domain Users', 'S-1-5-21-*-514': 'Domain Guests',
  'S-1-5-21-*-515': 'Domain Computers',
};

export function sidFromSddl(token: string): string {
  const t = token.trim();
  if (/^S-1-/i.test(t)) return t.toUpperCase();
  return SDDL_ALIASES[t.toUpperCase()] ?? t.toUpperCase();
}

/** A readable name for a SID ("Authenticated Users", or "another account (S-1-5-21-…)"). */
export function accountName(sid: string): string {
  const known = WELL_KNOWN_NAMES[sid];
  if (known) return known;
  const dom = /^S-1-5-21-\d+-\d+-\d+-(\d+)$/.exec(sid);
  if (dom) {
    const byRid = WELL_KNOWN_NAMES[`S-1-5-21-*-${dom[1]}`];
    if (byRid) return byRid;
  }
  return `another account (${sid})`;
}

const RIGHTS: Record<string, number> = {
  GA: 0x10000000, GR: 0x80000000, GW: 0x40000000, GX: 0x20000000,
  RC: 0x20000, SD: 0x10000, WD: 0x40000, WO: 0x80000,
  CC: 0x1, DC: 0x2, LC: 0x4, SW: 0x8, RP: 0x10, WP: 0x20, DT: 0x40, LO: 0x80, CR: 0x100,
  FA: 0x1f01ff, FR: 0x120089, FW: 0x120116, FX: 0x1200a0,
  KA: 0xf003f, KR: 0x20019, KW: 0x20006, KX: 0x20019,
};

export function rightsMask(s: string): number {
  const t = s.trim();
  if (/^0x[0-9a-f]+$/i.test(t)) return Number.parseInt(t.slice(2), 16) >>> 0;
  if (/^\d+$/.test(t)) return Number(t) >>> 0;
  let mask = 0;
  for (let i = 0; i + 1 < t.length; i += 2) mask |= RIGHTS[t.slice(i, i + 2).toUpperCase()] ?? 0;
  return mask >>> 0;
}

/** write data, append/add subdirectory, write EA, delete child, write attributes, DELETE, WRITE_DAC, WRITE_OWNER, GENERIC_WRITE/ALL, MAXIMUM_ALLOWED. */
export const WRITE_MASK = (0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x40000000 | 0x10000000 | 0x02000000) >>> 0;
/** read data / list directory, GENERIC_READ/ALL, MAXIMUM_ALLOWED. */
export const READ_MASK = (0x1 | 0x80000000 | 0x10000000 | 0x02000000) >>> 0;

export interface Ace {
  type: 'allow' | 'deny' | 'other';
  flags: string[];
  inherited: boolean;
  inheritOnly: boolean;
  mask: number;
  sid: string;
}

/** A parsed DACL. `nullDacl` means "no DACL": everyone has full access. */
export interface Dacl {
  nullDacl: boolean;
  protected: boolean;
  aces: Ace[];
}

function splitAces(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(s.slice(start, i));
        start = -1;
      }
    } else if (depth === 0 && c === 'S' && s[i + 1] === ':') {
      break; // the SACL starts
    }
  }
  return out;
}

export function parseDacl(sddl: string): Dacl {
  const d = sddl.indexOf('D:');
  if (d < 0) return { nullDacl: true, protected: false, aces: [] };
  const rest = sddl.slice(d + 2);
  const firstParen = rest.indexOf('(');
  const sacl = rest.search(/(^|\))S:/);
  const flagEnd = firstParen < 0 ? (sacl < 0 ? rest.length : sacl) : firstParen;
  const flags = rest.slice(0, flagEnd);
  if (/NO_ACCESS_CONTROL/i.test(flags)) return { nullDacl: true, protected: false, aces: [] };
  const aces: Ace[] = [];
  for (const body of splitAces(rest)) {
    const f = body.split(';');
    if (f.length < 6) continue;
    const t = f[0].toUpperCase();
    const flagStr = f[1].toUpperCase();
    const aceFlags: string[] = [];
    for (let i = 0; i + 1 < flagStr.length; i += 2) aceFlags.push(flagStr.slice(i, i + 2));
    aces.push({
      type: t === 'A' || t === 'OA' || t === 'XA' || t === 'ZA' ? 'allow' : t === 'D' || t === 'OD' || t === 'XD' ? 'deny' : 'other',
      flags: aceFlags,
      inherited: aceFlags.includes('ID'),
      inheritOnly: aceFlags.includes('IO'),
      mask: rightsMask(f[2]),
      sid: sidFromSddl(f[5]),
    });
  }
  return { nullDacl: false, protected: flags.toUpperCase().includes('P'), aces };
}

/** Parses an `icacls /save` file (name line, SDDL line, …). */
export function parseIcaclsSave(text: string): { name: string; sddl: string }[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.length > 0);
  const out: { name: string; sddl: string }[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push({ name: lines[i], sddl: lines[i + 1] });
  return out;
}

// --- the check -------------------------------------------------------------------------------

export type Access = 'write' | 'read';

export interface AclTarget {
  /** Label for messages: 'the folder', 'app\', 'data\', 'Start Voidswarm Host.cmd', 'app\server.mjs'. */
  label: string;
  path: string;
  access: Access;
  dir: boolean;
}

/** grant: an ACE gives the access; owner: the account owns the object; link: a junction or symbolic link. */
export type AclProblemKind = 'grant' | 'owner' | 'link';

export interface AclProblem {
  label: string;
  path: string;
  access: Access;
  sid: string;
  account: string;
  /** False when the grant is explicit on this path (the fix then removes it by SID). */
  inherited: boolean;
  kind: AclProblemKind;
}

export interface AclReport {
  ok: boolean;
  problems: AclProblem[];
  /** The permissions couldn't be read (icacls missing, access denied, too many files, …): School refuses. */
  errors: string[];
  /** Non-blocking: a part of the check that couldn't run (the owner check when PowerShell is blocked). */
  notes: string[];
  /** The top-level paths checked (root, app\, runtime\, web\, the stubs, data\). */
  checked: string[];
  /** How many files and folders had their permissions read, top level included. */
  scanned: number;
  decision: 'ok' | 'warn' | 'refuse';
  message: string | null;
  banner: string | null;
  /** The fix, for display (the panel's "what this does" lines). */
  fixCommand: string | null;
}

function allowedSid(sid: string, userSid: string): boolean {
  return sid === userSid.toUpperCase() || sid === SID_SYSTEM || sid === SID_ADMINS || sid === SID_OWNER_RIGHTS || sid === SID_CREATOR_OWNER;
}

/** The owners that are fine: the user, SYSTEM, Administrators (files an elevated process made). */
function allowedOwner(sid: string, userSid: string): boolean {
  return sid === userSid.toUpperCase() || sid === SID_SYSTEM || sid === SID_ADMINS;
}

/**
 * The accounts that may write (or read) a path, other than the allowed three.
 * - An inherit-only ACE on a folder counts: it gives its rights to what is (or will be) inside.
 * - `deep` (below the top level): inherited ACEs are skipped, because they came from the parent,
 *   which is checked itself (and the top level counts inherited ACEs too), so every grant is
 *   reported once, where it is set, instead of once per file.
 */
export function daclProblems(dacl: Dacl, target: AclTarget, userSid: string, opts: { deep?: boolean } = {}): AclProblem[] {
  if (dacl.nullDacl) {
    return [{ label: target.label, path: target.path, access: target.access, sid: SID_EVERYONE, account: 'Everyone (no permissions set)', inherited: false, kind: 'grant' }];
  }
  const mask = target.access === 'write' ? WRITE_MASK : READ_MASK;
  const bySid = new Map<string, AclProblem>();
  for (const ace of dacl.aces) {
    if (ace.type !== 'allow') continue;
    const propagates = target.dir && (ace.flags.includes('OI') || ace.flags.includes('CI'));
    if (ace.inheritOnly && !propagates) continue;
    if (opts.deep && ace.inherited) continue;
    if (!(ace.mask & mask)) continue;
    if (allowedSid(ace.sid, userSid)) continue;
    const prev = bySid.get(ace.sid);
    if (prev) {
      if (!ace.inherited) prev.inherited = false;
      continue;
    }
    bySid.set(ace.sid, { label: target.label, path: target.path, access: target.access, sid: ace.sid, account: accountName(ace.sid), inherited: ace.inherited, kind: 'grant' });
  }
  return [...bySid.values()];
}

/** The top-level paths the check always covers, for a root and its data folder (only those that exist are read). */
export function aclTargets(root: string, dataDir: string, platform: Platform = process.platform): AclTarget[] {
  const p = pathApi(platform);
  const sep = platform === 'win32' ? '\\' : '/';
  const r = p.resolve(root);
  const out: AclTarget[] = [{ label: 'the folder', path: r, access: 'write', dir: true }];
  for (const d of ['app', 'runtime', 'web']) out.push({ label: d + sep, path: p.join(r, d), access: 'write', dir: true });
  for (const s of STUB_FILES) out.push({ label: s, path: p.join(r, s), access: 'write', dir: false });
  const data = p.resolve(dataDir);
  out.push({ label: isUnder(data, r, platform) ? p.relative(r, data) + sep : data, path: data, access: 'read', dir: true });
  return out;
}

// --- walking the install ---------------------------------------------------------------------

export interface TreeEntry {
  path: string;
  label: string;
  dir: boolean;
  /** A junction or symbolic link (never followed). */
  link: boolean;
  /** 'read' under the data folder (nobody else may read), 'write' elsewhere (nobody else may change). */
  access: Access;
}

export interface TreeWalk {
  entries: TreeEntry[];
  truncated: boolean;
  errors: string[];
}

/** More than this many files and folders and the check gives up (School then refuses). */
export const MAX_TREE_ENTRIES = 50_000;

/**
 * Every file and folder under the root, and under a --data folder outside it (the bases
 * themselves not included). Links are listed but never followed.
 */
export function walkInstall(root: string, dataDir: string, platform: Platform = process.platform, max = MAX_TREE_ENTRIES): TreeWalk {
  const api = pathApi(platform);
  const sep = platform === 'win32' ? '\\' : '/';
  const rootAbs = api.resolve(root);
  const dataAbs = api.resolve(dataDir);
  const entries: TreeEntry[] = [];
  const errors: string[] = [];
  let truncated = false;
  const label = (p: string, dir: boolean) => (isUnder(p, rootAbs, platform) ? api.relative(rootAbs, p) : p) + (dir ? sep : '');
  const walk = (base: string) => {
    const stack = [base];
    while (stack.length && !truncated) {
      const dir = stack.pop()!;
      let list: fs.Dirent[];
      try {
        list = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        if (dir === base && (e as NodeJS.ErrnoException).code === 'ENOENT') return;
        errors.push(`couldn't list ${dir === base ? dir : label(dir, true)} (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
        continue;
      }
      for (const d of list) {
        if (entries.length >= max) {
          truncated = true;
          break;
        }
        const full = api.join(dir, d.name);
        const link = d.isSymbolicLink();
        const isDir = !link && d.isDirectory();
        entries.push({ path: full, label: label(full, isDir), dir: isDir, link, access: isUnder(full, dataAbs, platform) ? 'read' : 'write' });
        if (isDir) stack.push(full);
      }
    }
  };
  walk(rootAbs);
  if (!isUnder(dataAbs, rootAbs, platform)) walk(dataAbs);
  if (truncated) errors.push(`there are more than ${max} files and folders to check`);
  return { entries, truncated, errors };
}

// --- reading owners (Windows) ----------------------------------------------------------------

export interface OwnerEntry {
  path: string;
  /** The owner's SID ('?' when Get-Acl gave no owner). */
  sid: string;
}

export interface OwnerRead {
  /** Objects NOT owned by the user (the script leaves those out). */
  owners: OwnerEntry[];
  scanned: number;
  /** Set when the owners couldn't all be read (PowerShell blocked, access denied, …). */
  error?: string;
}

export type OwnerReader = (bases: string[], userSid: string) => Promise<OwnerRead>;

/**
 * The fixed, read-only owner script: walks the bases (never into links), reads each object's
 * owner from Get-Acl's SDDL (locale-free SIDs) and prints the ones not owned by VS_USER_SID, with
 * the path hex-encoded (UTF-16 code units) so no console code page can mangle it. Runs in
 * Constrained Language Mode; no double quotes (runPowerShell's rule).
 */
export const OWNER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "function VsHex([string]$s) { $r = ''; foreach ($c in $s.ToCharArray()) { $r += ([int]$c).ToString('x4') }; return $r }",
  '$me = $env:VS_USER_SID',
  '$max = [int]$env:VS_MAX',
  '$q = @()',
  "foreach ($b in @($env:VS_ROOT, $env:VS_DATA)) { if ($b) { try { $q += @(Get-Item -LiteralPath $b -Force) } catch { 'VSERR:' + (VsHex $b) } } }",
  '$k = 0; $n = 0; $errs = 0; $trunc = 0',
  'while ($k -lt $q.Count) {',
  '  if ($n -ge $max) { $trunc = 1; break }',
  '  $i = $q[$k]; $k++',
  "  try { $s = (Get-Acl -LiteralPath $i.FullName).Sddl; $n++; if ($s -match '^O:(.+?)(G:|D:|S:|$)') { if ($Matches[1] -ne $me) { 'VSOWN:' + $Matches[1] + '|' + (VsHex $i.FullName) } } else { 'VSOWN:?|' + (VsHex $i.FullName) } } catch { $errs++; 'VSERR:' + (VsHex $i.FullName) }",
  "  if ($i.PSIsContainer -and -not ([int]$i.Attributes -band 1024)) { try { $q += @(Get-ChildItem -LiteralPath $i.FullName -Force) } catch { $errs++; 'VSERR:' + (VsHex $i.FullName) } }",
  '}',
  "'VSDONE:' + $n + '|' + $errs + '|' + $trunc",
].join('\n');

function unhex(h: string): string {
  let s = '';
  for (let i = 0; i + 3 < h.length; i += 4) s += String.fromCharCode(Number.parseInt(h.slice(i, i + 4), 16));
  return s;
}

export function parseOwnerOutput(stdout: string): OwnerRead & { done: boolean } {
  const owners: OwnerEntry[] = [];
  const failed: string[] = [];
  let done = false;
  let scanned = 0;
  let errs = 0;
  let trunc = false;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^VSOWN:([^|]+)\|([0-9a-f]*)$/i.exec(line))) owners.push({ sid: sidFromSddl(m[1]), path: unhex(m[2]) });
    else if ((m = /^VSERR:([0-9a-f]*)$/i.exec(line))) failed.push(unhex(m[1]));
    else if ((m = /^VSDONE:(\d+)\|(\d+)\|([01])$/.exec(line))) {
      done = true;
      scanned = Number(m[1]);
      errs = Number(m[2]);
      trunc = m[3] === '1';
    }
  }
  for (const o of owners) if (o.sid === '?') failed.push(o.path);
  let error: string | undefined;
  if (!done) error = 'the owner check did not finish';
  else if (trunc) error = 'too many files for the owner check';
  else if (errs || failed.length) error = `the owners of ${Math.max(failed.length, errs)} item(s) couldn't be read${failed[0] ? ` (${failed[0]})` : ''}`;
  return { owners, scanned, error, done };
}

function powershellOwnerReader(exec: ExecFn | undefined, max: number): OwnerReader {
  return async (bases, userSid) => {
    const r = await runPowerShell(OWNER_SCRIPT, { VS_ROOT: bases[0] ?? '', VS_DATA: bases[1] ?? '', VS_USER_SID: userSid, VS_MAX: String(max) }, { exec, timeoutMs: 120_000 });
    const parsed = parseOwnerOutput(r.stdout ?? '');
    if (!parsed.done) {
      const why = (r.error ?? r.stderr ?? '').trim().split(/\r?\n/)[0]?.slice(0, 160) || `PowerShell exit ${r.code}`;
      return { owners: parsed.owners, scanned: parsed.scanned, error: `PowerShell: ${why}` };
    }
    return { owners: parsed.owners, scanned: parsed.scanned, error: parsed.error };
  };
}

// --- reading DACLs (Windows) -----------------------------------------------------------------

async function icaclsSave(
  target: string,
  exec: ExecFn,
  tmpDir: string,
  recursive = false,
): Promise<{ entries: { name: string; sddl: string }[]; error?: string }> {
  const out = path.join(tmpDir, `vs-acl-${process.pid}-${randomBytes(6).toString('hex')}.txt`);
  try {
    const args = [target, '/save', out, '/c', '/q', ...(recursive ? ['/t'] : [])];
    const r = await exec(systemTool('icacls'), args, { timeoutMs: recursive ? 120_000 : 20_000 });
    let text: string | null = null;
    try {
      text = fs.readFileSync(out).toString('utf16le');
    } catch {
      text = null;
    }
    if (text === null) return { entries: [], error: `icacls could not read the permissions of ${target} (${(r.error ?? r.stderr ?? r.stdout ?? '').trim() || `exit ${r.code}`})` };
    return { entries: parseIcaclsSave(text), error: r.code === 0 ? undefined : (r.stderr || r.stdout || '').trim() || undefined };
  } finally {
    try {
      fs.unlinkSync(out);
    } catch {
      /* already gone */
    }
  }
}

export interface AclOptions {
  root: string;
  dataDir: string;
  /** The launcher's own SID (elevation.ts readToken().userSid). */
  userSid: string;
  preset: Preset;
  platform?: Platform;
  exec?: ExecFn;
  /** Where icacls writes its SDDL file (default os.tmpdir()). */
  tmpDir?: string;
  /** How the message says to fix it (the launcher knows whether the panel is up). */
  fixHint?: string;
  /** Reads owners (Windows default: the Get-Acl script; tests inject). */
  readOwners?: OwnerReader;
  /**
   * Windows: run the owner check (default true). It is the one PowerShell spawn in this check; the
   * launcher may skip it on routine starts and run it when the cached preflight runs (first run,
   * update, daily): a foreign owner can only appear again through a write grant, which the icacls
   * part sees at every start, and the fix resets every owner.
   */
  checkOwners?: boolean;
  /** Tests: a smaller limit for the tree walk. */
  maxEntries?: number;
}

interface WinRead {
  dacls: Map<string, { path: string; dacl: Dacl }>;
  errors: string[];
}

function hasChildren(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/** The bases a check or fix works on: the root, plus a --data folder outside it. */
function basesOf(rootAbs: string, dataAbs: string, platform: Platform): string[] {
  const out = [rootAbs];
  if (!isUnder(dataAbs, rootAbs, platform) && fs.existsSync(dataAbs)) out.push(dataAbs);
  return out;
}

async function readWindows(bases: string[], deep: boolean, exec: ExecFn, tmpDir: string): Promise<WinRead> {
  const dacls = new Map<string, { path: string; dacl: Dacl }>();
  const errors: string[] = [];
  const key = (p: string) => p.toLowerCase();
  await Promise.all(
    bases.map(async (b) => {
      if (!fs.existsSync(b)) return;
      // One call for the base itself, one for everything inside it (/t, unless links make that unsafe).
      const [self, kids] = await Promise.all([
        icaclsSave(b, exec, tmpDir),
        hasChildren(b) ? icaclsSave(path.win32.join(b, '*'), exec, tmpDir, deep) : Promise.resolve(null),
      ]);
      if (self.error) errors.push(self.error);
      if (self.entries[0]) dacls.set(key(b), { path: b, dacl: parseDacl(self.entries[0].sddl) });
      if (kids) {
        if (kids.error && !kids.entries.length) errors.push(kids.error);
        for (const e of kids.entries) {
          const p = path.win32.join(b, e.name);
          dacls.set(key(p), { path: p, dacl: parseDacl(e.sddl) });
        }
      }
    }),
  );
  return { dacls, errors };
}

interface Found {
  problems: AclProblem[];
  errors: string[];
  notes: string[];
  checked: string[];
  scanned: number;
}

function linkProblems(walk: TreeWalk): AclProblem[] {
  return walk.entries
    .filter((e) => e.link)
    .map((e) => ({ label: e.label, path: e.path, access: e.access, sid: 'link', account: 'a link', inherited: false, kind: 'link' as const }));
}

async function checkWindows(opts: AclOptions, targets: AclTarget[], walk: TreeWalk): Promise<Found> {
  const rootAbs = path.win32.resolve(opts.root);
  const dataAbs = path.win32.resolve(opts.dataDir);
  const exec = opts.exec ?? execTool;
  const bases = basesOf(rootAbs, dataAbs, 'win32');
  const links = linkProblems(walk);
  // icacls /t follows links, so the deep read only runs when there are none (a link is refused anyway).
  const deep = !links.length && !walk.truncated;
  const readOwners: OwnerReader =
    opts.checkOwners === false ? async () => ({ owners: [], scanned: 0 }) : opts.readOwners ?? powershellOwnerReader(opts.exec, opts.maxEntries ?? MAX_TREE_ENTRIES);
  const [read, owners] = await Promise.all([
    readWindows(bases, deep, exec, opts.tmpDir ?? os.tmpdir()),
    Promise.resolve()
      .then(() => readOwners(bases, opts.userSid))
      .catch((e: unknown): OwnerRead => ({ owners: [], scanned: 0, error: String((e as Error)?.message ?? e) })),
  ]);
  const problems: AclProblem[] = [...links];
  const errors = [...walk.errors, ...read.errors];
  const notes: string[] = [];
  const checked: string[] = [];
  const key = (p: string) => p.toLowerCase();
  const topKeys = new Set(targets.map((t) => key(t.path)));
  let scanned = 0;

  for (const t of targets) {
    if (!fs.existsSync(t.path)) continue;
    const d = read.dacls.get(key(t.path));
    if (!d) {
      errors.push(`No permissions were read for ${t.label}.`);
      continue;
    }
    checked.push(t.path);
    scanned++;
    problems.push(...daclProblems(d.dacl, t, opts.userSid));
  }

  if (deep) {
    const missing: string[] = [];
    const walked = new Set<string>();
    for (const e of walk.entries) {
      const k = key(e.path);
      walked.add(k);
      if (topKeys.has(k)) continue;
      const d = read.dacls.get(k);
      if (!d) {
        if (fs.existsSync(e.path)) missing.push(e.label); // gone meanwhile (a temp file): nothing to check
        continue;
      }
      scanned++;
      problems.push(...daclProblems(d.dacl, e, opts.userSid, { deep: true }));
    }
    // Anything icacls saw that the walk didn't (created in between).
    for (const [k, d] of read.dacls) {
      if (walked.has(k) || topKeys.has(k) || bases.some((b) => key(b) === k)) continue;
      scanned++;
      const access: Access = isUnder(d.path, dataAbs, 'win32') ? 'read' : 'write';
      const label = isUnder(d.path, rootAbs, 'win32') ? path.win32.relative(rootAbs, d.path) : d.path;
      problems.push(...daclProblems(d.dacl, { label, path: d.path, access, dir: false }, opts.userSid, { deep: true }));
    }
    if (missing.length) errors.push(`No permissions were read for ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ''}.`);
  }

  // Owners.
  const labelOf = (p: string) => walk.entries.find((e) => key(e.path) === key(p))?.label ?? targets.find((t) => key(t.path) === key(p))?.label ?? p;
  for (const o of owners.owners) {
    if (o.sid === '?') continue; // counted in owners.error
    if (allowedOwner(o.sid, opts.userSid)) continue;
    problems.push({
      label: labelOf(o.path),
      path: o.path,
      access: isUnder(o.path, dataAbs, 'win32') ? 'read' : 'write',
      sid: o.sid,
      account: accountName(o.sid),
      inherited: false,
      kind: 'owner',
    });
  }
  if (owners.error) notes.push(`Voidswarm couldn't check who owns its files (${owners.error}); the other permission checks ran.`);
  return { problems, errors, notes, checked, scanned };
}

/**
 * macOS/Linux: mode bits and owners. Code (outside data/): no group or other write bit anywhere.
 * data/ itself: no group or other bit at all (not even x, which lets anyone open a file they can
 * name); what is inside it is then out of reach, so only its owners are checked.
 */
function checkPosix(opts: AclOptions, targets: AclTarget[], walk: TreeWalk): Found {
  const problems: AclProblem[] = [...linkProblems(walk)];
  const checked: string[] = [];
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const dataAbs = path.posix.resolve(opts.dataDir);
  let scanned = 0;
  const topKeys = new Set(targets.map((t) => t.path));
  const items: { t: AclTarget; top: boolean }[] = [
    ...targets.map((t) => ({ t, top: true })),
    ...walk.entries.filter((e) => !e.link && !topKeys.has(e.path)).map((e) => ({ t: e as AclTarget, top: false })),
  ];
  for (const { t, top } of items) {
    let st: fs.Stats;
    try {
      st = top ? fs.statSync(t.path) : fs.lstatSync(t.path);
    } catch {
      continue;
    }
    if (top) checked.push(t.path);
    scanned++;
    const mode = st.mode & 0o777;
    const bits = t.access === 'write' ? { group: 0o020, others: 0o002 } : t.path === dataAbs ? { group: 0o070, others: 0o007 } : { group: 0, others: 0 };
    const base = { label: t.label, path: t.path, access: t.access, inherited: false };
    if (mode & bits.group) problems.push({ ...base, sid: 'group', account: 'the file group', kind: 'grant' });
    if (mode & bits.others) problems.push({ ...base, sid: 'others', account: 'other users', kind: 'grant' });
    if (uid >= 0 && st.uid !== uid && st.uid !== 0) {
      problems.push({ ...base, sid: `uid:${st.uid}`, account: `another user (uid ${st.uid})`, kind: 'owner' });
    }
  }
  return { problems, errors: [...walk.errors], notes: [], checked, scanned };
}

export const DEFAULT_FIX_HINT =
  // The panel button needs the server -> launcher action path (planned with the M2 work, now in Quark); until then
  // the hint names only what works today (owner report, 2026-10-01).
  'To fix it, stop the host (close its black console window), open a Command Prompt in the Voidswarm LAN folder and run ' +
  '"Start Voidswarm Host.cmd" --fix-permissions. ' +
  'That gives only you, SYSTEM and Administrators access to this folder and everything in it, then starts the host.';

const IT_HINT = "If that doesn't help, give FOR SCHOOL IT.txt to IT.";

function describe(problems: AclProblem[]): string[] {
  const groups = new Map<string, { kind: AclProblemKind; account: string; access: Access; labels: string[] }>();
  for (const x of problems) {
    const k = `${x.kind}|${x.sid}|${x.access}`;
    const g = groups.get(k) ?? { kind: x.kind, account: x.account, access: x.access, labels: [] };
    if (!g.labels.includes(x.label)) g.labels.push(x.label);
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => {
    const shown = g.labels.slice(0, 3).join(', ') + (g.labels.length > 3 ? ` (+${g.labels.length - 3} more)` : '');
    if (g.kind === 'link') {
      return `  - ${shown} ${g.labels.length > 1 ? 'are links' : 'is a link'} to another place. Voidswarm's folder must not contain links: delete the link itself (not what it points to).`;
    }
    if (g.kind === 'owner') return `  - ${g.account} owns ${shown}, so it can change ${g.labels.length > 1 ? 'their' : 'its'} permissions`;
    return `  - ${g.account} can ${g.access === 'write' ? 'change' : 'read'} ${shown}`;
  });
}

export function aclDecision(
  problems: AclProblem[],
  errors: string[],
  preset: Preset,
  fixHint = DEFAULT_FIX_HINT,
  notes: string[] = [],
): Pick<AclReport, 'decision' | 'message' | 'banner'> {
  if (!problems.length) {
    if (errors.length) {
      // Fail closed in School: an unchecked folder is not a checked one.
      if (preset === 'school') {
        return {
          decision: 'refuse',
          message: [`School mode won't start: Voidswarm couldn't check who can reach its folder (${errors[0]}).`, fixHint, IT_HINT].join('\n'),
          banner: null,
        };
      }
      return {
        decision: 'warn',
        message: `Voidswarm couldn't check this folder's permissions (${errors[0]}).`,
        banner: "Folder permissions couldn't be checked.",
      };
    }
    if (notes.length) return { decision: 'warn', message: notes.join('\n'), banner: null };
    return { decision: 'ok', message: null, banner: null };
  }
  const lines = describe(problems);
  if (preset === 'school') {
    return {
      decision: 'refuse',
      message: [
        "School mode won't start while other accounts on this PC can change Voidswarm's files or read its data:",
        ...lines,
        fixHint,
      ].join('\n'),
      banner: null,
    };
  }
  return {
    decision: 'warn',
    message: ["Other accounts on this PC can change Voidswarm's files or read its data:", ...lines, fixHint].join('\n'),
    banner: 'Permissions warning: other accounts on this PC can reach Voidswarm\'s folder. Fix permissions →',
  };
}

function quoteArg(a: string): string {
  return /[\s&()'^]/.test(a) ? `"${a}"` : a;
}

/** Human-readable form of the spec's fix for a root (quotes as a user would type it in cmd). */
export function fixCommandLine(root: string, userSid: string): string {
  return `icacls "${root}" /inheritance:r /grant:r *${userSid}:(OI)(CI)F *${SID_SYSTEM}:(OI)(CI)F *${SID_ADMINS}:(OI)(CI)F`;
}

/** Every command the one-click fix runs (for the panel's "what this does" lines). */
export function fixCommandLines(root: string, dataDir: string, userSid: string): string[] {
  const r = path.win32.resolve(root);
  const d = path.win32.resolve(dataDir);
  const bases = [r, ...(isUnder(d, r, 'win32') ? [] : [d])];
  const out: string[] = [];
  for (const b of bases) {
    out.push(fixCommandLine(b, userSid));
    out.push(`icacls "${path.win32.join(b, '*')}" /reset /t /c /q`);
    out.push(`icacls "${b}" /setowner *${userSid} /t /c /q`);
  }
  out.push(`icacls "${path.win32.join(d, 'secrets')}" /inheritance:r /grant:r *${userSid}:(OI)(CI)F *${SID_SYSTEM}:(OI)(CI)F *${SID_ADMINS}:(OI)(CI)F`);
  return out;
}

/** icacls arguments that give a folder exactly the user, SYSTEM and Administrators (full, inherited by children). */
export function fixArgs(target: string, userSid: string, removeSids: string[] = []): string[] {
  const args = [target, '/inheritance:r', '/grant:r', `*${userSid}:(OI)(CI)F`, `*${SID_SYSTEM}:(OI)(CI)F`, `*${SID_ADMINS}:(OI)(CI)F`];
  const remove = removeSids.filter((s) => /^S-1-\d+(-\d+)+$/.test(s) && !allowedSid(s, userSid));
  if (remove.length) args.push('/remove:g', ...remove.map((s) => `*${s}`));
  return args;
}

/** Reads the permissions of the whole install and applies the preset's rule (School refuses, Home warns). */
export async function checkPermissions(opts: AclOptions): Promise<AclReport> {
  const platform = opts.platform ?? process.platform;
  const targets = aclTargets(opts.root, opts.dataDir, platform);
  const walk = walkInstall(opts.root, opts.dataDir, platform, opts.maxEntries);
  const found = platform === 'win32' ? await checkWindows(opts, targets, walk) : checkPosix(opts, targets, walk);
  const decision = aclDecision(found.problems, found.errors, opts.preset, opts.fixHint, found.notes);
  return {
    ok: found.problems.length === 0 && found.errors.length === 0,
    problems: found.problems,
    errors: found.errors,
    notes: found.notes,
    checked: found.checked,
    scanned: found.scanned,
    ...decision,
    fixCommand:
      found.problems.length || found.errors.length
        ? platform === 'win32'
          ? fixCommandLines(opts.root, opts.dataDir, opts.userSid).join('\n')
          : `chmod -R go-w "${opts.root}" && chmod -R go-rwx "${opts.dataDir}"`
        : null,
  };
}

export interface FixResult {
  /** The re-check after the fix. */
  report: AclReport;
  /** Commands run (for the audit line and the console). */
  ran: string[];
  errors: string[];
}

function linkRefusal(links: AclProblem[]): string {
  const shown = links.slice(0, 3).map((l) => l.label).join(', ') + (links.length > 3 ? ` (+${links.length - 3} more)` : '');
  return `Not changing anything inside the folder while it contains links (${shown}): delete the links themselves (not what they point to), then run the fix again.`;
}

function fixPosix(opts: AclOptions, before: AclReport, platform: Platform): { ran: string[]; errors: string[] } {
  const ran: string[] = [];
  const errors: string[] = [];
  const targets = aclTargets(opts.root, opts.dataDir, platform);
  const walk = walkInstall(opts.root, opts.dataDir, platform, opts.maxEntries);
  const dataAbs = path.posix.resolve(opts.dataDir);
  const items = [...targets, ...walk.entries.filter((e) => !e.link)];
  const seen = new Set<string>();
  for (const t of items) {
    if (seen.has(t.path)) continue;
    seen.add(t.path);
    try {
      const st = fs.lstatSync(t.path);
      if (st.isSymbolicLink()) continue;
      const mode = st.mode & 0o777;
      const next = t.access === 'read' ? (st.isDirectory() || t.path === dataAbs ? 0o700 : mode & ~0o077) : mode & ~0o022;
      if (next !== mode) {
        fs.chmodSync(t.path, next);
        ran.push(`chmod ${next.toString(8)} ${t.path}`);
      }
    } catch {
      /* missing */
    }
  }
  if (before.problems.some((p) => p.kind === 'owner')) {
    errors.push(`Some files belong to another user. Run: sudo chown -R "$USER" "${opts.root}"${isUnder(dataAbs, path.posix.resolve(opts.root), platform) ? '' : ` "${dataAbs}"`}`);
  }
  if (before.problems.some((p) => p.kind === 'link')) errors.push(linkRefusal(before.problems.filter((p) => p.kind === 'link')));
  return { ran, errors };
}

/**
 * The one-click fix (panel, or `--fix-permissions`). Gives each base (the root, and a --data folder
 * outside it) the spec's ACL, then resets everything inside to inherited permissions only, makes the
 * user the owner of every object, re-protects data\secrets\, and re-checks. When the folder
 * contains links it changes only the bases themselves and says to delete the links first.
 */
export async function fixPermissions(opts: AclOptions): Promise<FixResult> {
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? execTool;
  const ran: string[] = [];
  const errors: string[] = [];
  const before = await checkPermissions(opts);
  if (platform !== 'win32') {
    const px = fixPosix(opts, before, platform);
    return { report: await checkPermissions(opts), ran: px.ran, errors: px.errors };
  }

  const icacls = systemTool('icacls');
  const rootAbs = path.win32.resolve(opts.root);
  const dataAbs = path.win32.resolve(opts.dataDir);
  const run = async (args: string[], timeoutMs = 120_000) => {
    const r = await exec(icacls, args, { timeoutMs });
    ran.push(`icacls ${args.map(quoteArg).join(' ')}`);
    if (r.code !== 0) errors.push(`icacls could not change ${args[0]}: ${(r.stderr || r.stdout || r.error || '').trim().split(/\r?\n/)[0] ?? ''}`);
    return r;
  };
  const explicitOn = (p: string) =>
    [...new Set(before.problems.filter((x) => x.kind === 'grant' && x.path.toLowerCase() === p.toLowerCase() && !x.inherited).map((x) => x.sid))];

  const bases = basesOf(rootAbs, dataAbs, 'win32');
  // 1. The spec's command on each base. Not recursive, so it is safe even while links exist.
  for (const b of bases) await run(fixArgs(b, opts.userSid, explicitOn(b)), 60_000);

  const links = before.problems.filter((p) => p.kind === 'link');
  if (links.length) {
    errors.push(linkRefusal(links));
    return { report: await checkPermissions(opts), ran, errors };
  }
  for (const b of bases) {
    // 2. Everything inside: inherited permissions only (drops explicit grants, turns inheritance back on).
    if (hasChildren(b)) await run([path.win32.join(b, '*'), '/reset', '/t', '/c', '/q']);
    // 3. Everything owned by the user: a foreign owner could grant itself access again at any time.
    await run([b, '/setowner', `*${opts.userSid}`, '/t', '/c', '/q']);
  }
  // 4. data\secrets\ keeps its own protected ACL (§2.4), whatever the reset did.
  const secrets = path.win32.join(dataAbs, 'secrets');
  if (fs.existsSync(secrets)) {
    const args = fixArgs(secrets, opts.userSid);
    const err = await protectDir(secrets, opts.userSid, { exec });
    ran.push(`icacls ${args.map(quoteArg).join(' ')}`);
    if (err) errors.push(err);
  }
  return { report: await checkPermissions(opts), ran, errors };
}

/**
 * Gives a folder the owner/SYSTEM/Administrators ACL (data\secrets\ always gets it when created,
 * whatever the root's state). Returns an error text, or null.
 */
export async function protectDir(dir: string, userSid: string, opts: { exec?: ExecFn; platform?: Platform } = {}): Promise<string | null> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
      return null;
    } catch (e) {
      return String((e as Error).message);
    }
  }
  const r = await (opts.exec ?? execTool)(systemTool('icacls'), fixArgs(path.win32.resolve(dir), userSid), { timeoutMs: 30_000 });
  return r.code === 0 ? null : `icacls could not protect ${dir}: ${(r.stderr || r.stdout || r.error || '').trim()}`;
}
