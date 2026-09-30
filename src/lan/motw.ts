// LAN edition: Mark-of-the-Web listing (§2.2 step 4).
//
// Files extracted from a zip that wasn't unblocked carry a `:Zone.Identifier` stream (ZoneId=3,
// "Internet"). SmartScreen, Smart App Control and antivirus then treat the stubs and node.exe as
// untrusted downloads. The launcher lists them and says "unblock these". It never strips the
// streams itself: a program removing its own MOTW is itself an antivirus signal.

import fs from 'node:fs';
import path from 'node:path';
import { STUB_FILES, type Platform } from './paths';

export interface MotwFile {
  path: string;
  /** Relative to the root, for display. */
  rel: string;
  /** 3 = Internet, 4 = Restricted; null when the stream exists but has no readable ZoneId. */
  zoneId: number | null;
  kind: 'program' | 'stub' | 'script' | 'page' | 'other';
}

export interface MotwReport {
  /** Files whose zone makes Windows treat them as downloaded (ZoneId ≥ 3, or unreadable). */
  files: MotwFile[];
  /** How many files were looked at. */
  scanned: number;
  /** The scan stopped at the file limit. */
  truncated: boolean;
  /** Most of the folder is marked: the zip itself was not unblocked before extracting. */
  wholeFolder: boolean;
  /** Console / panel text, or null when nothing is marked. */
  message: string | null;
}

/** Reads ZoneId from a Zone.Identifier stream. The HostUrl/ReferrerUrl lines are ignored (never logged). */
export function parseZoneIdentifier(text: string): number | null {
  const m = /^\s*ZoneId\s*=\s*(\d+)\s*$/im.exec(text.replace(/^﻿/, ''));
  return m ? Number(m[1]) : null;
}

function kindOf(rel: string): MotwFile['kind'] {
  const base = rel.split(/[\\/]/).pop() ?? rel;
  if ((STUB_FILES as readonly string[]).includes(base)) return 'stub';
  if (/\.(exe|dll|node)$/i.test(base)) return 'program';
  if (/\.(cmd|bat|ps1|vbs|js|mjs|cjs)$/i.test(base)) return 'script';
  if (/\.html?$/i.test(base)) return 'page';
  return 'other';
}

export interface MotwOptions {
  platform?: Platform;
  /** Top-level folders scanned recursively (default app, runtime, web). Root-level files are always scanned. */
  dirs?: string[];
  /** Stop after this many files (default 20,000). */
  maxFiles?: number;
  /** Reads a file's Zone.Identifier stream; null when it has none (injectable for tests). */
  readZone?: (file: string) => string | null;
}

function defaultReadZone(file: string): string | null {
  try {
    return fs.readFileSync(`${file}:Zone.Identifier`, 'utf8');
  } catch {
    return null;
  }
}

/** Lists files under the root that still carry Mark-of-the-Web. Windows only (other OSes: empty). */
export function scanMotw(root: string, opts: MotwOptions = {}): MotwReport {
  const platform = opts.platform ?? process.platform;
  const empty: MotwReport = { files: [], scanned: 0, truncated: false, wholeFolder: false, message: null };
  if (platform !== 'win32') return empty;
  const api = path; // the scan walks the real filesystem
  const readZone = opts.readZone ?? defaultReadZone;
  const max = opts.maxFiles ?? 20_000;
  const files: MotwFile[] = [];
  let scanned = 0;
  let truncated = false;

  const visit = (file: string) => {
    if (scanned >= max) {
      truncated = true;
      return;
    }
    scanned++;
    const text = readZone(file);
    if (text === null) return;
    const zoneId = parseZoneIdentifier(text);
    if (zoneId !== null && zoneId < 3) return; // local, intranet or trusted: no prompt
    const rel = api.relative(root, file);
    files.push({ path: file, rel, zoneId, kind: kindOf(rel) });
  };

  const walk = (dir: string, depth: number) => {
    if (depth > 12 || truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      const full = api.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) visit(full);
    }
  };

  let top: fs.Dirent[] = [];
  try {
    top = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return empty;
  }
  for (const e of top) if (e.isFile()) visit(api.join(root, e.name));
  for (const d of opts.dirs ?? ['app', 'runtime', 'web']) walk(api.join(root, d), 1);

  const wholeFolder = scanned >= 4 && files.length >= Math.ceil(scanned * 0.5);
  return { files, scanned, truncated, wholeFolder, message: motwMessage(files, wholeFolder) };
}

/**
 * The advice never says to delete the folder: data\ (accounts, the chat log, backups, secrets)
 * lives inside it and the marks come back at every start until they are fixed. Re-extracting an
 * unblocked zip over the same folder replaces app\, runtime\, web\ and the stubs; the zip has no
 * data\, so data\ is kept.
 */
export function motwMessage(files: MotwFile[], wholeFolder: boolean): string | null {
  if (!files.length) return null;
  if (wholeFolder) {
    return [
      `${files.length} files in this folder are still marked as downloaded from the internet, so SmartScreen and antivirus treat Voidswarm as untrusted.`,
      'The zip was not unblocked before extracting. To fix it: close Voidswarm, right-click the zip → Properties → tick Unblock → OK, ' +
        'then extract it again into this same place and choose "Replace the files in the destination".',
      'Your data\\ folder (accounts, chat log, settings, backups) is kept: the zip has no data\\ folder.',
    ].join('\n');
  }
  const order: MotwFile['kind'][] = ['stub', 'program', 'script', 'page', 'other'];
  const sorted = [...files].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const shown = sorted.slice(0, 8).map((f) => `  - ${f.rel}`);
  if (sorted.length > 8) shown.push(`  - … and ${sorted.length - 8} more`);
  return [
    'These files are still marked as downloaded from the internet. Unblock them: right-click each → Properties → tick Unblock → OK.',
    ...shown,
  ].join('\n');
}

/** For tests and tools: the stream path Windows uses. */
export function zoneStreamPath(file: string): string {
  return `${path.resolve(file)}:Zone.Identifier`;
}
