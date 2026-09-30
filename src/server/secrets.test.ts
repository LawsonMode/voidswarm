// data\secrets (docs/LAN-EDITION-proposal.md §2.4): the file store (atomic writes, random keys, fixed names), the
// in-memory store the child gets over IPC, the bundle, and the every-start check (POSIX modes / the ACL hook).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KEY_BYTES, SECRET_NAMES, SecretError, checkSecrets, checkSecretsAsync, decodeBundle, memorySecrets, openFileSecrets, prepareSecretsDir, secretsDir,
  type SecretName,
} from './secrets';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* still open */ } }
});
const tempData = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'voidswarm-secrets-'));
  dirs.push(d);
  return d;
};
const posix = process.platform !== 'win32';

describe('file secrets', () => {
  it('writes, reads and removes; nothing exists until the first write', () => {
    const data = tempData();
    const s = openFileSecrets(data);
    expect(existsSync(secretsDir(data))).toBe(false);
    expect(s.has('smtp.secret')).toBe(false);
    expect(s.readText('smtp.secret')).toBeNull();
    s.write('smtp.secret', 'app-password-Zq8');
    expect(s.readText('smtp.secret')).toBe('app-password-Zq8');
    s.write('smtp.secret', 'app-password-Zq9'); // atomic replace
    expect(s.readText('smtp.secret')).toBe('app-password-Zq9');
    s.write('tls/leaf.key', '-----BEGIN PRIVATE KEY-----\nMIGH\n-----END PRIVATE KEY-----\n');
    expect(existsSync(join(secretsDir(data), 'tls', 'leaf.key'))).toBe(true);
    expect(readdirSync(secretsDir(data)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(s.remove('smtp.secret')).toBe(true);
    expect(s.remove('smtp.secret')).toBe(false);
    expect(s.has('smtp.secret')).toBe(false);
  });

  it('refuses names outside the fixed list (no path tricks) and oversized values', () => {
    const s = openFileSecrets(tempData());
    for (const bad of ['../voidswarm.db', 'tls/../../x', 'pepper', '', 'PEPPER.KEY']) {
      expect(() => s.write(bad as SecretName, 'x')).toThrow(SecretError);
      expect(() => s.read(bad as SecretName)).toThrow(SecretError);
    }
    expect(() => s.write('smtp.secret', 'x'.repeat(64 * 1024 + 1))).toThrow(/at most/);
  });

  it('ensureKey makes a 32-byte key once; every store on the folder gets the same key', () => {
    const data = tempData();
    const a = openFileSecrets(data);
    const b = openFileSecrets(data);
    const k1 = a.ensureKey('pepper.key');
    expect(k1.length).toBe(KEY_BYTES);
    expect(b.ensureKey('pepper.key').equals(k1)).toBe(true);
    expect(a.ensureKey('pepper.key').equals(k1)).toBe(true);
    expect(a.ensureKey('backup.key').equals(k1)).toBe(false);
    expect(statSync(join(secretsDir(data), 'pepper.key')).size).toBe(KEY_BYTES);
    expect(() => a.ensureKey('smtp.secret')).toThrow(/not a random key/);
    expect(readdirSync(secretsDir(data)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a damaged key (wrong size) is reported, never silently replaced', () => {
    const data = tempData();
    mkdirSync(secretsDir(data), { recursive: true });
    writeFileSync(join(secretsDir(data), 'backup.key'), Buffer.alloc(7));
    const s = openFileSecrets(data);
    expect(() => s.ensureKey('backup.key')).toThrow(/damaged/);
    expect(statSync(join(secretsDir(data), 'backup.key')).size).toBe(7);
    expect(checkSecrets(data, { platform: 'win32', aclCheck: () => [] }).problems)
      .toEqual([{ what: join('secrets', 'backup.key'), why: 'damaged: 7 bytes instead of 32' }]);
  });

  it('calls protectDir once for each folder it creates', () => {
    const data = tempData();
    const made: string[] = [];
    const s = openFileSecrets(data, { protectDir: (d) => made.push(d) });
    s.ensureKey('pipe.key');
    s.write('tls/issuing.key', 'pem');
    s.write('tls/leaf.key', 'pem');
    s.write('smtp.secret', 'x');
    expect(made).toEqual([secretsDir(data), join(secretsDir(data), 'tls')]);
  });

  it('prepareSecretsDir creates both folders and awaits the (async) protection of each before any write', async () => {
    const data = tempData();
    const order: string[] = [];
    const r = await prepareSecretsDir(data, {
      protectDir: async (d) => {
        await new Promise((res) => setTimeout(res, 5));
        order.push(d);
        return d.endsWith('tls') ? 'icacls could not protect tls' : null;
      },
    });
    expect(r.created).toEqual([secretsDir(data), join(secretsDir(data), 'tls')]);
    expect(order).toEqual(r.created);
    expect(r.errors).toEqual(['icacls could not protect tls']);
    // the store then writes into the prepared folders without creating (or protecting) anything again
    const made: string[] = [];
    openFileSecrets(data, { protectDir: (d) => made.push(d) }).write('tls/leaf.key', 'pem');
    expect(made).toEqual([]);
    // a second run: nothing to create, nothing protected again
    const again = await prepareSecretsDir(data, { protectDir: () => { throw new Error('not again'); } });
    expect(again).toEqual({ created: [], errors: [] });
    // a throwing hook is reported, not fatal
    const d2 = tempData();
    expect((await prepareSecretsDir(d2, { protectDir: () => { throw new Error('no icacls'); } })).errors[0]).toMatch(/no icacls/);
  });

  it('a memory store (the child) can write through to the file store', () => {
    const data = tempData();
    const file = openFileSecrets(data);
    const mem = memorySecrets(file.exportBundle(), { onChange: (n, v) => { if (v) file.write(n, v); else file.remove(n); } });
    mem.write('smtp.secret', 'through-Pw4');
    expect(file.readText('smtp.secret')).toBe('through-Pw4');
    mem.remove('smtp.secret');
    expect(file.has('smtp.secret')).toBe(false);
  });

  it.skipIf(!posix)('POSIX: folders 0700 and files 0600', () => {
    const data = tempData();
    const s = openFileSecrets(data);
    s.ensureKey('pepper.key');
    s.write('tls/leaf.key', 'pem');
    expect(statSync(secretsDir(data)).mode & 0o777).toBe(0o700);
    expect(statSync(join(secretsDir(data), 'pepper.key')).mode & 0o777).toBe(0o600);
    expect(statSync(join(secretsDir(data), 'tls', 'leaf.key')).mode & 0o777).toBe(0o600);
    expect(checkSecrets(data).ok).toBe(true);
  });
});

describe('checkSecrets', () => {
  it('no folder yet is fine', () => {
    expect(checkSecrets(tempData(), { platform: 'win32' })).toMatchObject({ ok: true, method: 'unchecked' });
  });

  it('Windows: the launcher\'s ACL check decides (and is passed the folder)', () => {
    const data = tempData();
    openFileSecrets(data).ensureKey('pepper.key');
    const asked: string[] = [];
    const bad = checkSecrets(data, { platform: 'win32', aclCheck: (d) => { asked.push(d); return ['Authenticated Users can read it']; } });
    expect(asked).toEqual([secretsDir(data)]);
    expect(bad).toMatchObject({ ok: false, method: 'acl', problems: [{ what: 'secrets', why: 'Authenticated Users can read it' }] });
    expect(checkSecrets(data, { platform: 'win32', aclCheck: () => [] })).toMatchObject({ ok: true, method: 'acl' });
  });

  it("Windows: the launcher's async ACL check (src/lan/acl.ts runs icacls) works through checkSecretsAsync", async () => {
    const data = tempData();
    expect(await checkSecretsAsync(data, { platform: 'win32', aclCheck: async () => ['never asked'] })).toMatchObject({ ok: true, method: 'acl' });
    openFileSecrets(data).ensureKey('pepper.key');
    const asked: string[] = [];
    const bad = await checkSecretsAsync(data, {
      platform: 'win32',
      aclCheck: async (d) => { asked.push(d); await new Promise((r) => setTimeout(r, 5)); return ['Authenticated Users can read it']; },
    });
    expect(asked).toEqual([secretsDir(data)]);
    expect(bad).toMatchObject({ ok: false, method: 'acl', problems: [{ what: 'secrets', why: 'Authenticated Users can read it' }] });
    expect(await checkSecretsAsync(data, { platform: 'win32', aclCheck: async () => [] })).toMatchObject({ ok: true, method: 'acl' });
    expect(await checkSecretsAsync(data, { platform: 'win32', aclCheck: () => [] })).toMatchObject({ ok: true, method: 'acl' });
    // a check that fails is a problem (the protection is unknown), and a damaged key is still reported
    writeFileSync(join(secretsDir(data), 'backup.key'), Buffer.alloc(3));
    const failed = await checkSecretsAsync(data, { platform: 'win32', aclCheck: async () => { throw new Error('icacls is blocked'); } });
    expect(failed.ok).toBe(false);
    expect(failed.problems.map((p) => p.why)).toEqual(['damaged: 3 bytes instead of 32', 'its permissions could not be checked: icacls is blocked']);
  });

  it.skipIf(!posix)('POSIX: a readable folder or file is a problem; fix: true repairs it', () => {
    const data = tempData();
    const s = openFileSecrets(data);
    s.ensureKey('pepper.key');
    chmodSync(secretsDir(data), 0o755);
    chmodSync(join(secretsDir(data), 'pepper.key'), 0o644);
    const r = checkSecrets(data);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.what)).toEqual(['secrets', join('secrets', 'pepper.key')]);
    expect(checkSecrets(data, { fix: true }).ok).toBe(true);
    expect(statSync(join(secretsDir(data), 'pepper.key')).mode & 0o777).toBe(0o600);
  });
});

describe('the IPC bundle and the memory store', () => {
  it('round-trips every secret; the memory store reports changes', () => {
    const data = tempData();
    const file = openFileSecrets(data);
    const pepper = file.ensureKey('pepper.key');
    file.write('smtp.secret', 'bundle-pw-7');
    const bundle = file.exportBundle();
    expect(Object.keys(bundle.secrets).sort()).toEqual(['pepper.key', 'smtp.secret']);
    const changes: [string, string | null][] = [];
    const mem = memorySecrets(decodeBundle(JSON.parse(JSON.stringify(bundle))), {
      onChange: (n, v) => changes.push([n, v ? v.toString('utf8') : null]),
    });
    expect(mem.dir).toBeNull();
    expect(mem.read('pepper.key')!.equals(pepper)).toBe(true);
    expect(mem.ensureKey('pepper.key').equals(pepper)).toBe(true);
    expect(mem.readText('smtp.secret')).toBe('bundle-pw-7');
    mem.write('smtp.secret', 'bundle-pw-8');
    mem.remove('smtp.secret');
    expect(changes).toEqual([['smtp.secret', 'bundle-pw-8'], ['smtp.secret', null]]);
    expect(mem.ensureKey('backup.key').length).toBe(KEY_BYTES);
    expect(mem.exportBundle(['pepper.key']).secrets).toEqual({ 'pepper.key': pepper.toString('base64') });
  });

  it('decodeBundle refuses unknown names, bad base64 and other versions', () => {
    expect(() => decodeBundle({ v: 1, secrets: { '../x': 'AA==' } })).toThrow(SecretError);
    expect(() => decodeBundle({ v: 1, secrets: { 'pepper.key': 'not base64!' } })).toThrow(SecretError);
    expect(() => decodeBundle({ v: 2, secrets: {} })).toThrow(SecretError);
    expect(() => decodeBundle(null)).toThrow(SecretError);
    expect(decodeBundle({ v: 1, secrets: {} })).toEqual({ v: 1, secrets: {} });
  });

  it('knows exactly the §2.4 secrets', () => {
    expect([...SECRET_NAMES]).toEqual(['pepper.key', 'backup.key', 'pipe.key', 'smtp.secret', 'tls/issuing.key', 'tls/leaf.key']);
  });
});
