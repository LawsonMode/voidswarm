import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  HostConsole, LOG_RETAIN_DAYS, Redactor, createHostLog, installChildLogging, logFileName, logStamp, pruneLogs, redactLogLine,
  type ConsoleOut,
} from './console';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-b4b-console-'));
afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
let n = 0;
const tmpDir = (): string => { const d = path.join(tmpRoot, `t${n++}`); fs.mkdirSync(d, { recursive: true }); return d; };

const NAME = 'Zorblax';
const ROOM = 'Secret Base 7';

describe('log redaction (§5.1: no chat text, names, room names, wellbeing lines, tokens, codes or links)', () => {
  const r = (line: string, red = new Redactor({ homeDir: 'C:\\Users\\capta' })) => red.redact(line);

  it('players appear as #<playerId>', () => {
    expect(r(`+ ${NAME} (#12, guest) — 4 online`)).toBe('+ #12, guest — 4 online');
    expect(r(`+ ${NAME} (#3, account) — 1 online`)).toBe('+ #3, account — 1 online');
    expect(r(`- ${NAME} (#12) — 3 online`)).toBe('- #12 — 3 online');
    expect(r(`profile save failed for ${NAME} (#12): disk I/O error`)).toBe('profile save failed for #12: disk I/O error');
    expect(r(`profile attach failed for ${NAME} (#9): nope`)).toBe('profile attach failed for #9: nope');
  });

  it('rooms appear as r<id>: the name is learnt from "room open" and forgotten on "room closed"', () => {
    const red = new Redactor({ homeDir: '' });
    expect(red.redact(`room open: ${ROOM} (r7, arena/deathmatch, ffa, bots 4)`)).toBe('room open: r7 (arena/deathmatch, ffa, bots 4)');
    expect(red.redact(`[${ROOM}] + ${NAME} (3 humans)`)).toBe('[r7] + a pilot (3 humans)');
    expect(red.redact(`[${ROOM}] - ${NAME} (2 humans)`)).toBe('[r7] - a pilot (2 humans)');
    expect(red.redact(`[${ROOM}] match start seed=1234 players=6`)).toBe('[r7] match start seed=1234 players=6');
    expect(red.redact(`quick play overflow: ${ROOM}`)).toBe('quick play overflow: r7');
    expect(red.redact(`announcement to ${ROOM} (3 pilots)`)).toBe('announcement to r7 (3 pilots)');
    expect(red.redact('announcement to all rooms (12 pilots)')).toBe('announcement to all rooms (12 pilots)');
    expect(red.redact(`room closed: ${ROOM}`)).toBe('room closed: r7');
    expect(red.roomCount).toBe(0);
    expect(red.redact(`[${ROOM}] tick error: boom`)).toBe('[a room] tick error: boom');
    // A name that itself looks like "(r1, …)": the last id wins.
    expect(red.redact('room open: Fun (r1, x) (r3, arena/ctf, teams 2, bots 10, house)')).toBe('room open: r3 (arena/ctf, teams 2, bots 10, house)');
    expect(red.redact('room closed: Fun (r1, x)')).toBe('room closed: r3');
  });

  it('accounts, moderators and reports lose their names and free text', () => {
    expect(r(`[auth] registered ${NAME}`)).toBe('[auth] registered an account');
    expect(r(`[auth] password reset for ${NAME} (all other sessions revoked)`)).toBe('[auth] password reset for an account (all other sessions revoked)');
    expect(r(`[auth] reset issued for ${NAME}`)).toBe('[auth] reset issued for an account');
    expect(r(`[auth] upgraded password hash for ${NAME}`)).toBe('[auth] upgraded password hash for an account');
    expect(r(`[auth] password rehash for ${NAME} failed: busy`)).toBe('[auth] password rehash for an account failed: busy');
    expect(r('[auth] reset mail to z***@caldwellschools.org failed: EAUTH 535 bad login')).toBe('[auth] reset mail to an account failed: EAUTH 535 bad login');
    expect(r('[auth] SMTP mail enabled via smtp.caldwellschools.org:587 as novapilot@caldwellschools.org')).toBe('[auth] SMTP mail enabled via smtp.caldwellschools.org:587');
    expect(r(`[mod] report #4: ${NAME} → Quxx (${ROOM}): he said something awful`)).toBe('[mod] report #4 filed');
    expect(r(`[mod] refused sign-in of ${NAME} (ban #2)`)).toBe('[mod] refused a sign-in (ban #2)');
    expect(r(`[mod] auto-mute of ${NAME} failed: SQLITE_BUSY`)).toBe('[mod] auto-mute of a pilot failed: SQLITE_BUSY');
    expect(r(`[mod] threat from ${NAME} (#5, line withheld) — see the chat log`)).toBe('[mod] threat flagged (#5, line withheld) — see the chat log');
    expect(r(`[mod] admin API refused for ${NAME} (not a moderator)`)).toBe('[mod] admin API refused for an account (not a moderator)');
    expect(r(`[mod] host: kick ${NAME} — being rude to Quxx`)).toBe('[mod] a moderator: kick a pilot');
    expect(r(`[mod] NovaPilot: ban ${NAME} [account] 1 day — slurs in chat (1 disconnected)`)).toBe('[mod] a moderator: ban a pilot [account] 1 day (1 disconnected)');
    expect(r('[mod] NovaPilot: lifted #3, #4')).toBe('[mod] a moderator: lifted #3, #4');
    expect(r('[mod] ready — 1 moderator(s), 0 active ban(s)/mute(s), chat log kept 90 days')).toBe('[mod] ready — 1 moderator(s), 0 active ban(s)/mute(s), chat log kept 90 days');
  });

  it('drops wellbeing lines and reset links entirely', () => {
    expect(r(`[mod] possible self-harm statement from ${NAME} (#3) — see the chat log`)).toBeNull();
    expect(r(`[mod] possible self-harm statement from ${NAME} (#3, line withheld) — see the chat log`)).toBeNull();
    expect(r('[wellbeing] alert #4 acknowledged')).toBeNull();
    expect(r(`[auth] DEV reset link for ${NAME}: http://localhost:7777/#reset=abc`)).toBeNull();
    expect(r('   ')).toBeNull();
  });

  it('scrubs links, emails, tokens and codes from any line, and keeps ip:port', () => {
    expect(r('ws connect 192.168.1.20:51234')).toBe('ws connect 192.168.1.20:51234');
    expect(r('ws refused 10.0.0.3:5000 (10.0.0.3): banned (#4)')).toBe('ws refused 10.0.0.3:5000 (10.0.0.3): banned (#4)');
    expect(r('opened http://localhost:7778/#setup=K7QP-4MXD')).toBe('opened <link>');
    expect(r('setup code K7QP-4MXD printed')).toBe('setup code <code> printed');
    expect(r('verification code 482913 sent')).toBe('verification code <code> sent');
    expect(r('exit code 2 (port busy)')).toBe('exit code 2 (port busy)');
    expect(r('mail to novapilot@caldwellschools.org bounced')).toBe('mail to <email> bounced');
    expect(r('Authorization: Bearer abc.def.ghi')).toBe('Authorization: <redacted> <token>');
    expect(r('token=abcdef123 password: hunter22 secret="x y"')).toBe('token=<redacted> password: <redacted> secret=<redacted>');
    expect(r(`session ${'a1'.repeat(32)} revoked`)).toBe('session <hex> revoked');
    expect(r('token blob QmFzZTY0VG9rZW5WYWx1ZUhlcmUxMjM0NTY3ODkwYWJj end')).toBe('token blob <token> end');
    // A path is not a token, and the account's home folder becomes %USERPROFILE%.
    expect(r('[settings] created C:\\Users\\capta\\Voidswarm LAN\\data\\voidswarm.config.json (home preset)'))
      .toBe('[settings] created %USERPROFILE%\\Voidswarm LAN\\data\\voidswarm.config.json (home preset)');
    expect(r('C:\\Users\\capta\\AppData\\Local\\Temp\\claude\\6e47f0ba-d188-4914-86f4-40e232052f68\\x')).toBe('%USERPROFILE%\\AppData\\Local\\Temp\\claude\\6e47f0ba-d188-4914-86f4-40e232052f68\\x');
    expect(r('C:\\Users\\captain\\x')).toBe('C:\\Users\\captain\\x');
  });

  it('prefixed and JSON secrets, and a setup code written as one word next to "code", are scrubbed too', () => {
    expect(r('SMTP_PASS=hunter2hunter2')).toBe('SMTP_PASS=<redacted>');
    expect(r('MAIL_SMTP_PASSWORD: "abc def" set')).toBe('MAIL_SMTP_PASSWORD: <redacted> set');
    expect(r('pass: hunter2')).toBe('pass: <redacted>');
    expect(r('{"password":"hunter2","user":"x"}')).toBe('{"password":<redacted>,"user":"x"}');
    // Node's JSON.parse errors quote their input: a request body in a logged stack.
    expect(r('SyntaxError: Unexpected token in JSON at position 9: {"smtpPass": "hunter2", "apiKey":"k-123", "key": 42}'))
      .toBe('SyntaxError: Unexpected token in JSON at position 9: {"smtpPass": <redacted>, "apiKey":<redacted>, "key": <redacted>}');
    expect(r('setup code K7QP4MXD')).toBe('setup code <code>');
    expect(r('Zorblax code=K7QP4MXD')).toBe('Zorblax code=<code>');
    expect(r('the new code is K7QP4MXD.')).toBe('the new code is <code>.');
    // Ordinary words stay readable.
    expect(r('bypass=1 tokens: 5 secrets: 3 passes: 2')).toBe('bypass=1 tokens: 5 secrets: 3 passes: 2');
    expect(r('code database ready; exit code 2')).toBe('code database ready; exit code 2');
  });

  it('stays linear on long unbroken runs (it runs on the game thread once the child logs through it)', () => {
    const red = new Redactor({ homeDir: '' });
    const L = 8 * 1024;
    const shapes: Record<string, string> = {
      alnum: 'a'.repeat(L), alnumThenDot: `${'a'.repeat(L - 1)}.`, underscores: 'a_'.repeat(L / 2), atRuns: 'a@'.repeat(L / 2),
      domainDots: `x@${'b.'.repeat(L / 2 - 2)}b`, spacesAfterCode: `code${' '.repeat(L - 10)}x`, brackets: `[${'] '.repeat(L / 2)}`,
      quotes: '"'.repeat(L), jsonKeys: '"aaaaaaaa":'.repeat(Math.floor(L / 11)), roomOpen: `room open: ${' (r1, '.repeat(Math.floor(L / 6))}`,
      frameName: `x\n    at ${'a.'.repeat(L / 2 - 8)}`, frameParens: `x\n    at a (file:///${'('.repeat(L - 24)}`,
      frameBrackets: `x\n    at ${'[as '.repeat(Math.floor(L / 4) - 4)}`,
    };
    for (const [name, line] of Object.entries(shapes)) {
      red.redact(line); // warm up
      const t0 = performance.now();
      for (let i = 0; i < 10; i++) red.redact(line);
      // Measured ~0.1 ms a line (the quadratic email scan took ~17 ms on an 8 KB run, longer than a 16.7 ms tick).
      expect((performance.now() - t0) / 10, name).toBeLessThan(4);
    }
  });

  it('keeps stack traces (multi-line), scrubbed', () => {
    const out = r('[r1] tick error: Error: boom\n    at step (file:///C:/Users/capta/app/server.mjs:10:5)')!;
    expect(out.split('\n')).toHaveLength(2);
    expect(out).toContain('file:///C:/Users/capta'.replace('C:/Users/capta', '%USERPROFILE%'));
  });

  it('a crash whose stack passes through a wellbeing function (isSelfHarmRow, selfHarmCallsign) is still logged', () => {
    const fatal = 'FATAL (uncaughtException): TypeError: Cannot read properties of undefined (reading \'id\')\n'
      + '    at isSelfHarmRow (file:///C:/VS/app/server.mjs:4242:9)\n'
      + '    at async Object.selfHarmCallsign [as notify] (file:///C:/VS/app/server.mjs:4300:3)\n'
      + '    at new SelfHarmQueue (node:internal/x:1:1)\n'
      + '    at file:///C:/VS/app/server.mjs:10:1\n'
      + '    at C:\\VS\\app\\server.cjs:5:2';
    const out = r(fatal);
    expect(out).not.toBeNull();
    expect(out!.split('\n')).toHaveLength(6);
    expect(out).toContain('at isSelfHarmRow (file:///C:/VS/app/server.mjs:4242:9)');
    expect(r('[r2] handler error: RangeError: bad\n    at selfHarmCallsign (file:///C:/VS/app/server.mjs:88:1)')).toContain('handler error');
    // Only Node's own frame shape is exempt: a wellbeing word anywhere else in the entry still withholds it all.
    expect(r(`FATAL: boom\n    at self-harm statement from ${NAME}`)).toBeNull();
    expect(r(`[mod] alert\npossible self-harm statement from ${NAME} (#3)`)).toBeNull();
    expect(r(`FATAL: possible self-harm statement from ${NAME}\n    at isSelfHarmRow (file:///C:/VS/app/server.mjs:1:1)`)).toBeNull();
  });

  it('no canary name or room name survives any known line shape', () => {
    const red = new Redactor({ homeDir: '' });
    const lines = [
      `room open: ${ROOM} (r2, dungeon/coop, teams 1, bots 4, house)`,
      `+ ${NAME} (#1, guest) — 1 online`, `- ${NAME} (#1) — 0 online`,
      `[${ROOM}] + ${NAME} (1 humans)`, `[${ROOM}] - ${NAME} (0 humans)`, `[${ROOM}] settings reset to defaults (room empty)`,
      `quick play overflow: ${ROOM}`, `announcement to ${ROOM} (1 pilot)`,
      `[auth] registered ${NAME}`, `[auth] reset issued for ${NAME}`, `[auth] password reset for ${NAME} (all other sessions revoked)`,
      `[mod] report #1: ${NAME} → ${NAME}2 (${ROOM}): ${NAME} was rude`, `[mod] ${NAME}: kick ${NAME}2 — ${NAME} asked`,
      `[mod] ${NAME}: mute ${NAME}2 [account] 10 min — spam`, `[mod] threat from ${NAME} (#1, line withheld) — see the chat log`,
      `[mod] refused sign-in of ${NAME} (ban #1)`, `[mod] auto-mute of ${NAME} failed: x`, `profile save failed for ${NAME} (#1): x`,
      `room closed: ${ROOM}`,
    ];
    for (const l of lines) {
      const out = red.redact(l) ?? '';
      expect(out, l).not.toContain(NAME);
      expect(out, l).not.toContain(ROOM);
    }
  });

  it('a room named like a tag ("Zone", "auth", "mod] x", …) never lets a pilot\'s or the room\'s name through', () => {
    const red = new Redactor({ homeDir: '' });
    const tagLike = ['Zone', 'zone', 'Server', 'server', 'auth', 'Mod', 'mod', 'Room', 'Admin', 'LAN', 'Setup', 'Net', 'settings', 'profile', 'mod] x', 'auth] x', 'Zone] + Q (1 humans)'];
    tagLike.forEach((name, i) => {
      const id = `r${i + 40}`;
      expect(red.redact(`room open: ${name} (${id}, arena/deathmatch, ffa, bots 4)`)).toBe(`room open: ${id} (arena/deathmatch, ffa, bots 4)`);
      expect(red.redact(`[${name}] + ${NAME} (3 humans)`), name).toBe(`[${id}] + a pilot (3 humans)`);
      expect(red.redact(`[${name}] - ${NAME} (2 humans)`), name).toBe(`[${id}] - a pilot (2 humans)`);
      expect(red.redact(`[${name}] match start seed=1234 players=6`), name).toBe(`[${id}] match start seed=1234 players=6`);
      expect(red.redact(`[${name}] tick error: Error: boom`), name).toBe(`[${id}] tick error: Error: boom`);
    });
    // The server's own tagged lines keep their rewriting while those rooms are open.
    expect(red.redact(`[auth] registered ${NAME}`)).toBe('[auth] registered an account');
    expect(red.redact(`[mod] refused sign-in of ${NAME} (ban #2)`)).toBe('[mod] refused a sign-in (ban #2)');
    expect(red.redact('[settings] saved (rev 4)')).toBe('[settings] saved (rev 4)');
    expect(red.redact('[profile] save failed for 9f2c: SQLITE_BUSY')).toBe('[profile] save failed for 9f2c: SQLITE_BUSY');
    // A room this log never saw open (or renamed since): "a room", whatever it is called.
    const fresh = new Redactor({ homeDir: '' });
    for (const name of ['Zone', 'Server', 'auth', 'mod', 'mod] x', 'auth] x', ROOM]) {
      for (const line of [`[${name}] + ${NAME} (3 humans)`, `[${name}] - ${NAME} (1 human)`, `[${name}] match end winnerTeam=1 winner=4`,
        `[${name}] settings reset to defaults (room empty)`, `[${name}] leave grant m1#guest:4#0: 2 secured`]) {
        const out = fresh.redact(line)!;
        expect(out, line).toMatch(/^\[a room\] /);
        expect(out, line).not.toContain(NAME);
        if (name.length > 4) expect(out, line).not.toContain(name);
      }
    }
    // A new body shape in an unknown room still hides the (non-tag) room name.
    expect(fresh.redact(`[${ROOM}] something new`)).toBe('[a room] something new');
    expect(fresh.redact(`[Zone] something new`)).toBe('[a room] something new');
  });

  it('control characters never reach the log file', () => {
    expect(r('ws connect 10.0.0.3:5000 \u001b[2J\u0007ok')).toBe('ws connect 10.0.0.3:5000 [2Jok');
    expect(r('two\n\tlines')).toBe('two\n\tlines');
  });

  it('redactLogLine is the one-shot form', () => {
    expect(redactLogLine(`- ${NAME} (#2) — 0 online`, { homeDir: '' })).toBe('- #2 — 0 online');
  });
});

