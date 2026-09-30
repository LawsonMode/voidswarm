// The host admin credential, first-run setup and admin sessions (docs/LAN-EDITION-proposal.md §4.10): T-ADM-1, T-ADM-2,
// T-ADM-16 and T-ADM-17 at the service level (the HTTP and listener level is in adminListener.test.ts).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireLock, sendCommand } from '../../lan/pipe';
import { AuthStore } from '../auth/store';
import {
  ADMIN_ERR, DEFAULT_ADMIN_POLICY, HOST_ACTOR_ID, HOST_NAMES_SINCE_SQL, HostAdmin, LIVE_KEEPALIVE_MAX_MS, MAX_SESSIONS_PER_PRINCIPAL, REFUSAL_AUDIT_COALESCE_MS, SESSION_ABSOLUTE_MS, SETUP_DOMAINS_SCHOOL_ONLY, formatSetupCode, hashAdminPassword,
  hostAdminState, newSetupCode, normalizeSetupCode, resetHostAdmin, resetHostAdminAt, setHostAdminCredential, setupCodeHash, setupLockMs,
  type AdminCaller, type AdminPolicy, type AdminSession,
} from './hostAdmin';
import { adminIpcHooks, adminReadyFields, handleAdminIpcMessage } from './http';

const MIN = 60_000;
/** Test only: cheap scrypt (the stored hash says which parameters verify it). */
const FAST = { N: 1 << 10, r: 8, p: 1, keylen: 32 } as const;
const PASS = 'Correct-Horse-7Battery'; // generated test password (never a real one)
const HOST_PC: AdminCaller = { address: 'loopback', via: 'local', hostPc: true, secure: false, trustedTls: false };
const lan = (ip: string, trustedTls = false): AdminCaller => ({ address: ip, via: 'https', hostPc: false, secure: true, trustedTls });

const dirs: string[] = [];
const open: HostAdmin[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.close();
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows may hold the WAL briefly */ } }
});

function setup(policyOver: Partial<AdminPolicy> = {}, opts: { pepper?: Buffer | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'voidswarm-hostadmin-'));
  dirs.push(dir);
  const dbPath = join(dir, 'voidswarm.db');
  new AuthStore(dbPath).close();
  const clock = { t: 1_900_000_000_000 };
  const policy: AdminPolicy = { ...DEFAULT_ADMIN_POLICY, ...policyOver };
  const codes: string[] = [];
  const states: unknown[] = [];
  const pepper = opts.pepper === undefined ? randomBytes(32) : opts.pepper;
  const ha = new HostAdmin({
    dbPath, now: () => clock.t, policy: () => policy, passwordParams: FAST, pepper,
    onSetupCode: (c) => codes.push(c), onStateChange: (s) => states.push(s),
  });
  open.push(ha);
  const sql = <T = Record<string, unknown>>(q: string, ...args: (string | number | null)[]): T[] => {
    const db = new DatabaseSync(dbPath);
    try { return db.prepare(q).all(...args) as T[]; } finally { db.close(); }
  };
  const run = (q: string, ...args: (string | number | null)[]): void => {
    const db = new DatabaseSync(dbPath);
    try { db.prepare(q).run(...args); } finally { db.close(); }
  };
  return { dir, dbPath, clock, policy, codes, states, ha, sql, run, pepper };
}

async function firstRun(env: ReturnType<typeof setup>, over: Record<string, unknown> = {}) {
  const code = newSetupCode();
  env.ha.installLaunchCode(code);
  const r = await env.ha.setup({ setupCode: formatSetupCode(code), username: 'NovaPilot', password: PASS, preset: 'school', serverName: 'Room 136', accountsMode: 'roster', ...over }, HOST_PC);
  if (!r.ok) throw new Error(`setup failed: ${r.error}`);
  return { code, token: r.token, session: r.session };
}

async function addModerator(env: ReturnType<typeof setup>, username: string, password = PASS): Promise<string> {
  const id = randomBytes(16).toString('hex');
  const hash = await hashAdminPassword(password, FAST);
  env.run(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at, status)
           VALUES (?, ?, ?, '', ?, ?, ?, 'active')`, id, username, username.toLowerCase(), `#none:${id}`, hash, env.clock.t);
  env.run('INSERT INTO admins (account_id, added_at, added_by) VALUES (?, ?, ?)', id, env.clock.t, 'test');
  return id;
}

const actions = (env: ReturnType<typeof setup>): string[] => env.sql<{ action: string }>('SELECT action FROM mod_actions ORDER BY id').map((r) => r.action);

describe('setup codes', () => {
  it('Crockford base32, 8 characters; typed forms normalise; stored self-describing', () => {
    const c = newSetupCode();
    expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(formatSetupCode('K7QP4MXD')).toBe('K7QP-4MXD');
    expect(normalizeSetupCode('k7qp-4mxd')).toBe('K7QP4MXD');
    expect(normalizeSetupCode(' K7QP 4MXD ')).toBe('K7QP4MXD');
    expect(normalizeSetupCode('O1LI-2345')).toBe('0111-2345'.replace('-', ''));
    expect(normalizeSetupCode('K7QP4MX')).toBeNull();
    expect(normalizeSetupCode('K7QP4MXU')).toBeNull(); // U is not in the alphabet
    expect(normalizeSetupCode(42)).toBeNull();
    const pepper = randomBytes(32);
    expect(setupCodeHash(c, pepper)).toMatch(/^h1\$[0-9a-f]{64}$/);
    expect(setupCodeHash(c, null)).toMatch(/^s1\$[0-9a-f]{64}$/);
    expect(setupCodeHash(c, pepper)).not.toContain(c);
    expect([1, 2, 3, 4, 5, 6].map(setupLockMs)).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  });
});

