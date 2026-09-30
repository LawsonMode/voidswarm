// LAN task B11: the .cmd stubs (docs/LAN-EDITION-proposal.md §2.1, §2.5; T-PKG-6). Each is run by the real cmd.exe
// from a folder whose name has spaces, parentheses, an apostrophe and an ampersand, with cwd elsewhere, and a fake
// app\ (a script that reports its arguments and stdin, and exits with a chosen code) beside a copy of this node.exe.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STUBS, TEMPLATES_DIR, fillTemplate } from '../../scripts/build-lan.mjs';
import { STUB_FILES } from './paths';

const scratch: string[] = [];
afterAll(() => { for (const d of scratch) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* held */ } } });

const readTemplate = (name: string): string => fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf8');
const VALUES = { VERSION: '9.9.9', NODE_VERSION: process.version, BUILD_DATE: '2026-09-29T00:00:00.000Z', BUILD_DAY: '2026-09-29', NOTICES: '' };

describe('the stub templates (§2.1)', () => {
  it('every stub the launcher knows is a template (the firewall one arrives with B14), and nothing else is', () => {
    expect(STUBS.map((s) => s.name)).toEqual([...STUB_FILES]);
    const cmds = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.toLowerCase().endsWith('.cmd')).sort();
    for (const s of STUBS) if (!s.later) expect(cmds).toContain(s.name);
    for (const c of cmds) expect(STUB_FILES as readonly string[]).toContain(c);
  });

  it('are 8 lines or fewer, plain ASCII, with no labels (so LF or CRLF both parse) and no version inside', () => {
    for (const s of STUBS.filter((x) => !x.later)) {
      const text = readTemplate(s.name);
      const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
      expect(lines.length, s.name).toBeLessThanOrEqual(8);
      expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text), s.name).toBe(true);
      expect(lines.some((l) => /^\s*:/.test(l)), s.name).toBe(false);
      expect(text).not.toMatch(/\{\{/);
      // Paths come from the stub's own location, never the working directory.
      expect(text, s.name).toMatch(/"%~dp0(app|runtime)\\/);
      expect(text, s.name).not.toMatch(/"(app|runtime|data|previous)[.a-z]*\\/);
    }
  });

  it('only the Start stub re-calls itself with stdin from NUL; the tool stubs read the console (§2.5)', () => {
    expect(readTemplate('Start Voidswarm Host.cmd')).toContain('call <nul "%~f0" --child %*');
    expect(readTemplate('Start Voidswarm Host.cmd')).toContain('start "Voidswarm LAN Host" /min');
    for (const n of ['Update Voidswarm.cmd', 'Reset admin password.cmd', 'Restore a backup.cmd']) {
      expect(readTemplate(n)).not.toMatch(/<\s*nul/i);
    }
    // The Update stub runs app\tool.mjs, or the root's update.recover.mjs while an interrupted update has app\ out.
    expect(readTemplate('Update Voidswarm.cmd')).toContain('set "VS_TOOL=%~dp0app\\tool.mjs"');
    expect(readTemplate('Update Voidswarm.cmd')).toContain('set "VS_TOOL=%~dp0update.recover.mjs"');
    expect(readTemplate('Update Voidswarm.cmd')).toContain('"%~dp0runtime\\node.exe" "%VS_TOOL%" update %*');
    expect(readTemplate('Reset admin password.cmd')).toContain('app\\tool.mjs" admin-reset %*');
    expect(readTemplate('Restore a backup.cmd')).toContain('app\\tool.mjs" restore %*');
  });
});

describe.runIf(process.platform === 'win32')('T-PKG-6: the stubs in a real cmd.exe', () => {
  let base = '';
  const FAKE = [
    "import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';",
    "let st = ''; try { st = fs.readFileSync(0, 'utf8'); } catch (e) { st = 'ERR ' + e.code; }",
    "console.log('ARGS ' + JSON.stringify(process.argv.slice(2)) + ' STDIN ' + JSON.stringify(st.slice(0, 20)));",
    "const self = fileURLToPath(import.meta.url); console.log('SELF ' + path.basename(self));",
    "const r = path.basename(self) === 'update.recover.mjs' ? path.dirname(self) : path.dirname(path.dirname(self));",
    "if (process.env.VS_MAKE_JOURNAL) fs.writeFileSync(path.join(r, 'update.journal.json'), '{}');",
    "if (process.env.VS_MAKE_NEXT) { fs.mkdirSync(path.join(r, 'runtime.next'), { recursive: true }); fs.copyFileSync(process.execPath, path.join(r, 'runtime.next', 'node.exe')); fs.writeFileSync(path.join(r, 'runtime.next', 'MARK'), 'new'); }",
    "if (process.env.VS_MARKER) fs.writeFileSync(process.env.VS_MARKER, JSON.stringify({ args: process.argv.slice(2), min: process.env.VOIDSWARM_STUB_MIN ?? null }));",
    "process.exit(Number(process.env.VS_RC || 0));",
  ].join('\n');

  const makeRoot = (name: string): string => {
    const root = path.join(base, name, "Room 136 (Mr. O'Brien) & Co", 'Voidswarm LAN');
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(root, 'previous'), { recursive: true });
    for (const s of STUBS.filter((x) => !x.later)) fs.writeFileSync(path.join(root, s.name), fillTemplate(readTemplate(s.name), VALUES).replace(/\r?\n/g, '\r\n'));
    try { fs.linkSync(process.execPath, path.join(root, 'runtime', 'node.exe')); } catch { fs.copyFileSync(process.execPath, path.join(root, 'runtime', 'node.exe')); }
    fs.writeFileSync(path.join(root, 'app', 'launch.mjs'), FAKE);
    fs.writeFileSync(path.join(root, 'app', 'tool.mjs'), FAKE);
    return root;
  };

  const run = (stubPath: string, args = '', env: Record<string, string> = {}, input = 'answer\r\n'): { code: number | null; out: string } => {
    const comspec = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
    const cwd = fs.existsSync('C:\\Windows\\Temp') ? 'C:\\Windows\\Temp' : os.tmpdir();
    const r = spawnSync(comspec, ['/d', '/s', '/c', `""${stubPath}"${args ? ` ${args}` : ''}"`], {
      cwd, env: { ...process.env, VS_RC: '', VS_MAKE_NEXT: '', VS_MAKE_JOURNAL: '', VS_MARKER: '', VOIDSWARM_STUB_MIN: '', ...env }, windowsVerbatimArguments: true, windowsHide: true,
      input, encoding: 'utf8', timeout: 60_000,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-stubs-'));
    scratch.push(base);
  });

  it('a stub copied out alone: "Unzip the WHOLE folder first", exit 1 (every stub)', () => {
    const lone = path.join(base, 'lone', 'Desktop & (copy)');
    fs.mkdirSync(lone, { recursive: true });
    for (const s of STUBS.filter((x) => !x.later)) {
      const f = path.join(lone, s.name);
      fs.writeFileSync(f, fillTemplate(readTemplate(s.name), VALUES).replace(/\r?\n/g, '\r\n'));
      const r = run(f, '', {}, '');
      expect(r.code, s.name).toBe(1);
      expect(r.out, s.name).toContain('Unzip the WHOLE folder first');
      expect(r.out).not.toContain('antivirus');
    }
  });

  it('app\\ present, runtime\\node.exe missing: the antivirus message, exit 1 (every stub)', () => {
    const root = makeRoot('noruntime');
    fs.rmSync(path.join(root, 'runtime', 'node.exe'));
    for (const s of STUBS.filter((x) => !x.later)) {
      const r = run(path.join(root, s.name), '', {}, '');
      expect(r.code, s.name).toBe(1);
      expect(r.out, s.name).toContain('Your antivirus may have removed runtime\\node.exe. Check Bitdefender > Protection > Quarantine, then add an exception (START HERE.html)');
      expect(r.out).not.toContain('Unzip the WHOLE');
    }
  });

  it('Start: runs app\\launch.mjs with --child and the flags, stdin at end-of-input, and passes the exit code through', () => {
    const root = makeRoot('start');
    const stub = path.join(root, 'Start Voidswarm Host.cmd');
    let r = run(stub, '--no-browser --data "x (y) & z"');
    expect(r.code).toBe(0);
    expect(r.out).toContain('ARGS ["--child","--no-browser","--data","x (y) & z"] STDIN ""');
    expect(r.out).not.toMatch(/press any key/i);
    r = run(stub, '--no-browser', { VS_RC: '3' });
    expect(r.code).toBe(3);
    expect(r.out).toContain('Voidswarm stopped with an error (code 3)');
    r = run(stub, '', { VS_RC: '1260' });
    expect(r.code).toBe(1260);
    expect(r.out).toContain('Windows blocked the Voidswarm engine (school policy). Give FOR SCHOOL IT.txt to IT.');
    // Once data\voidswarm.config.json exists it relaunches minimised; inside that window it runs as before and exits.
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data', 'voidswarm.config.json'), '{}');
    r = run(stub, '--no-browser', { VOIDSWARM_STUB_MIN: '1' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('ARGS ["--child","--no-browser"]');
  });

  it('Start with the config present and no VOIDSWARM_STUB_MIN: the minimised relaunch runs the launcher from an "&" folder and leaves no window', async () => {
    const root = makeRoot('relaunch');
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data', 'voidswarm.config.json'), '{}');
    const marker = path.join(base, 'relaunch-marker.json');
    const env = { ...process.env, VS_RC: '', VS_MAKE_NEXT: '', VS_MARKER: marker } as Record<string, string | undefined>;
    delete env.VOIDSWARM_STUB_MIN; // unset, not empty: the stub's own "if not defined" decides
    const comspec = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
    const stub = path.join(root, 'Start Voidswarm Host.cmd');
    const r = spawnSync(comspec, ['/d', '/s', '/c', `""${stub}" --no-browser"`], {
      cwd: os.tmpdir(), env, windowsVerbatimArguments: true, windowsHide: true, input: '', encoding: 'utf8', timeout: 30_000,
    });
    expect(r.status).toBe(0);
    const until = async (ok: () => boolean, ms: number): Promise<boolean> => {
      for (const end = Date.now() + ms; Date.now() < end; await new Promise((res) => setTimeout(res, 200))) if (ok()) return true;
      return ok();
    };
    expect(await until(() => fs.existsSync(marker), 20_000)).toBe(true);
    expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toEqual({ args: ['--child', '--no-browser'], min: '1' });
    // No cmd.exe (a /K window showing an error) is left for this folder.
    const left = (): string => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${base.replace(/'/g, "''")}') } | ForEach-Object { $_.Name + ' ' + $_.CommandLine }`],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).stdout.trim();
    let seen = '';
    expect(await until(() => (seen = left()) === '', 15_000), seen).toBe(true);
  }, 90_000);

  it('the tool stubs: the subcommand, the flags and the console (stdin) reach the tool; the exit code comes back', () => {
    const root = makeRoot('tools');
    for (const [stub, cmd] of [['Update Voidswarm.cmd', 'update'], ['Reset admin password.cmd', 'admin-reset'], ['Restore a backup.cmd', 'restore']] as const) {
      const r = run(path.join(root, stub), '--yes', { VS_RC: '2' });
      expect(r.code, stub).toBe(2);
      expect(r.out, stub).toContain(`ARGS ["${cmd}","--yes"] STDIN "answer\\r\\n"`);
    }
    const blocked = run(path.join(root, 'Update Voidswarm.cmd'), '', { VS_RC: '4551' });
    expect(blocked.code).toBe(4551);
    expect(blocked.out).toContain('Windows blocked the Voidswarm engine');
  });

  it('Update: a new runtime left in runtime.next\\ is switched in after node exits; the old one goes to previous\\runtime\\', () => {
    const root = makeRoot('swap');
    const oldSize = fs.statSync(path.join(root, 'runtime', 'node.exe')).size;
    const r = run(path.join(root, 'Update Voidswarm.cmd'), '', { VS_MAKE_NEXT: '1' });
    expect(r.out).toContain('The Node.js runtime was switched too.');
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(root, 'runtime', 'MARK'), 'utf8')).toBe('new');
    expect(fs.existsSync(path.join(root, 'runtime.next'))).toBe(false);
    expect(fs.statSync(path.join(root, 'previous', 'runtime', 'node.exe')).size).toBe(oldSize);
    expect(fs.existsSync(path.join(root, 'previous', 'runtime', 'MARK'))).toBe(false);
  }, 60_000);

  const JOURNAL_MSG = 'An update is running or was interrupted: wait for Update Voidswarm.cmd to finish, or run Update Voidswarm.cmd again to finish it.';
  const linkNode = (dir: string): void => {
    fs.mkdirSync(dir, { recursive: true });
    try { fs.linkSync(process.execPath, path.join(dir, 'node.exe')); } catch { fs.copyFileSync(process.execPath, path.join(dir, 'node.exe')); }
  };

  it('an update journal present: Start, Reset and Restore refuse (the update is running or must be finished); Update runs its tool', () => {
    const root = makeRoot('journal');
    fs.writeFileSync(path.join(root, 'update.journal.json'), '{}');
    for (const s of ['Start Voidswarm Host.cmd', 'Reset admin password.cmd', 'Restore a backup.cmd']) {
      const r = run(path.join(root, s), '--yes', {}, '');
      expect(r.code, s).toBe(1);
      expect(r.out, s).toContain(JOURNAL_MSG);
      expect(r.out, s).not.toContain('ARGS');
      expect(r.out, s).not.toContain('Unzip the WHOLE');
    }
    const u = run(path.join(root, 'Update Voidswarm.cmd'), '--yes');
    expect(u.out).toContain('ARGS ["update","--yes"]');
    expect(u.out).toContain('SELF tool.mjs');
  });

  it('Update with app\\ out (an interrupted update) runs the root\'s update.recover.mjs; only with a journal, and only when the copy is there', () => {
    const root = makeRoot('recover');
    fs.rmSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'update.recover.mjs'), FAKE);
    const stub = path.join(root, 'Update Voidswarm.cmd');
    // No journal: the copy is a leftover, and the folder really is incomplete.
    let r = run(stub, '', {}, '');
    expect(r.code).toBe(1);
    expect(r.out).toContain('Unzip the WHOLE folder first');
    fs.writeFileSync(path.join(root, 'update.journal.json'), '{}');
    r = run(stub, '--yes', { VS_RC: '0' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('ARGS ["update","--yes"] STDIN "answer\\r\\n"');
    expect(r.out).toContain('SELF update.recover.mjs');
    r = run(stub, '', { VS_RC: '1' });
    expect(r.code).toBe(1);
    // A journal but no copy: nothing to run.
    fs.rmSync(path.join(root, 'update.recover.mjs'));
    r = run(stub, '', {}, '');
    expect(r.code).toBe(1);
    expect(r.out).toContain('Unzip the WHOLE folder first');
  });

  it('a runtime switch cut short (runtime\\ gone, runtime.next\\node.exe there, no journal) is finished before the node.exe check: Update and Start', () => {
    for (const s of ['Update Voidswarm.cmd', 'Start Voidswarm Host.cmd']) {
      const root = makeRoot(`halfswitch-${s.split(' ')[0]}`);
      fs.renameSync(path.join(root, 'runtime'), path.join(root, 'previous', 'runtime')); // the stub's first move ran
      linkNode(path.join(root, 'runtime.next'));
      fs.writeFileSync(path.join(root, 'runtime.next', 'MARK'), 'new');
      const r = run(path.join(root, s), '--no-browser');
      expect(r.out, s).not.toContain('antivirus');
      expect(r.out, s).toContain('ARGS [');
      expect(fs.readFileSync(path.join(root, 'runtime', 'MARK'), 'utf8'), s).toBe('new');
      expect(fs.existsSync(path.join(root, 'runtime.next')), s).toBe(false);
      expect(fs.existsSync(path.join(root, 'previous', 'runtime', 'node.exe')), s).toBe(true);
    }
  }, 60_000);

  it('Update never switches the runtime while a journal is left (the undo may still need runtime.next\\)', () => {
    const root = makeRoot('journal-next');
    const r = run(path.join(root, 'Update Voidswarm.cmd'), '', { VS_MAKE_NEXT: '1', VS_MAKE_JOURNAL: '1', VS_RC: '1' });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('runtime was switched');
    expect(r.out).not.toContain('could not be switched');
    expect(fs.readFileSync(path.join(root, 'runtime.next', 'MARK'), 'utf8')).toBe('new');
    expect(fs.existsSync(path.join(root, 'runtime', 'MARK'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'previous', 'runtime'))).toBe(false);
  }, 60_000);

  it('Update: when the runtime can\'t be switched (a process holds runtime\\), it says so, keeps runtime\\ working and exits 1', async () => {
    const root = makeRoot('held');
    // Another process with its working folder in runtime\ (as a Voidswarm window still open would hold it).
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { cwd: path.join(root, 'runtime'), stdio: 'ignore', windowsHide: true });
    try {
      await new Promise((res) => setTimeout(res, 300));
      const r = run(path.join(root, 'Update Voidswarm.cmd'), '', { VS_MAKE_NEXT: '1' });
      expect(r.code).toBe(1);
      expect(r.out).toContain('The Node.js runtime could not be switched yet');
      expect(fs.statSync(path.join(root, 'runtime', 'node.exe')).isFile()).toBe(true);
      expect(fs.existsSync(path.join(root, 'runtime.next', 'node.exe'))).toBe(true);
    } finally {
      holder.kill();
    }
  }, 90_000);
});

