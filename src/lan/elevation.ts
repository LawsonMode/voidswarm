// LAN edition: who the launcher runs as, and whether it was started as administrator (§2.2 step 2).
//
// `whoami /user /groups /fo csv /nh` gives the user SID (acl.ts needs it) and the token's mandatory
// label. A High label (S-1-16-12288) or above means an elevated token. The SIDs are locale-free,
// unlike the group names and attribute texts, so only the SIDs are trusted. A token that can't be
// read at all is treated as "can't check": School refuses (fail closed), Home warns.

import { execTool, systemTool, type ExecFn, type Platform, type Preset } from './paths';

export type Integrity = 'untrusted' | 'low' | 'medium' | 'medium-plus' | 'high' | 'system' | 'protected' | 'unknown';

export interface TokenGroup {
  name: string;
  sid: string;
  attributes: string;
}

export interface TokenInfo {
  /** The user's SID (S-1-5-21-…), or null when whoami couldn't be read. */
  userSid: string | null;
  /** DOMAIN\user as whoami prints it (for display only). */
  userName: string | null;
  integrity: Integrity;
  /** The mandatory-label SID, e.g. S-1-16-8192. */
  integritySid: string | null;
  groups: TokenGroup[];
  /** Why the token couldn't be read (whoami failed or printed nothing usable). */
  error?: string;
}

const INTEGRITY_RIDS: [number, Integrity][] = [
  [0x5000, 'protected'],
  [0x4000, 'system'],
  [0x3000, 'high'],
  [0x2100, 'medium-plus'],
  [0x2000, 'medium'],
  [0x1000, 'low'],
  [0x0, 'untrusted'],
];

export function integrityFromSid(sid: string | null): Integrity {
  const m = sid ? /^S-1-16-(\d+)$/i.exec(sid.trim()) : null;
  if (!m) return 'unknown';
  const rid = Number(m[1]);
  for (const [min, name] of INTEGRITY_RIDS) if (rid >= min) return name;
  return 'unknown';
}

/** Splits one CSV line as whoami writes it ("a","b,c","d""e"). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let i = 0;
  const s = line.replace(/\r$/, '');
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (c === ',') {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  out.push(cur);
  return out;
}

const SID_RE = /^S-1-\d+(-\d+)*$/i;

/** Parses `whoami /user /groups /fo csv /nh` (either part may be missing). */
export function parseWhoami(text: string): TokenInfo {
  const info: TokenInfo = { userSid: null, userName: null, integrity: 'unknown', integritySid: null, groups: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('"')) continue;
    const f = parseCsvLine(line);
    if (f.length === 2 && SID_RE.test(f[1]) && !info.userSid) {
      info.userName = f[0];
      info.userSid = f[1].toUpperCase();
    } else if (f.length >= 3 && SID_RE.test(f[2])) {
      const sid = f[2].toUpperCase();
      info.groups.push({ name: f[0], sid, attributes: f[3] ?? '' });
      if (/^S-1-16-\d+$/.test(sid)) {
        info.integritySid = sid;
        info.integrity = integrityFromSid(sid);
      }
    }
  }
  return info;
}

export async function readToken(opts: { exec?: ExecFn; platform?: Platform } = {}): Promise<TokenInfo> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    return {
      userSid: uid >= 0 ? `uid:${uid}` : null,
      userName: null,
      integrity: uid === 0 ? 'high' : uid > 0 ? 'medium' : 'unknown',
      integritySid: null,
      groups: [],
    };
  }
  const r = await (opts.exec ?? execTool)(systemTool('whoami'), ['/user', '/groups', '/fo', 'csv', '/nh'], { timeoutMs: 10_000 });
  const info = parseWhoami(r.stdout ?? '');
  if (!info.userSid || info.integrity === 'unknown') {
    const why = (r.error ?? r.stderr ?? '').trim().slice(0, 200) || (r.code !== 0 ? `exit ${r.code}` : 'no user or integrity level in its output');
    info.error = `whoami: ${why}`;
  }
  return info;
}

export function isElevated(token: TokenInfo): boolean {
  return token.integrity === 'high' || token.integrity === 'system' || token.integrity === 'protected';
}

export interface ElevationCheck {
  elevated: boolean;
  integrity: Integrity;
  /** School refuses an elevated start; Home starts with a warning banner (§2.2 step 2, §5.13). */
  decision: 'ok' | 'warn' | 'refuse';
  /** Console / refusal text (null when ok). */
  message: string | null;
  /** Short panel banner for Home (null unless warn). */
  banner: string | null;
}

export const ELEVATED_REFUSE =
  'Voidswarm was started as administrator. School mode never runs that way: close this window and ' +
  'double-click "Start Voidswarm Host.cmd" normally (not "Run as administrator").';
export const ELEVATED_WARN =
  'Voidswarm is running as administrator, which gives the game server more rights than it needs. ' +
  'Start it normally next time (not "Run as administrator"). If User Account Control is switched off ' +
  'on this PC, everything runs this way: consider turning it back on.';
export const ELEVATED_BANNER = 'Running as administrator: start Voidswarm normally (not "Run as administrator").';
export const UNKNOWN_REFUSE =
  "Voidswarm couldn't check how it was started (whoami didn't answer), and School mode needs that check. " +
  'Restart the PC and start it again; if this keeps happening, give FOR SCHOOL IT.txt to IT.';
export const UNKNOWN_WARN = "Voidswarm couldn't check whether it runs as administrator (whoami didn't answer).";
export const UNKNOWN_BANNER = "Couldn't check whether Voidswarm runs as administrator.";

/**
 * School refuses an elevated start, and also one it can't check (fail closed); Home starts with a
 * banner in both cases.
 */
export function decideElevation(token: TokenInfo, preset: Preset): ElevationCheck {
  const elevated = isElevated(token);
  if (!elevated && token.integrity === 'unknown') {
    if (preset === 'school') {
      return { elevated, integrity: token.integrity, decision: 'refuse', message: UNKNOWN_REFUSE + (token.error ? ` (${token.error})` : ''), banner: null };
    }
    return { elevated, integrity: token.integrity, decision: 'warn', message: UNKNOWN_WARN, banner: UNKNOWN_BANNER };
  }
  if (!elevated) return { elevated, integrity: token.integrity, decision: 'ok', message: null, banner: null };
  if (preset === 'school') return { elevated, integrity: token.integrity, decision: 'refuse', message: ELEVATED_REFUSE, banner: null };
  return { elevated, integrity: token.integrity, decision: 'warn', message: ELEVATED_WARN, banner: ELEVATED_BANNER };
}

export async function checkElevation(
  preset: Preset,
  opts: { exec?: ExecFn; platform?: Platform; token?: TokenInfo } = {},
): Promise<ElevationCheck & { token: TokenInfo }> {
  const token = opts.token ?? (await readToken(opts));
  return { ...decideElevation(token, preset), token };
}