describe('T-ADM-1 first-run setup (service)', () => {
  it('host PC with the right code signs in; LAN 403; already set up 404; only the hash is stored', async () => {
    const env = setup();
    expect(env.ha.state()).toEqual({ setupPending: true, setupKind: 'first', username: null });
    const code = newSetupCode();
    env.ha.installLaunchCode(code);
    const stored = env.sql<{ k: string; code_hash: string }>('SELECT k, code_hash FROM host_setup');
    expect(stored.map((r) => r.k).sort()).toEqual(['code', 'launch', 'voids']);
    for (const r of stored) expect(r.code_hash).not.toContain(code);
    expect(env.ha.setupStatus(lan('10.0.0.7'))).toMatchObject({ ok: false, status: 403, error: ADMIN_ERR.setupHostPc });
    expect(await env.ha.setup({ setupCode: code, username: 'NovaPilot', password: PASS, preset: 'home', serverName: 'Den' }, lan('10.0.0.7')))
      .toMatchObject({ ok: false, status: 403 });
    expect(env.ha.setupStatus(HOST_PC)).toMatchObject({ ok: true, needsSetup: true, kind: 'first', attemptsLeft: 5, retryAfter: 0 });
    const applied: unknown[] = [];
    const r = await env.ha.setup(
      { setupCode: formatSetupCode(code).toLowerCase(), username: 'NovaPilot', password: PASS, preset: 'school', serverName: 'Room 136', accountsMode: 'roster' },
      HOST_PC, { apply: async (c) => { applied.push(c); return { ok: true }; } },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.token).toMatch(/^vsadm_[0-9a-f]{64}$/);
    expect(r.session.principal).toEqual({ kind: 'host', via: 'local' });
    expect(applied).toEqual([{ preset: 'school', serverName: 'Room 136', accountsMode: 'roster' }]);
    expect(env.states).toEqual([{ setupPending: false, setupKind: null, username: 'NovaPilot' }]);
    expect(env.sql<{ k: string }>('SELECT k FROM host_setup').map((r) => r.k)).toEqual(['launch']);
    const hashes = env.sql<{ pass_hash: string }>('SELECT pass_hash FROM host_admins');
    expect(hashes).toHaveLength(1);
    expect(hashes[0]!.pass_hash).toMatch(/^scrypt\$/);
    expect(hashes[0]!.pass_hash).not.toContain(PASS);
    expect(await env.ha.setup({ setupCode: code, username: 'NovaPilot', password: PASS, preset: 'home', serverName: 'x' }, HOST_PC))
      .toMatchObject({ ok: false, status: 404 });
    expect(env.ha.setupStatus(HOST_PC)).toMatchObject({ ok: true, needsSetup: false });
    expect(actions(env)).toContain('setup');
  });

  it('field problems cost no attempt; password rules; a player username is refused', async () => {
    const env = setup();
    const code = newSetupCode();
    env.ha.installLaunchCode(code);
    env.run(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at) VALUES ('p1', 'Kiddo', 'kiddo', '', '#none:p1', 'x', 1)`);
    const base = { setupCode: 'WRONGWRONG', username: 'NovaPilot', password: PASS, preset: 'home', serverName: 'Den' };
    expect(await env.ha.setup({ ...base, password: 'short' }, HOST_PC)).toMatchObject({ status: 400, field: 'password' });
    expect(await env.ha.setup({ ...base, password: 'novapilot' + '' , username: 'novapilot' }, HOST_PC)).toMatchObject({ status: 400, field: 'password' });
    expect(await env.ha.setup({ ...base, password: 'Our Room 136', serverName: 'our room 136' }, HOST_PC)).toMatchObject({ status: 400, field: 'password' });
    expect(await env.ha.setup({ ...base, password: 'x'.repeat(129) }, HOST_PC)).toMatchObject({ status: 400, field: 'password' });
    expect(await env.ha.setup({ ...base, username: 'a b' }, HOST_PC)).toMatchObject({ status: 400, field: 'username' });
    expect(await env.ha.setup({ ...base, username: 'kiddo' }, HOST_PC)).toMatchObject({ status: 400, field: 'username' });
    expect(await env.ha.setup({ ...base, preset: 'office' }, HOST_PC)).toMatchObject({ status: 400, field: 'preset' });
    expect(await env.ha.setup({ ...base, accountsMode: 'mail' }, HOST_PC)).toMatchObject({ status: 400, field: 'accountsMode' });
    expect(env.ha.setupStatus(HOST_PC)).toMatchObject({ attemptsLeft: 5 });
    // A settings failure (applyPreset) answers the request and keeps the code usable.
    const bad = await env.ha.setup({ ...base, setupCode: code }, HOST_PC, { apply: async () => ({ ok: false, status: 400, error: 'That server name is not allowed.', field: 'serverName' }) });
    expect(bad).toMatchObject({ ok: false, status: 400, field: 'serverName' });
    expect(env.ha.needsSetup()).toBe(true);
    expect((await env.ha.setup({ ...base, setupCode: code }, HOST_PC)).ok).toBe(true);
  });

  it('School setup may set the Allowed email domains (owner decision 6): normalized, optional, never at Home, no attempt used', async () => {
    const env = setup();
    const code = newSetupCode();
    env.ha.installLaunchCode(code);
    const base = { setupCode: code, username: 'NovaPilot', password: PASS, preset: 'school', serverName: 'Room 136', accountsMode: 'email' };
    expect(await env.ha.setup({ ...base, setupCode: 'WRONGWRONG', domains: ['org'] }, HOST_PC)).toMatchObject({ status: 400, field: 'domains' });
    expect(await env.ha.setup({ ...base, setupCode: 'WRONGWRONG', domains: 'caldwellschools.org' }, HOST_PC)).toMatchObject({ status: 400, field: 'domains' });
    expect(await env.ha.setup({ ...base, setupCode: 'WRONGWRONG', preset: 'home', domains: ['caldwellschools.org'] }, HOST_PC))
      .toMatchObject({ status: 400, field: 'domains', error: SETUP_DOMAINS_SCHOOL_ONLY });
    expect(env.ha.setupStatus(HOST_PC)).toMatchObject({ attemptsLeft: 5 });
    const applied: unknown[] = [];
    const r = await env.ha.setup({ ...base, domains: ['@CaldwellSchools.org', { domain: 'caldwellschools.org', subdomains: true }] }, HOST_PC,
      { apply: async (c) => { applied.push(c); return { ok: true }; } });
    expect(r.ok).toBe(true);
    expect(applied).toEqual([{ preset: 'school', serverName: 'Room 136', accountsMode: 'email', domains: [{ domain: 'caldwellschools.org', subdomains: true }] }]);
    // An empty list is "any domain": nothing extra to apply (Home may send one too).
    const env2 = setup();
    const code2 = newSetupCode();
    env2.ha.installLaunchCode(code2);
    const applied2: unknown[] = [];
    expect((await env2.ha.setup({ ...base, setupCode: code2, preset: 'home', domains: [] }, HOST_PC, { apply: async (c) => { applied2.push(c); return { ok: true }; } })).ok).toBe(true);
    expect(applied2[0]).not.toHaveProperty('domains');
  });

  it('5 wrong codes: void, 60 s wait, a fresh code; the next void doubles; a relaunch clears the wait', async () => {
    const env = setup();
    const code = newSetupCode();
    env.ha.installLaunchCode(code);
    const attempt = (c: string) => env.ha.setup({ setupCode: c, username: 'NovaPilot', password: PASS, preset: 'home', serverName: 'Den' }, HOST_PC);
    for (let i = 4; i >= 1; i--) expect(await attempt('AAAAAAAA')).toMatchObject({ ok: false, status: 400, attemptsLeft: i });
    expect(await attempt('AAAAAAAA')).toMatchObject({ ok: false, status: 429, retryAfter: 60, attemptsLeft: 0 });
    expect(env.codes).toHaveLength(1);
    const second = env.codes[0]!;
    expect(second).not.toBe(code);
    // During the wait even the right (new) code is refused.
    expect(await attempt(second)).toMatchObject({ status: 429, retryAfter: 60 });
    env.clock.t += 30_000;
    expect(env.ha.setupStatus(HOST_PC)).toMatchObject({ retryAfter: 30 });
    env.clock.t += 31_000;
    // The voided code no longer works; the new one would.
    expect(await attempt(code)).toMatchObject({ status: 400, attemptsLeft: 4 });
    for (let i = 3; i >= 1; i--) await attempt('BBBBBBBB');
    expect(await attempt('BBBBBBBB')).toMatchObject({ status: 429, retryAfter: 120 });
    const third = env.codes[1]!;
    // A child restarted by the same launcher passes the same launch code: the wait stays.
    env.ha.installLaunchCode(code);
    expect(await attempt(third)).toMatchObject({ status: 429 });
    // A new launcher run (proof of presence) installs its fresh code and clears the wait.
    const relaunch = newSetupCode();
    env.ha.installLaunchCode(relaunch);
    expect(env.ha.setupStatus(HOST_PC)).toMatchObject({ retryAfter: 0, attemptsLeft: 5 });
    expect((await attempt(relaunch)).ok).toBe(true);
    // Every wrong code is audited (§4.10 "every failure"), each void, and the refusals during a wait (one per minute).
    const fails = env.sql<{ reason: string }>("SELECT reason FROM mod_actions WHERE action = 'login-fail' ORDER BY id").map((r) => r.reason);
    expect(fails.filter((r) => r.startsWith('setup: wrong setup code'))).toHaveLength(8);
    expect(fails.filter((r) => r.startsWith('setup code voided'))).toHaveLength(2);
    expect(fails.filter((r) => r.startsWith('setup: refused during the wait'))).toHaveLength(2);
    expect(fails).toHaveLength(12);
    expect(fails[0]).toBe('setup: wrong setup code (4 tries left)');
    expect(JSON.stringify(fails)).not.toMatch(/AAAAAAAA|BBBBBBBB/);
  });

  it('a code lasts 30 minutes, then a fresh one is minted', async () => {
    const env = setup();
    const code = newSetupCode();
    env.ha.installLaunchCode(code);
    env.clock.t += 30 * MIN + 1;
    const r = await env.ha.setup({ setupCode: code, username: 'NovaPilot', password: PASS, preset: 'home', serverName: 'Den' }, HOST_PC);
    expect(r).toMatchObject({ ok: false, status: 400, error: ADMIN_ERR.setupCodeExpired });
    expect(env.codes).toHaveLength(1);
    expect((await env.ha.setup({ setupCode: env.codes[0], username: 'NovaPilot', password: PASS, preset: 'home', serverName: 'Den' }, HOST_PC)).ok).toBe(true);
  });

  it('a code written without the pepper (a tool) still verifies', async () => {
    const env = setup();
    const db = new DatabaseSync(env.dbPath);
    let out: ReturnType<typeof resetHostAdmin>;
    try {
      out = resetHostAdmin(db, { now: env.clock.t });
      expect(hostAdminState(db)).toMatchObject({ setupPending: true, setupKind: 'first' });
    } finally { db.close(); }
    expect((await env.ha.setup({ setupCode: out.setupCode, username: 'NovaPilot', password: PASS, preset: 'home', serverName: 'Den' }, HOST_PC)).ok).toBe(true);
  });
});

describe('T-ADM-2 host login, throttle and sessions (service)', () => {
  it('host login; 5 wrong from one LAN address → 429 while the host PC still works', async () => {
    const env = setup({ remoteAccess: 'limited' });
    await firstRun(env);
    const a = lan('10.0.0.7');
    for (let i = 0; i < 5; i++) expect(await env.ha.login({ role: 'host', username: 'NovaPilot', password: 'wrong-password-1' }, a)).toMatchObject({ status: 401 });
    expect(await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, a)).toMatchObject({ ok: false, status: 429 });
    const other = await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, lan('10.0.0.8'));
    expect(other.ok).toBe(true);
    if (other.ok) expect(other.session.principal).toEqual({ kind: 'host', via: 'limited' });
    const local = await env.ha.login({ role: 'host', username: 'novapilot', password: PASS }, HOST_PC);
    expect(local.ok).toBe(true);
    // The block lasts 15 minutes.
    env.clock.t += 15 * MIN + 1;
    expect((await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, a)).ok).toBe(true);
    const log = actions(env);
    // 5 wrong passwords, and the throttled attempt (a refusal is a failure too).
    expect(log.filter((x) => x === 'login-fail')).toHaveLength(6);
    expect(log.filter((x) => x === 'login').length).toBeGreaterThanOrEqual(3);
    // A failed login records the address, never the typed password.
    const fails = env.sql<{ actor_name: string; target_address: string; reason: string }>("SELECT actor_name, target_address, reason FROM mod_actions WHERE action = 'login-fail' ORDER BY id");
    expect(fails[0]).toMatchObject({ actor_name: 'NovaPilot', target_address: '10.0.0.7' });
    expect(fails[5]).toMatchObject({ actor_name: '(unknown name)', target_address: '10.0.0.7', reason: expect.stringMatching(/^sign-in refused \(429\): Too many failed sign-ins/) });
    expect(JSON.stringify(fails)).not.toContain('wrong-password');
  });

  it('refused sign-ins are audited coalesced (one row per address and kind per minute, with a count); the remote pause gets a row', async () => {
    const env = setup({ remoteAccess: 'full' });
    await firstRun(env);
    const a = lan('10.0.0.7');
    for (let i = 0; i < 5; i++) await env.ha.login({ role: 'host', username: 'NovaPilot', password: 'wrong-password-1' }, a);
    // A flood of throttled attempts: one row, then the count rides on the next one a minute later.
    for (let i = 0; i < 40; i++) expect(await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, a)).toMatchObject({ status: 429 });
    const refused = () => env.sql<{ reason: string }>("SELECT reason FROM mod_actions WHERE action = 'login-fail' AND reason LIKE 'sign-in refused%' ORDER BY id").map((r) => r.reason);
    expect(refused()).toHaveLength(1);
    env.clock.t += 61_000;
    await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, a);
    expect(refused()).toHaveLength(2);
    expect(refused()[1]).toMatch(/\(\+39 more refused since the last note\)$/);
    // Remote access off: refused at the place check, audited the same way.
    env.policy.remoteAccess = 'off';
    for (let i = 0; i < 3; i++) await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, lan('10.0.0.9'));
    expect(refused().filter((r) => r.includes('Remote access to the control panel is off'))).toHaveLength(1);
    env.policy.remoteAccess = 'full';
    // 30 remote failures in an hour: the pause itself is written once.
    env.clock.t += 16 * MIN;
    for (let i = 0; i < 30; i++) await env.ha.login({ role: 'host', username: 'NovaPilot', password: 'nope-nope-nope' }, lan(`10.1.${Math.floor(i / 4)}.${i % 4 + 1}`));
    const paused = env.sql<{ actor_account_id: string; reason: string }>("SELECT actor_account_id, reason FROM mod_actions WHERE reason LIKE 'remote sign-in to the control panel paused%'");
    expect(paused).toEqual([{ actor_account_id: 'system', reason: 'remote sign-in to the control panel paused for 1 h after 30 failed remote attempts in an hour' }]);
    expect(await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, lan('10.9.9.9'))).toMatchObject({ status: 429, error: ADMIN_ERR.remotePaused });
    expect(refused().some((r) => r.includes(ADMIN_ERR.remotePaused))).toBe(true);
  });

  it('host PC: 5 failures mean a 60 s wait, doubling; remote access off: LAN login 403', async () => {
    const env = setup();
    await firstRun(env);
    const wrong = () => env.ha.login({ role: 'host', username: 'NovaPilot', password: 'nope-nope-nope' }, HOST_PC);
    for (let i = 0; i < 5; i++) expect(await wrong()).toMatchObject({ status: 401 });
    expect(await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, HOST_PC)).toMatchObject({ status: 429, retryAfter: 60 });
    env.clock.t += 61_000;
    for (let i = 0; i < 5; i++) await wrong();
    expect(await wrong()).toMatchObject({ status: 429, retryAfter: 120 });
    env.clock.t += 121_000;
    expect((await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, HOST_PC)).ok).toBe(true);
    expect(await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, lan('10.0.0.7'))).toMatchObject({ status: 403 });
    expect(await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, { ...lan('10.0.0.7'), secure: false })).toMatchObject({ status: 403 });
  });

  it('30 remote failures in an hour pause remote sign-in (banner); the host PC is unaffected', async () => {
    const env = setup({ remoteAccess: 'full' });
    await firstRun(env);
    for (let i = 0; i < 30; i++) {
      await env.ha.login({ role: 'host', username: 'NovaPilot', password: 'nope-nope-nope' }, lan(`10.0.${Math.floor(i / 4)}.${i % 4 + 1}`));
    }
    expect(await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, lan('10.9.9.9'))).toMatchObject({ status: 429, error: ADMIN_ERR.remotePaused });
    expect(env.ha.banners()[0]).toMatchObject({ code: 'remote-login-paused' });
    expect((await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, HOST_PC)).ok).toBe(true);
    env.clock.t += 60 * MIN + 1;
    expect((await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, lan('10.9.9.9'))).ok).toBe(true);
  });

  it('30 minutes idle → 401; 12 h → 401; another address or route → 401; at most 5 sessions', async () => {
    const env = setup({ remoteAccess: 'limited' });
    const { token } = await firstRun(env);
    expect(env.ha.authenticate(token, HOST_PC).ok).toBe(true);
    // Another address or route never works with this token.
    expect(env.ha.authenticate(token, lan('10.0.0.7'))).toMatchObject({ status: 401, error: ADMIN_ERR.elsewhere });
    expect(env.ha.authenticate(token, { ...HOST_PC, via: 'direct', hostPc: false })).toMatchObject({ status: 401 });
    const remote = await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, lan('10.0.0.7'));
    if (!remote.ok) throw new Error('login');
    expect(env.ha.authenticate(remote.token, lan('10.0.0.8'))).toMatchObject({ status: 401, error: ADMIN_ERR.elsewhere });
    // Idle: 29 minutes is fine, then 31 without deliberate activity ends it.
    env.clock.t += 29 * MIN;
    expect(env.ha.authenticate(token, HOST_PC).ok).toBe(true);
    env.clock.t += 31 * MIN;
    expect(env.ha.authenticate(token, HOST_PC)).toMatchObject({ status: 401, error: ADMIN_ERR.idle });
    expect(env.ha.authenticate(token, HOST_PC)).toMatchObject({ status: 401, error: ADMIN_ERR.sessionEnded });
    // Absolute: 12 h even when busy.
    const busy = await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, HOST_PC);
    if (!busy.ok) throw new Error('login');
    for (let t = 0; t < SESSION_ABSOLUTE_MS - 20 * MIN; t += 20 * MIN) { env.clock.t += 20 * MIN; expect(env.ha.authenticate(busy.token, HOST_PC).ok).toBe(true); }
    env.clock.t += 21 * MIN;
    expect(env.ha.authenticate(busy.token, HOST_PC)).toMatchObject({ status: 401, error: ADMIN_ERR.expired });
    // At most 5 per principal: the 6th drops the oldest.
    const tokens: string[] = [];
    for (let i = 0; i < 6; i++) {
      env.clock.t += 1000;
      const l = await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, HOST_PC);
      if (!l.ok) throw new Error('login');
      tokens.push(l.token);
    }
    expect(tokens.map((t) => env.ha.authenticate(t, HOST_PC, { passive: true }).ok)).toEqual([false, true, true, true, true, true]);
  });

  it('a password change revokes the other sessions (not the caller); the old password stops working', async () => {
    const env = setup({ remoteAccess: 'limited' });
    const { token } = await firstRun(env);
    const other = await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, lan('10.0.0.7'));
    if (!other.ok) throw new Error('login');
    const s = env.ha.authenticate(token, HOST_PC);
    if (!s.ok) throw new Error('auth');
    // A remote `limited` (click-through) session can't change it: that would end the host PC's session (§4.10).
    const remote = env.ha.authenticate(other.token, lan('10.0.0.7'));
    if (!remote.ok) throw new Error('auth');
    expect(remote.session.principal).toEqual({ kind: 'host', via: 'limited' });
    expect(await env.ha.changePassword(remote.session, PASS, 'Another-Pass-42', lan('10.0.0.7'))).toMatchObject({ ok: false, status: 403, error: ADMIN_ERR.passwordHere });
    expect(env.ha.authenticate(token, HOST_PC).ok).toBe(true);
    expect(await env.ha.changePassword(s.session, 'not-the-password', 'Another-Pass-42', HOST_PC)).toMatchObject({ status: 400, wrongPassword: true });
    expect(await env.ha.changePassword(s.session, PASS, 'short', HOST_PC)).toMatchObject({ status: 400, field: 'next' });
    expect(await env.ha.changePassword(s.session, PASS, 'Another-Pass-42', HOST_PC)).toMatchObject({ ok: true, revoked: 1 });
    expect(env.ha.authenticate(other.token, lan('10.0.0.7'))).toMatchObject({ status: 401 });
    expect(env.ha.authenticate(token, HOST_PC).ok).toBe(true);
    expect(await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, HOST_PC)).toMatchObject({ status: 401 });
    expect((await env.ha.login({ role: 'host', username: 'NovaPilot', password: 'Another-Pass-42' }, HOST_PC)).ok).toBe(true);
    expect(actions(env)).toContain('admin-password');
  });

  it('remote principals: limited; full without devicesTrustCert → limited; full + trusted TLS → full; switched off → 401', async () => {
    const env = setup({ remoteAccess: 'full' });
    await firstRun(env);
    const click = await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, lan('10.0.0.7', false));
    const trusted = await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, lan('10.0.0.8', true));
    if (!click.ok || !trusted.ok) throw new Error('login');
    expect(click.session.principal).toEqual({ kind: 'host', via: 'limited' });
    expect(trusted.session.principal).toEqual({ kind: 'host', via: 'full' });
    env.policy.remoteAccess = 'limited';
    expect((env.ha.authenticate(trusted.token, lan('10.0.0.8', true)) as { session: AdminSession }).session.principal).toEqual({ kind: 'host', via: 'limited' });
    env.policy.remoteAccess = 'off';
    expect(env.ha.authenticate(trusted.token, lan('10.0.0.8', true))).toMatchObject({ status: 401 });
  });
});

describe('T-ADM-17 step-up and liveKeepsAlive (service)', () => {
  it('deliberate activity keeps the session fresh; a 10-minute gap makes it stale; reauth refreshes; polls never do', async () => {
    const env = setup();
    const { token } = await firstRun(env);
    const auth = (o: { passive?: boolean; keepAlive?: boolean } = {}) => {
      const r = env.ha.authenticate(token, HOST_PC, o);
      if (!r.ok) throw new Error(r.error);
      return r.session;
    };
    expect(auth().fresh).toBe(true);
    env.clock.t += 9 * MIN;
    expect(auth().fresh).toBe(true); // a deliberate call within 10 minutes keeps it fresh …
    env.clock.t += 9 * MIN;
    expect(auth().fresh).toBe(true); // … and slides the window
    // Polls (Live, Home) for 11 minutes do not refresh it.
    for (let i = 0; i < 11; i++) { env.clock.t += MIN; auth({ passive: true, keepAlive: true }); }
    const stale = auth();
    expect(stale.fresh).toBe(false);
    expect(env.ha.sessionInfo(stale).freshUntil).toBe(0);
    // Stale stays stale until the password is entered.
    expect(auth().fresh).toBe(false);
    expect(await env.ha.reauth(stale, 'wrong password!', HOST_PC)).toMatchObject({ status: 400, wrongPassword: true });
    const re = await env.ha.reauth(stale, PASS, HOST_PC);
    expect(re.ok).toBe(true);
    expect(auth().fresh).toBe(true);
    expect(env.ha.sessionInfo(auth()).freshUntil).toBe(env.clock.t + 10 * MIN);
    expect(actions(env)).toContain('reauth');
  });

  it('liveKeepsAlive (host PC): Live polls keep the session alive for at most 3 h; not remote, not when off', async () => {
    const env = setup({ remoteAccess: 'limited' });
    const { token } = await firstRun(env);
    const remote = await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, lan('10.0.0.7'));
    if (!remote.ok) throw new Error('login');
    let t = 0;
    const step = 25_000;
    let remoteAlive = true;
    while (t < LIVE_KEEPALIVE_MAX_MS - step) {
      env.clock.t += step; t += step;
      expect(env.ha.authenticate(token, HOST_PC, { passive: true, keepAlive: true }).ok).toBe(true);
      if (remoteAlive) remoteAlive = env.ha.authenticate(remote.token, lan('10.0.0.7'), { passive: true, keepAlive: true }).ok;
    }
    expect(remoteAlive).toBe(false); // the remote Live view never keeps a session alive
    // A Home poll (passive, not keep-alive) on the host PC is fine while Live keeps it alive …
    expect(env.ha.authenticate(token, HOST_PC, { passive: true }).ok).toBe(true);
    // … but it ends by 3 h after the last deliberate action.
    env.clock.t += 2 * step;
    expect(env.ha.authenticate(token, HOST_PC, { passive: true, keepAlive: true })).toMatchObject({ status: 401, error: ADMIN_ERR.idle });

    env.policy.liveKeepsAlive = false;
    const again = await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, HOST_PC);
    if (!again.ok) throw new Error('login');
    for (let i = 0; i < 31; i++) { env.clock.t += MIN; env.ha.authenticate(again.token, HOST_PC, { passive: true, keepAlive: true }); }
    expect(env.ha.authenticate(again.token, HOST_PC, { passive: true, keepAlive: true }).ok).toBe(false);
  });
});

describe('T-ADM-16 moderator sessions', () => {
  it('moderator view off → 403; a demoted, disabled, banned or deleted moderator\'s next call gets 401', async () => {
    const env = setup({ remoteAccess: 'limited' });
    await firstRun(env);
    const who = lan('10.0.0.9');
    const id = await addModerator(env, 'Wingmate');
    expect(await env.ha.login({ role: 'moderator', username: 'Wingmate', password: PASS }, who)).toMatchObject({ status: 403, error: ADMIN_ERR.moderatorViewOff });
    env.policy.moderatorView = true;
    const signIn = async (): Promise<string> => {
      const r = await env.ha.login({ role: 'moderator', username: 'Wingmate', password: PASS }, who);
      if (!r.ok) throw new Error(r.error);
      expect(r.session.principal).toEqual({ kind: 'moderator', tier: 'limited' });
      return r.token;
    };
    // Demoted
    let token = await signIn();
    expect(env.ha.authenticate(token, who).ok).toBe(true);
    env.run('DELETE FROM admins WHERE account_id = ?', id);
    expect(env.ha.authenticate(token, who)).toMatchObject({ status: 401 });
    expect(await env.ha.login({ role: 'moderator', username: 'Wingmate', password: PASS }, who)).toMatchObject({ status: 401 });
    env.run('INSERT INTO admins (account_id, added_at, added_by) VALUES (?, ?, ?)', id, env.clock.t, 'test');
    // Disabled
    token = await signIn();
    env.run("UPDATE accounts SET status = 'disabled' WHERE id = ?", id);
    expect(env.ha.authenticate(token, who)).toMatchObject({ status: 401 });
    env.run("UPDATE accounts SET status = 'active' WHERE id = ?", id);
    // Banned
    token = await signIn();
    env.run(`INSERT INTO bans (kind, scope, account_id, username, created_at, expires_at, reason, by) VALUES ('ban', 'account', ?, 'Wingmate', ?, NULL, 'test', 'NovaPilot')`, id, env.clock.t);
    expect(env.ha.authenticate(token, who)).toMatchObject({ status: 401 });
    env.run('UPDATE bans SET revoked_at = ? WHERE account_id = ?', env.clock.t, id);
    // Moderator view switched off
    token = await signIn();
    env.policy.moderatorView = false;
    expect(env.ha.authenticate(token, who)).toMatchObject({ status: 401 });
    env.policy.moderatorView = true;
    // Remote access switched off: the remote session ends, a session on the host PC stays.
    token = await signIn();
    const local = await env.ha.login({ role: 'moderator', username: 'Wingmate', password: PASS }, HOST_PC);
    if (!local.ok) throw new Error(local.error);
    env.policy.remoteAccess = 'off';
    expect(env.ha.authenticate(token, who)).toMatchObject({ status: 401 });
    expect(env.ha.authenticate(local.token, HOST_PC).ok).toBe(true);
    env.policy.remoteAccess = 'limited';
    expect(env.ha.authenticate(token, who)).toMatchObject({ status: 401 });
    // Deleted
    token = await signIn();
    env.run('DELETE FROM accounts WHERE id = ?', id);
    expect(env.ha.authenticate(token, who)).toMatchObject({ status: 401 });
    expect(env.ha.authenticate(local.token, HOST_PC)).toMatchObject({ status: 401 });
  });

  it('revokeDisallowed: switching the moderators\' view or remote access off ends those sessions at once (§4.10)', async () => {
    const env = setup({ remoteAccess: 'limited', moderatorView: true });
    const host = await firstRun(env);
    await addModerator(env, 'Wingmate');
    const mod = await env.ha.login({ role: 'moderator', username: 'Wingmate', password: PASS }, HOST_PC);
    if (!mod.ok) throw new Error(mod.error);
    const remoteHost = await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, lan('10.0.0.9'));
    if (!remoteHost.ok) throw new Error(remoteHost.error);
    expect(env.ha.revokeDisallowed({ moderatorView: true, remoteAccess: 'limited' })).toBe(0);
    expect(env.ha.revokeDisallowed({ moderatorView: false, remoteAccess: 'limited' })).toBe(1); // the moderator's
    expect(env.ha.revokeDisallowed({ moderatorView: true, remoteAccess: 'off' })).toBe(1); // the remote host session
    expect(env.ha.authenticate(host.token, HOST_PC).ok).toBe(true); // the host PC's own session stays
  });

  it('moderators: the tier from settings; no password change here; revokeModerator ends them at once', async () => {
    const env = setup({ moderatorView: true, moderatorTier: 'trusted' });
    await firstRun(env);
    const id = await addModerator(env, 'Wingmate');
    const r = await env.ha.login({ role: 'moderator', username: 'wingmate', password: PASS }, HOST_PC);
    if (!r.ok) throw new Error(r.error);
    expect(r.session.principal).toEqual({ kind: 'moderator', tier: 'trusted' });
    expect(r.session.accountId).toBe(id);
    expect(await env.ha.changePassword(r.session, PASS, 'Another-Pass-42', HOST_PC)).toMatchObject({ status: 403 });
    expect(env.ha.revokeModerator(id)).toBe(1);
    expect(env.ha.authenticate(r.token, HOST_PC)).toMatchObject({ status: 401 });
    // A non-moderator player gets the same generic 401 as a wrong password.
    env.run('DELETE FROM admins WHERE account_id = ?', id);
    expect(await env.ha.login({ role: 'moderator', username: 'Wingmate', password: PASS }, HOST_PC)).toMatchObject({ status: 401, error: ADMIN_ERR.wrongLogin });
  });
});

describe('Reset admin password and admin-set', () => {
  it('reset clears the hash (the row stays), revokes sessions, issues a code; setup runs in reset mode; reload notices', async () => {
    const env = setup();
    const { token, code: launchCode } = await firstRun(env);
    const db = new DatabaseSync(env.dbPath);
    const out = resetHostAdmin(db, { pepper: env.pepper, now: env.clock.t });
    db.close();
    expect(out).toMatchObject({ username: 'NovaPilot', sessionsRevoked: 1 });
    expect(env.sql('SELECT id FROM host_admins')).toHaveLength(1);
    expect(env.ha.authenticate(token, HOST_PC)).toMatchObject({ status: 401 });
    env.states.length = 0;
    expect(env.ha.reload()).toEqual({ setupPending: true, setupKind: 'reset', username: 'NovaPilot' });
    expect(env.states).toHaveLength(1);
    expect(env.ha.setupStatus(HOST_PC)).toMatchObject({ needsSetup: true, kind: 'reset' });
    // A child restart by the same launcher (its original code) keeps the tool's code.
    env.ha.installLaunchCode(launchCode);
    expect(env.ha.setupStatus(HOST_PC)).toMatchObject({ attemptsLeft: 5 });
    // Reset mode: only a login (no preset, no server name).
    const r = await env.ha.setup({ setupCode: out.setupCode, username: 'NovaPilot', password: 'Brand-New-Pass-9' }, HOST_PC, {
      apply: async () => { throw new Error('the preset must not be re-applied after a reset'); },
    });
    expect(r).toMatchObject({ ok: true, kind: 'reset' });
    expect(actions(env)).toEqual(expect.arrayContaining(['setup', 'admin-reset']));
  });

  it('a reset made while the host was stopped: the printed code still works after the next launcher run; a void ends it', async () => {
    const env = setup();
    const { code: firstLaunch } = await firstRun(env);
    env.ha.close();
    const out = resetHostAdminAt(env.dbPath, { now: env.clock.t }); // the tool has no pepper: the stored form says so
    // The next launcher run installs its own code; both work until one is used, they expire, or they are voided.
    const start = () => new HostAdmin({ dbPath: env.dbPath, now: () => env.clock.t, policy: () => env.policy, passwordParams: FAST, pepper: env.pepper, onSetupCode: (c) => env.codes.push(c) });
    const ha = start();
    open.push(ha);
    const relaunch = newSetupCode();
    ha.installLaunchCode(relaunch);
    expect(relaunch).not.toBe(firstLaunch);
    expect(ha.setupStatus(HOST_PC)).toMatchObject({ needsSetup: true, kind: 'reset', attemptsLeft: 5 });
    const r = await ha.setup({ setupCode: formatSetupCode(out.setupCode), username: 'NovaPilot', password: 'Brand-New-Pass-9' }, HOST_PC);
    expect(r).toMatchObject({ ok: true, kind: 'reset' });
    expect(env.sql("SELECT k FROM host_setup WHERE k <> 'launch'")).toEqual([]);

    // A second reset, then 5 wrong codes: the tool's code is void with the launcher's.
    const again = resetHostAdminAt(env.dbPath, { now: env.clock.t });
    for (let i = 0; i < 5; i++) await ha.setup({ setupCode: 'AAAAAAAA', username: 'NovaPilot', password: 'Brand-New-Pass-9' }, HOST_PC);
    env.clock.t += 61_000;
    expect(await ha.setup({ setupCode: again.setupCode, username: 'NovaPilot', password: 'Brand-New-Pass-9' }, HOST_PC)).toMatchObject({ ok: false, status: 400, error: ADMIN_ERR.setupCodeWrong });
  });

  it('admin-reset over the pipe (§4.10): the tool resets the DB, tells the running host with pipe.key, the child re-reads', async () => {
    const env = setup();
    const { token } = await firstRun(env);
    const panel = { hostAdmin: env.ha };
    const key = randomBytes(32);
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\voidswarm-test-${randomBytes(8).toString('hex')}` : join(env.dir, 'lock.sock');
    // The launcher holds the pipe and forwards reload-admin to its child (IPC), which handles it in handleAdminIpcMessage.
    const forwarded: unknown[] = [];
    const got = await acquireLock({
      dataDir: env.dir, key, pipe,
      handlers: { panelUrl: () => 'http://localhost:7778/', reloadAdmin: () => { const m = { type: 'reload-admin' }; forwarded.push(m); handleAdminIpcMessage(panel, m); } },
    });
    if (!got.ok) throw new Error('could not take the test pipe');
    try {
      // 1. clear the hash and 2. revoke the sessions (the row and its audit history stay); 4. a new setup code.
      const out = resetHostAdminAt(env.dbPath, { now: env.clock.t });
      expect(out).toMatchObject({ username: 'NovaPilot', sessionsRevoked: 1 });
      expect(env.ha.authenticate(token, HOST_PC)).toMatchObject({ ok: false, status: 401 });
      // 3. tell the running host: refused without the key, accepted (and the reply verified) with it.
      expect(await sendCommand({ dataDir: env.dir, key: null, cmd: 'reload-admin', pipe })).toMatchObject({ ok: false, error: 'refused' });
      expect(forwarded).toHaveLength(0);
      env.states.length = 0;
      expect(await sendCommand({ dataDir: env.dir, key, cmd: 'reload-admin', pipe })).toMatchObject({ ok: true, verified: true });
      expect(forwarded).toEqual([{ type: 'reload-admin' }]);
      expect(env.states).toEqual([{ setupPending: true, setupKind: 'reset', username: 'NovaPilot' }]);
      expect(adminReadyFields({ hostAdmin: env.ha, port: 7778 })).toEqual({ setupPending: true, setupKind: 'reset', adminPort: 7778 });
      // The printed code sets a new login on the host PC.
      const r = await env.ha.setup({ setupCode: formatSetupCode(out.setupCode), username: 'NovaPilot', password: 'Brand-New-Pass-9' }, HOST_PC);
      expect(r).toMatchObject({ ok: true, kind: 'reset' });
      expect(env.states.at(-1)).toEqual({ setupPending: false, setupKind: null, username: 'NovaPilot' });
      expect(actions(env)).toEqual(expect.arrayContaining(['admin-reset', 'setup']));
    } finally {
      await got.lock.close();
    }
  });

  it('the child\'s IPC hooks: setup-code after a void, setup-done once set up; other messages are not ours', async () => {
    const env = setup();
    const sent: unknown[] = [];
    const hooks = adminIpcHooks((m) => sent.push(m));
    hooks.onSetupCode('K7QP4MXD', 'void');
    hooks.onStateChange({ setupPending: true, setupKind: 'reset', username: 'NovaPilot' });
    hooks.onStateChange({ setupPending: false, setupKind: null, username: 'NovaPilot' });
    expect(sent).toEqual([{ type: 'setup-code', code: 'K7QP4MXD', why: 'void' }, { type: 'setup-done' }]);
    expect(adminIpcHooks(() => { throw new Error('the launcher is gone'); }).onSetupCode('K7QP4MXD', 'expired')).toBeUndefined();
    expect(handleAdminIpcMessage({ hostAdmin: env.ha }, { type: 'stop' })).toBe(false);
    expect(handleAdminIpcMessage(null, { type: 'reload-admin' })).toBe(true);
    expect(adminReadyFields(null)).toEqual({});
  });

  it('admin-set creates or replaces the host admin (VPS)', async () => {
    const env = setup();
    const db = new DatabaseSync(env.dbPath);
    try {
      await expect(setHostAdminCredential(db, { username: 'x', password: PASS, params: FAST })).rejects.toThrow(/username/);
      await expect(setHostAdminCredential(db, { username: 'Operator', password: 'short', params: FAST })).rejects.toThrow(/password/);
      // Never a player's username (as setup): the Zone would then refuse that player's own name.
      db.prepare(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at) VALUES ('p1', 'Kiddo', 'kiddo', '', '#none:p1', 'x', 1)`).run();
      await expect(setHostAdminCredential(db, { username: 'kiddo', password: PASS, params: FAST })).rejects.toThrow(ADMIN_ERR.playerName);
      expect(hostAdminState(db)).toEqual({ setupPending: true, setupKind: 'first', username: null });
      expect(await setHostAdminCredential(db, { username: 'Operator', password: PASS, params: FAST })).toEqual({ created: true, sessionsRevoked: 0 });
      expect(hostAdminState(db)).toEqual({ setupPending: false, setupKind: null, username: 'Operator' });
      expect(await setHostAdminCredential(db, { username: 'Operator2', password: PASS, params: FAST })).toMatchObject({ created: false });
    } finally { db.close(); }
    expect(env.ha.isReservedName('operator2')).toBe(true);
    expect(env.ha.isReservedName('Kiddo')).toBe(false);
    expect((await env.ha.login({ role: 'host', username: 'Operator2', password: PASS }, { address: 'loopback', via: 'direct', hostPc: false, secure: false, trustedTls: false })).ok).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------ fixer round 2 (verifier findings)

describe('refused sign-ins: a folded count is always written', () => {
  const refusedRows = (env: ReturnType<typeof setup>): string[] =>
    env.sql<{ reason: string }>("SELECT reason FROM mod_actions WHERE action = 'login-fail' AND reason LIKE 'sign-in refused%' ORDER BY id").map((r) => r.reason);

  async function flood(env: ReturnType<typeof setup>, who: AdminCaller, n: number): Promise<void> {
    for (let i = 0; i < 5; i++) await env.ha.login({ role: 'host', username: 'NovaPilot', password: `wrong-wrong-${i}` }, who);
    for (let i = 0; i < n; i++) expect(await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, who)).toMatchObject({ status: 429 });
  }

  it('once the minute is over the timer writes it, with no later refusal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const env = setup({ remoteAccess: 'limited' });
      await firstRun(env);
      await flood(env, lan('10.0.0.8'), 40);
      expect(refusedRows(env)).toHaveLength(1);
      env.clock.t += 20 * MIN;
      vi.advanceTimersByTime(REFUSAL_AUDIT_COALESCE_MS + 1);
      const rows = refusedRows(env);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatch(/^sign-in refused \(429\): Too many failed sign-ins.*\(\+39 more refused since the last note\)$/);
      // Nothing is written twice.
      env.clock.t += 5 * MIN;
      vi.advanceTimersByTime(5 * REFUSAL_AUDIT_COALESCE_MS);
      expect(refusedRows(env)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() writes a pending count at once; a later call after the minute writes it too', async () => {
    const env = setup({ remoteAccess: 'limited' });
    const { token } = await firstRun(env);
    await flood(env, lan('10.0.0.8'), 12);
    // Any later admin call once the minute is over (the timer may be late).
    env.clock.t += REFUSAL_AUDIT_COALESCE_MS + 1;
    expect(env.ha.authenticate(token, HOST_PC).ok).toBe(true);
    expect(refusedRows(env)).toHaveLength(2);
    expect(refusedRows(env)[1]).toMatch(/\(\+11 more refused since the last note\)$/);
    // A new flood from another address, then shutdown inside the minute: the count is not lost.
    await flood(env, lan('10.0.0.9'), 7);
    expect(refusedRows(env)).toHaveLength(3);
    env.ha.close();
    expect(refusedRows(env)).toHaveLength(4);
    expect(refusedRows(env)[3]).toMatch(/\(\+6 more refused since the last note\)$/);
  });
});

describe('the session cap never lets a remote login end the host PC session', () => {
  it('5 remote logins: the host PC session survives, the oldest remote one goes', async () => {
    const env = setup({ remoteAccess: 'limited' });
    const { token } = await firstRun(env);
    const remote: string[] = [];
    for (let i = 0; i < 5; i++) {
      env.clock.t += 1000;
      const l = await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, lan('10.0.0.9'));
      if (!l.ok) throw new Error(l.error);
      remote.push(l.token);
    }
    expect(env.ha.authenticate(token, HOST_PC, { passive: true }).ok).toBe(true);
    expect(remote.map((t) => env.ha.authenticate(t, lan('10.0.0.9'), { passive: true }).ok)).toEqual([false, true, true, true, true]);
    expect(Number(env.sql<{ n: number }>('SELECT COUNT(*) AS n FROM admin_sessions')[0]!.n)).toBe(MAX_SESSIONS_PER_PRINCIPAL);
  });

  it('with the cap full of host PC sessions a remote login is refused (409, audited); a host PC login ends a remote one first', async () => {
    const env = setup({ remoteAccess: 'limited' });
    const local: string[] = [(await firstRun(env)).token];
    for (let i = 0; i < 4; i++) {
      env.clock.t += 1000;
      const l = await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, HOST_PC);
      if (!l.ok) throw new Error(l.error);
      local.push(l.token);
    }
    const refused = await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, lan('10.0.0.9'));
    expect(refused).toMatchObject({ ok: false, status: 409, error: ADMIN_ERR.tooManySessions });
    expect(local.every((t) => env.ha.authenticate(t, HOST_PC, { passive: true }).ok)).toBe(true);
    expect(env.sql<{ reason: string }>("SELECT reason FROM mod_actions WHERE action = 'login-fail' ORDER BY id DESC LIMIT 1")[0]!.reason)
      .toMatch(/^sign-in refused: too many open sessions role=host via=https/);
    // The host PC signs out of one; a remote login then fits; the next host PC login ends that remote session, not a local one.
    const last = env.ha.authenticate(local.pop()!, HOST_PC, { passive: true });
    if (!last.ok) throw new Error(last.error);
    env.ha.logout(last.session, HOST_PC);
    const r = await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, lan('10.0.0.9'));
    if (!r.ok) throw new Error(r.error);
    env.clock.t += 1000;
    const again = await env.ha.login({ role: 'host', username: 'NovaPilot', password: PASS }, HOST_PC);
    expect(again.ok).toBe(true);
    expect(env.ha.authenticate(r.token, lan('10.0.0.9'), { passive: true }).ok).toBe(false);
    expect(local.every((t) => env.ha.authenticate(t, HOST_PC, { passive: true }).ok)).toBe(true);
  });

  it('moderators too: a remote moderator login never ends their host PC session', async () => {
    const env = setup({ remoteAccess: 'limited', moderatorView: true });
    await firstRun(env);
    await addModerator(env, 'Wingmate');
    const home = await env.ha.login({ role: 'moderator', username: 'Wingmate', password: PASS }, HOST_PC);
    if (!home.ok) throw new Error(home.error);
    for (let i = 0; i < 6; i++) { env.clock.t += 1000; expect((await env.ha.login({ role: 'moderator', username: 'Wingmate', password: PASS }, lan('10.0.0.5'))).ok).toBe(true); }
    expect(env.ha.authenticate(home.token, HOST_PC, { passive: true }).ok).toBe(true);
  });
});

describe('a renamed host admin keeps its bans host bans', () => {
  const addBan = (env: ReturnType<typeof setup>, by: string): void =>
    env.run(`INSERT INTO bans (kind, scope, account_id, username, address_prefix, created_at, expires_at, reason, by) VALUES ('ban', 'address', NULL, NULL, '192.168.1.77', ?, NULL, 'host decision', ?)`, env.clock.t, by);
  const byOf = (env: ReturnType<typeof setup>): string[] => env.sql<{ by: string }>('SELECT by FROM bans ORDER BY id').map((r) => r.by);

  it("admin-set with a new name moves the host bans to it (moderators' bans stay theirs); every earlier name is known", async () => {
    const env = setup();
    await firstRun(env);
    addBan(env, 'NovaPilot');
    addBan(env, 'Wingmate');
    const db = new DatabaseSync(env.dbPath);
    try {
      await setHostAdminCredential(db, { username: 'NewHost', password: PASS, params: FAST });
    } finally { db.close(); }
    expect(byOf(env)).toEqual(['NewHost', 'Wingmate']);
    expect(env.sql<{ reason: string }>("SELECT reason FROM mod_actions WHERE action = 'admin-set'")[0]!.reason)
      .toBe('host admin login replaced (renamed from NovaPilot; 1 host ban(s) moved to the new name)');
    expect([...env.ha.hostAdminNames()].sort()).toEqual(['newhost', 'novapilot']);
    for (const by of ['NewHost', 'novapilot', ' NOVAPILOT ', 'cli', 'host']) expect(env.ha.isHostBanBy(by), by).toBe(true);
    expect(env.ha.isHostBanBy('Wingmate')).toBe(false);
  });

  it('setup after a reset with a new name moves them as well (audited)', async () => {
    const env = setup();
    await firstRun(env);
    addBan(env, 'NovaPilot');
    const reset = resetHostAdminAt(env.dbPath, { pepper: env.pepper, now: env.clock.t });
    env.ha.reload();
    const r = await env.ha.setup({ setupCode: formatSetupCode(reset.setupCode), username: 'NewHost', password: PASS }, HOST_PC);
    expect(r.ok).toBe(true);
    expect(byOf(env)).toEqual(['NewHost']);
    expect(env.sql<{ reason: string }>("SELECT reason FROM mod_actions WHERE action = 'setup' ORDER BY id DESC LIMIT 1")[0]!.reason)
      .toBe('new host admin login after a reset (renamed from NovaPilot; 1 host ban(s) moved to the new name)');
    // The same name again moves nothing.
    const reset2 = resetHostAdminAt(env.dbPath, { pepper: env.pepper, now: env.clock.t });
    env.ha.reload();
    expect((await env.ha.setup({ setupCode: formatSetupCode(reset2.setupCode), username: 'NewHost', password: PASS }, HOST_PC)).ok).toBe(true);
    expect(env.sql<{ reason: string }>("SELECT reason FROM mod_actions WHERE action = 'setup' ORDER BY id DESC LIMIT 1")[0]!.reason).toBe('new host admin login after a reset');
  });
});

// ------------------------------------------------------------------------------------------ fixer round 1 (B6 verifier findings)

describe('hostAdminNames reads only the audit rows written since the last call', () => {
  /** A row writer on `db` (one prepared statement). */
  const actionWriter = (db: DatabaseSync) => {
    const st = db.prepare(`INSERT INTO mod_actions (ts, actor_account_id, actor_name, action, target_account_id, target_name, target_address, duration_sec, expires_at, reason)
                           VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 'test')`);
    return (ts: number, actorId: string, actorName: string, action = 'read'): void => { st.run(ts, actorId, actorName, action); };
  };

  it('its query is a rowid range (never a scan of the trail)', () => {
    const env = setup();
    const db = new DatabaseSync(env.dbPath);
    try {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${HOST_NAMES_SINCE_SQL}`).all(0, 1, 0, 1) as { detail: string }[]).map((r) => r.detail);
      const onTable = plan.filter((d) => /mod_actions/.test(d));
      expect(onTable.length, plan.join(' | ')).toBe(2);
      for (const d of onTable) expect(d, plan.join(' | ')).toMatch(/^SEARCH mod_actions USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/);
    } finally { db.close(); }
  });

  it('a long trail is read once (at construction); later calls cost next to nothing and still see new names', async () => {
    const env = setup();
    await firstRun(env);
    const db = new DatabaseSync(env.dbPath);
    try {
      const add = actionWriter(db);
      db.exec('BEGIN');
      add(1, HOST_ACTOR_ID, 'EarlierHost', 'mute');
      for (let i = 0; i < 200_000; i++) add(2 + i, `acc${i % 97}`, `Mod${i % 97}`);
      db.exec('COMMIT');
    } finally { db.close(); }
    const ha = new HostAdmin({ dbPath: env.dbPath, now: () => env.clock.t, policy: () => env.policy, passwordParams: FAST });
    open.push(ha);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) expect(ha.hostAdminNames().has('earlierhost')).toBe(true);
    // Reading the whole trail each time took ~30 ms per call on a dev PC (600 ms here); now it is a few rowid lookups.
    expect(performance.now() - t0).toBeLessThan(150);
    const db2 = new DatabaseSync(env.dbPath);
    try { actionWriter(db2)(300_000, HOST_ACTOR_ID, 'LaterHost', 'kick'); } finally { db2.close(); }
    expect([...ha.hostAdminNames()].sort()).toEqual(['earlierhost', 'laterhost', 'novapilot']);
    expect(ha.isHostBanBy('LaterHost')).toBe(true);
    expect(ha.isHostBanBy('Mod3')).toBe(false);
  }, 60_000);

  it('a purged trail whose ids restart is read again; names once known stay known (fails closed)', async () => {
    const env = setup();
    await firstRun(env);
    env.run("UPDATE mod_actions SET actor_name = 'FirstName' WHERE action = 'setup'");
    env.ha.close(); // a fresh instance reads the edited row
    const ha = new HostAdmin({ dbPath: env.dbPath, now: () => env.clock.t, policy: () => env.policy, passwordParams: FAST });
    open.push(ha);
    expect(ha.hostAdminNames().has('firstname')).toBe(true);
    const count = env.sql<{ n: number }>('SELECT count(*) AS n FROM mod_actions')[0]!.n;
    // Everything purged, then as many rows again (the same ids, other rows): the newest id read is another row now.
    env.run('DELETE FROM mod_actions');
    const db = new DatabaseSync(env.dbPath);
    try {
      const add = actionWriter(db);
      for (let i = 1; i < count; i++) add(5_000 + i, 'acc1', 'Mod1');
      add(9_999, HOST_ACTOR_ID, 'SecondName', 'mute');
    } finally { db.close(); }
    expect(env.sql<{ n: number }>('SELECT count(*) AS n FROM mod_actions')[0]!.n).toBe(count);
    const names = ha.hostAdminNames();
    expect(names.has('secondname')).toBe(true);
    expect(names.has('firstname')).toBe(true);
  });
});