describe('the host log file (host-YYYY-MM-DD.log, daily, 14 days)', () => {
  it('names the file by the local date and stamps lines with the local time', () => {
    const d = new Date(2026, 8, 3, 7, 5, 9, 42);
    expect(logFileName(d)).toBe('host-2026-09-03.log');
    expect(logStamp(d)).toBe('07:05:09.042');
  });

  it('writes asynchronously (write returns before the disk), redacted and tagged', async () => {
    const dir = path.join(tmpDir(), 'logs');
    let t = new Date(2026, 8, 28, 10, 0, 0).getTime();
    const log = createHostLog({ dir, tag: 'launcher', now: () => t, redactor: new Redactor({ homeDir: '' }) });
    log.write(`+ ${NAME} (#4, guest) — 1 online`);
    log.write('two\nlines');
    log.write(`[mod] possible self-harm statement from ${NAME} (#4) — see the chat log`);
    expect(fs.existsSync(path.join(dir, 'host-2026-09-28.log'))).toBe(false); // nothing synchronous
    await log.flush();
    const text = fs.readFileSync(path.join(dir, 'host-2026-09-28.log'), 'utf8');
    expect(text).toBe('10:00:00.000 [launcher] + #4, guest — 1 online\n10:00:00.000 [launcher] two\n    lines\n');
    expect(log.withheld).toBe(1);
    // Rotation at the local date change.
    t = new Date(2026, 8, 29, 0, 0, 1).getTime();
    log.write('after midnight');
    await log.close();
    expect(fs.readFileSync(path.join(dir, 'host-2026-09-29.log'), 'utf8')).toBe('00:00:01.000 [launcher] after midnight\n');
    expect(log.file).toBe(path.join(dir, 'host-2026-09-29.log'));
    log.write('after close'); // ignored, never throws
  });

  it('keeps 14 days: older host-*.log files go, other files stay', () => {
    const dir = tmpDir();
    const now = new Date(2026, 8, 28, 12, 0, 0);
    for (let back = 0; back <= 20; back++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
      fs.writeFileSync(path.join(dir, logFileName(d)), 'x');
    }
    fs.writeFileSync(path.join(dir, 'host-notes.txt'), 'keep');
    fs.writeFileSync(path.join(dir, 'other-2020-01-01.log'), 'keep');
    const deleted = pruneLogs(dir, now, LOG_RETAIN_DAYS);
    expect(deleted).toHaveLength(20 - LOG_RETAIN_DAYS);
    const left = fs.readdirSync(dir).filter((f) => f.startsWith('host-2026'));
    expect(left).toHaveLength(LOG_RETAIN_DAYS + 1);
    expect(fs.existsSync(path.join(dir, 'host-notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'other-2020-01-01.log'))).toBe(true);
    // createHostLog prunes when it opens.
    fs.writeFileSync(path.join(dir, 'host-2000-01-01.log'), 'old');
    createHostLog({ dir, now: () => now.getTime() });
    expect(fs.existsSync(path.join(dir, 'host-2000-01-01.log'))).toBe(false);
  });

  it('a stalled disk costs memory only up to the cap; the loss is reported in the log', async () => {
    const dir = path.join(tmpDir(), 'logs');
    const log = createHostLog({ dir, redact: false, maxPendingBytes: 200, now: () => new Date(2026, 0, 1).getTime() });
    for (let i = 0; i < 50; i++) log.write(`line ${i} ${'x'.repeat(20)}`);
    expect(log.lost).toBeGreaterThan(0);
    await log.close();
    const text = fs.readFileSync(path.join(dir, 'host-2026-01-01.log'), 'utf8');
    expect(text).toContain('were lost');
    expect(text).toContain('line 49');
  });

  it('flushSync writes whatever is queued (process exit)', () => {
    const dir = path.join(tmpDir(), 'logs');
    const log = createHostLog({ dir, redact: false, now: () => new Date(2026, 0, 2).getTime() });
    log.write('queued');
    log.flushSync();
    expect(fs.readFileSync(path.join(dir, 'host-2026-01-02.log'), 'utf8')).toContain('queued');
  });
});

describe('the quiet console', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('installChildLogging routes console.* into the host log and nothing to stdout', async () => {
    const dataDir = tmpDir();
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    const cl = installChildLogging({ dataDir, homeDir: '' });
    try {
      console.log(`+ ${NAME} (#8, guest) — 2 online`);
      console.error('boom %d', 42);
      console.warn('careful');
    } finally {
      cl.uninstall();
    }
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    await cl.log.flush();
    const text = fs.readFileSync(cl.log.file, 'utf8');
    expect(text).toContain('+ #8, guest — 2 online');
    expect(text).toContain('boom 42');
    expect(text).toContain('careful');
    expect(text).not.toContain(NAME);
    expect(path.dirname(cl.log.file)).toBe(path.join(dataDir, 'logs'));
  });

  it('HostConsole: notices are one line with HH:MM and go to the log; print does not; the title is set once per change', async () => {
    const written: string[] = [];
    const titles: string[] = [];
    const out: ConsoleOut = { write: (s) => { written.push(s); }, setTitle: (t) => { titles.push(t); } };
    const dir = path.join(tmpDir(), 'logs');
    const log = createHostLog({ dir, tag: 'launcher', redactor: new Redactor({ homeDir: '' }), now: () => new Date(2026, 8, 28, 10, 14).getTime() });
    const c = new HostConsole({ out, log, now: () => new Date(2026, 8, 28, 10, 14).getTime() });
    c.print('BANNER with setup code K7QP-4MXD');
    c.notice('The server restarted after an error at 10:14.\n(second line)');
    c.fatal('Port 7777 is in use.');
    c.title('A');
    c.title('A');
    c.title('B');
    expect(written[0]).toBe('BANNER with setup code K7QP-4MXD\n');
    expect(written[1]).toBe('10:14 The server restarted after an error at 10:14. (second line)\n');
    expect(written[2]).toContain('Port 7777 is in use.');
    expect(titles).toEqual(['A', 'B']);
    await log.close();
    const text = fs.readFileSync(path.join(dir, 'host-2026-09-28.log'), 'utf8');
    expect(text).not.toContain('BANNER');
    expect(text).toContain('The server restarted after an error');
    expect(text).toContain('FATAL: Port 7777 is in use.');
  });

  it('HostConsole: escape sequences and other control characters from the child never reach the console window', () => {
    const written: string[] = [];
    const c = new HostConsole({ out: { write: (s) => { written.push(s); } }, now: () => new Date(2026, 8, 28, 20, 57).getTime() });
    c.notice('\u001b[2J\u001b[H FAKE: Players join at: http://10.9.9.9:80 \u0007‮');
    c.fatal('Port busy\u001b]0;evil title\u0007\nsecond line\r\n\tthird');
    c.print('banner \u009b31m red');
    expect(written[0]).toBe('20:57 [2J[H FAKE: Players join at: http://10.9.9.9:80\n');
    expect(written[1]).toBe('\nPort busy]0;evil title\nsecond line\n third\n');
    expect(written[2]).toBe('banner 31m red\n');
    for (const w of written) expect(w).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮]/);
  });
});

