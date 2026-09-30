import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { motwMessage, parseZoneIdentifier, scanMotw, zoneStreamPath } from './motw';

describe('Zone.Identifier parsing', () => {
  it('reads ZoneId and ignores the URL lines', () => {
    expect(parseZoneIdentifier('[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://example.com/\r\nHostUrl=https://example.com/x.zip\r\n')).toBe(3);
    expect(parseZoneIdentifier('﻿[ZoneTransfer]\nZoneId = 4\n')).toBe(4);
    expect(parseZoneIdentifier('garbage')).toBeNull();
  });
});

describe('MOTW listing (injected streams)', () => {
  let root = '';
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-motw-'));
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(root, 'web', 'assets'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    for (const f of ['Start Voidswarm Host.cmd', 'START HERE.html', 'app/launch.mjs', 'app/server.mjs', 'runtime/node.exe', 'web/index.html', 'web/assets/a.js', 'data/voidswarm.db']) {
      fs.writeFileSync(path.join(root, f), 'x');
    }
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const zones = (marked: Record<string, string>) => (file: string) => {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    return marked[rel] ?? null;
  };

  it('lists the stub and node.exe first, skips zones below 3 and never looks in data\\', () => {
    const r = scanMotw(root, {
      platform: 'win32',
      readZone: zones({
        'Start Voidswarm Host.cmd': '[ZoneTransfer]\r\nZoneId=3\r\n',
        'runtime/node.exe': '[ZoneTransfer]\r\nZoneId=3\r\n',
        'web/index.html': '[ZoneTransfer]\r\nZoneId=1\r\n',
        'data/voidswarm.db': '[ZoneTransfer]\r\nZoneId=3\r\n',
      }),
    });
    expect(r.scanned).toBe(7);
    expect(r.files.map((f) => [f.rel.replace(/\\/g, '/'), f.kind, f.zoneId])).toEqual([
      ['Start Voidswarm Host.cmd', 'stub', 3],
      ['runtime/node.exe', 'program', 3],
    ]);
    expect(r.wholeFolder).toBe(false);
    expect(r.message).toMatch(/Unblock/);
    expect(r.message).toContain('Start Voidswarm Host.cmd');
  });

  it('says "the zip was not unblocked" when most of the folder is marked', () => {
    const all: Record<string, string> = {};
    for (const f of ['Start Voidswarm Host.cmd', 'START HERE.html', 'app/launch.mjs', 'app/server.mjs', 'runtime/node.exe', 'web/index.html', 'web/assets/a.js']) all[f] = '[ZoneTransfer]\r\nZoneId=3\r\n';
    const r = scanMotw(root, { platform: 'win32', readZone: zones(all) });
    expect(r.wholeFolder).toBe(true);
    expect(r.message).toMatch(/zip was not unblocked/);
    // data\ (accounts, chat log, backups, secrets) lives in this folder: never advise deleting it.
    expect(r.message).not.toMatch(/delet|remove|erase/i);
    expect(r.message).toMatch(/Replace the files/);
    expect(r.message).toMatch(/data\\ folder .* is kept/);
  });

  it('no advice ever says to delete anything', () => {
    const f = (rel: string) => ({ path: path.join(root, rel), rel, zoneId: 3, kind: 'stub' as const });
    for (const whole of [true, false]) {
      expect(motwMessage([f('Start Voidswarm Host.cmd'), f('app\\launch.mjs')], whole)).not.toMatch(/delet|remove|erase/i);
    }
  });

  it('is quiet when nothing is marked, and on other OSes', () => {
    expect(scanMotw(root, { platform: 'win32', readZone: () => null }).message).toBeNull();
    expect(scanMotw(root, { platform: 'linux', readZone: () => '[ZoneTransfer]\nZoneId=3\n' }).files).toEqual([]);
    expect(motwMessage([], false)).toBeNull();
  });

  it('stops at the file limit', () => {
    const r = scanMotw(root, { platform: 'win32', readZone: () => null, maxFiles: 3 });
    expect(r.truncated).toBe(true);
    expect(r.scanned).toBe(3);
  });
});

describe.skipIf(process.platform !== 'win32')('MOTW on real NTFS streams', () => {
  it('finds a real :Zone.Identifier stream and leaves it in place', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-motw-real-'));
    try {
      fs.mkdirSync(path.join(root, 'app'));
      const stub = path.join(root, 'Start Voidswarm Host.cmd');
      fs.writeFileSync(stub, '@echo off\r\n');
      fs.writeFileSync(path.join(root, 'app', 'launch.mjs'), '');
      fs.writeFileSync(zoneStreamPath(stub), '[ZoneTransfer]\r\nZoneId=3\r\n');
      const r = scanMotw(root);
      expect(r.files.map((f) => f.rel)).toEqual(['Start Voidswarm Host.cmd']);
      expect(fs.existsSync(zoneStreamPath(stub))).toBe(true); // never stripped
      expect(fs.readFileSync(stub, 'utf8')).toBe('@echo off\r\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