describe('setup: the username is checked again under the write lock', () => {
  it('a player who registers the chosen name while the password hashes: 400, nothing written, the code still works', async () => {
    const env = setup();
    await firstRun(env);
    const reset = resetHostAdminAt(env.dbPath, { pepper: env.pepper, now: env.clock.t });
    env.ha.reload();
    const pending = env.ha.setup({ setupCode: formatSetupCode(reset.setupCode), username: 'NewHostName', password: PASS }, HOST_PC);
    // setup() is now waiting on scrypt (its continuation needs the event loop): this insert lands inside that window.
    env.run(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at, status)
             VALUES ('acc-p1', 'NewHostName', 'newhostname', '', '#none:acc-p1', 'x', 1, 'active')`);
    const r = await pending;
    expect(r).toMatchObject({ ok: false, status: 400, error: ADMIN_ERR.playerName, field: 'username' });
    expect(env.sql('SELECT username, pass_hash FROM host_admins')).toEqual([{ username: 'NovaPilot', pass_hash: null }]);
    expect(env.ha.isReservedName('NewHostName')).toBe(false);
    expect(env.ha.state()).toMatchObject({ setupPending: true, setupKind: 'reset' });
    const again = await env.ha.setup({ setupCode: formatSetupCode(reset.setupCode), username: 'OtherHost', password: PASS }, HOST_PC);
    expect(again.ok).toBe(true);
  });

  it('first-run setup: the same (a name taken while the preset was applied)', async () => {
    const env = setup();
    const code = newSetupCode();
    env.ha.installLaunchCode(code);
    const input = { setupCode: formatSetupCode(code), username: 'NovaPilot', password: PASS, preset: 'home', serverName: 'Den' };
    const r = await env.ha.setup(input, HOST_PC, {
      apply: async () => {
        env.run(`INSERT INTO accounts (id, username, username_lower, email, email_lower, pass_hash, created_at, status)
                 VALUES ('acc-p2', 'NovaPilot', 'novapilot', '', '#none:acc-p2', 'x', 1, 'active')`);
        return { ok: true };
      },
    });
    expect(r).toMatchObject({ ok: false, status: 400, field: 'username' });
    expect(env.sql('SELECT id FROM host_admins')).toEqual([]);
    expect((await env.ha.setup({ ...input, username: 'HostOfDen' }, HOST_PC)).ok).toBe(true);
  });
});

describe('activity(): only a call that passed its checks counts', () => {
  it('authenticate as a poll changes nothing; activity slides idle and (while fresh) step-up; never moves a value back', async () => {
    const env = setup();
    const { token } = await firstRun(env);
    const poll = (): AdminSession => {
      const r = env.ha.authenticate(token, HOST_PC, { passive: true });
      if (!r.ok) throw new Error(r.error);
      return r.session;
    };
    const start = poll();
    env.clock.t += 9 * MIN;
    const s1 = poll();
    expect([s1.lastAction, s1.reauthAt, s1.fresh]).toEqual([start.lastAction, start.reauthAt, true]);
    const counted = env.ha.activity(s1);
    expect([counted.lastAction, counted.reauthAt]).toEqual([env.clock.t, env.clock.t]);
    env.clock.t += 9 * MIN;
    expect(poll().fresh).toBe(true); // slid by the counted call
    // A passive activity is nothing (a keep-alive poll only moves last_seen).
    env.clock.t += 2 * MIN;
    const s2 = poll();
    expect(env.ha.activity(s2, { passive: true })).toBe(s2);
    // Stale: a snapshot taken before a reauth never moves reauth_at back when it is counted after it.
    const stale = poll();
    expect(stale.fresh).toBe(false);
    expect((await env.ha.reauth(stale, PASS, HOST_PC)).ok).toBe(true);
    env.ha.activity(stale); // stale.reauthAt is the old value
    expect(poll().fresh).toBe(true);
    // A keep-alive poll on the host PC moves last_seen only.
    env.clock.t += 5 * MIN;
    const ka = env.ha.activity(poll(), { passive: true, keepAlive: true });
    expect([ka.lastSeen, ka.lastAction]).toEqual([env.clock.t, env.clock.t - 5 * MIN]);
  });
});

describe('refusals decided before HostAdmin are audited too', () => {
  it('auditRefusedAttempt: one row per address and kind per minute, with the count; setup off the host PC is audited', async () => {
    const env = setup();
    env.ha.auditRefusedAttempt('10.0.0.9', 'login', 403, 'Remote access to the control panel is off.');
    env.ha.auditRefusedAttempt('10.0.0.9', 'login', 403, 'Remote access to the control panel is off.');
    env.ha.auditRefusedAttempt('10.0.0.9', 'setup', 403, 'Setup only works on the host PC.');
    const r = await env.ha.setup({ setupCode: 'AAAA-AAAA', username: 'NovaPilot', password: PASS, preset: 'home', serverName: 'Den' }, lan('10.0.0.8'));
    expect(r).toMatchObject({ ok: false, status: 403, error: ADMIN_ERR.setupHostPc });
    env.ha.close(); // writes the folded count
    const rows = env.sql<{ action: string; actor_name: string; target_address: string | null; reason: string }>(
      'SELECT action, actor_name, target_address, reason FROM mod_actions ORDER BY id');
    expect(rows).toEqual([
      { action: 'login-fail', actor_name: '(unknown name)', target_address: '10.0.0.9', reason: 'sign-in refused (403): Remote access to the control panel is off.' },
      { action: 'login-fail', actor_name: '(setup)', target_address: '10.0.0.9', reason: 'setup refused (403): Setup only works on the host PC.' },
      { action: 'login-fail', actor_name: '(setup)', target_address: '10.0.0.8', reason: 'setup refused: not on the host PC via=https' },
      { action: 'login-fail', actor_name: '(unknown name)', target_address: '10.0.0.9', reason: 'sign-in refused (403): Remote access to the control panel is off. (+1 more refused since the last note)' },
    ]);
  });
});