// T-LAN-10 is a manual release gate (a real QuickEdit selection in conhost). This is its mechanism, automated: the
// parent stops reading its child's pipes for 2.5 s, as it does while a QuickEdit selection holds its console write.
describe('T-LAN-10 (automated part): a stalled launcher never stalls the server child', () => {
  const probeSrc = (consolePath: string) => `
    import { installChildLogging } from ${JSON.stringify(consolePath)};
    const [dataDir, mode] = process.argv.slice(2);
    if (mode === 'quiet') installChildLogging({ dataDir, homeDir: '' });
    let worst = 0, last = Date.now(), ticks = 0;
    const line = 'ws connect 192.168.1.20:51234 ' + 'x'.repeat(900);
    const t = setInterval(() => {
      const now = Date.now(); worst = Math.max(worst, now - last); last = now; ticks++;
      for (let i = 0; i < 20; i++) console.log(line);
    }, 10);
    setTimeout(() => { clearInterval(t); process.send({ worst, ticks }); setTimeout(() => process.exit(0), 300); }, 3000);
  `;

  const run = async (probe: string, dataDir: string, mode: string): Promise<{ worst: number; ticks: number; stdoutBytes: number }> => {
    const child = fork(probe, [dataDir, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let stdoutBytes = 0;
    child.stdout!.on('data', (d: Buffer) => { stdoutBytes += d.length; });
    child.stderr!.on('data', () => undefined);
    // The parent's console write is held: nothing is read from the pipes for 2.5 s.
    setTimeout(() => { const end = Date.now() + 2500; while (Date.now() < end) { /* held */ } }, 150);
    const msg = await new Promise<{ worst: number; ticks: number }>((res, rej) => {
      child.once('message', (m) => res(m as { worst: number; ticks: number }));
      child.once('exit', (c) => rej(new Error(`probe exited ${c}`)));
    });
    await new Promise((r) => child.once('exit', r));
    return { ...msg, stdoutBytes };
  };

  it('with the quiet console the child keeps its pace and writes nothing to the pipe', async () => {
    const dir = tmpDir();
    const probe = path.join(dir, 'probe.mjs');
    const { build } = await import('esbuild');
    await build({
      stdin: { contents: probeSrc(path.join(repoRoot, 'src', 'lan', 'console.ts')), resolveDir: repoRoot, loader: 'ts', sourcefile: 'probe.ts' },
      outfile: probe, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
    });
    const quiet = await run(probe, dir, 'quiet');
    expect(quiet.stdoutBytes).toBe(0);
    expect(quiet.worst).toBeLessThan(1000);
    expect(fs.readdirSync(path.join(dir, 'logs')).some((f) => /^host-\d{4}-\d{2}-\d{2}\.log$/.test(f))).toBe(true);
    if (process.platform === 'win32') {
      // Why it matters (measured): the same child writing to its stdout pipe stalls for as long as the parent does.
      const raw = await run(probe, dir, 'raw');
      expect(raw.stdoutBytes).toBeGreaterThan(0);
      expect(raw.worst).toBeGreaterThan(1500);
    }
  }, 30_000);
});
