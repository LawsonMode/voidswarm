// LAN task B5: the recovery file (T-BAK-1 "recovery"; docs/LAN-EDITION-proposal.md §6.3).
import { describe, expect, it } from 'vitest';
import { filterChat } from '../../shared/moderation/filter';
import { memorySecrets } from '../secrets';
import { keyIdOf, PEPPER_ID_LABEL } from './format';
import {
  createRecovery, decryptRecovery, encryptRecovery, generatePassphrase, normalizePassphrase, passphraseProblem, recoveryBanner,
  recoveryFileName, RecoveryError, type RecoveryContents,
} from './recovery';
import { key32 } from './testutil';

const DAY = 86_400_000;
const FAST = { log2N: 12 };

describe('T-BAK-1: the recovery file', () => {
  it('holds the pepper, the backup key, the SMTP password and the install id — never a certificate key', async () => {
    const pepper = key32();
    const backupKey = key32();
    const secrets = memorySecrets({
      'pepper.key': pepper, 'backup.key': backupKey, 'pipe.key': key32(), 'smtp.secret': 'smtp-test-password-4471',
      'tls/issuing.key': '-----BEGIN PRIVATE KEY-----\nISSUING-KEY-MATERIAL\n-----END PRIVATE KEY-----', 'tls/leaf.key': 'LEAF-KEY-MATERIAL',
    });
    const now = new Date(2026, 8, 28, 9, 0).getTime();
    const made = await createRecovery({ secrets, serverName: 'Room 136 (Mr. O\'Brien)', installId: '0123456789abcdef', now });
    expect(made.fileName).toBe('voidswarm-recovery-room-136-mr-o-brien-2026-09-28.vsrec');
    expect(made.words).toMatch(/^[a-z]{5}( [a-z]{5}){3}$/);
    const raw = made.bytes.toString('latin1');
    for (const s of ['ISSUING-KEY', 'LEAF-KEY', 'smtp-test-password', 'Room 136', '0123456789abcdef']) expect(raw).not.toContain(s);
    expect(made.bytes.subarray(0, 5).toString('latin1')).toBe('VSRC1');
    expect(made.bytes[6]).toBe(17); // scrypt N = 2^17

    // Typed back with other spacing, hyphens or capitals, the words still open it.
    const typed = made.words!.toUpperCase().replace(/ /g, ' - ');
    const c = await decryptRecovery(made.bytes, typed.replace(/ - /g, '-'));
    expect(c).toMatchObject({ serverName: 'Room 136 (Mr. O\'Brien)', installId: '0123456789abcdef', smtpPassword: 'smtp-test-password-4471' });
    expect(Buffer.from(c.pepper!, 'base64').equals(pepper)).toBe(true);
    expect(Buffer.from(c.backupKey!, 'base64').equals(backupKey)).toBe(true);
    expect(Object.keys(c).sort()).toEqual(['backupKey', 'createdAt', 'installId', 'pepper', 'serverName', 'smtpPassword', 'v']);
    expect(made.state).toMatchObject({ backupKeyId: keyIdOf(backupKey), pepperKeyId: keyIdOf(pepper, PEPPER_ID_LABEL), smtp: true });

    await expect(decryptRecovery(made.bytes, 'bakor tuvim lesap niror')).rejects.toMatchObject({ code: 'EPASS' });
    const changed = Buffer.from(made.bytes);
    changed[changed.length - 20] ^= 1;
    await expect(decryptRecovery(changed, made.words!)).rejects.toMatchObject({ code: 'EPASS' });
    await expect(decryptRecovery(Buffer.from('VSBK1 not a recovery file at all........................'), 'x')).rejects.toMatchObject({ code: 'EFORMAT' });
  });

  it('an own passphrase needs 16 characters or more', async () => {
    expect(passphraseProblem('short one')).toMatch(/16 characters/);
    expect(passphraseProblem('   ')).toMatch(/16 characters/);
    expect(passphraseProblem('correct horse battery staple')).toBeNull();
    expect(passphraseProblem('ÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉ')).toBeNull(); // 16 characters, more bytes
    const secrets = memorySecrets({ 'pepper.key': key32(), 'backup.key': key32() });
    await expect(createRecovery({ secrets, serverName: 'x', installId: '', passphrase: 'too short' })).rejects.toBeInstanceOf(RecoveryError);
    const own = await createRecovery({ secrets, serverName: 'x', installId: '', passphrase: 'Room136 vault, phrase 2026', crypto: FAST });
    expect(own.words).toBeNull();
    await expect(decryptRecovery(own.bytes, '  Room136   vault, phrase 2026 ')).resolves.toMatchObject({ serverName: 'x', smtpPassword: null });
    await expect(decryptRecovery(own.bytes, 'room136 vault, phrase 2026')).rejects.toMatchObject({ code: 'EPASS' });
    // Four plain words (the generated form) are read without regard to case or hyphens, like the generated words.
    const four = await createRecovery({ secrets, serverName: 'x', installId: '', passphrase: 'Our District Vault Phrase', crypto: FAST });
    await expect(decryptRecovery(four.bytes, 'our-district-vault-phrase')).resolves.toMatchObject({ serverName: 'x' });
  });

  it('generated words are pronounceable, distinct, and never caught by the chat filter', () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassphrase();
      const words = p.split(' ');
      expect(words).toHaveLength(4);
      expect(new Set(words).size).toBe(4);
      for (const w of words) {
        expect(w).toMatch(/^[bdfghjklmnprstvz][aeiou][bdfghjklmnprstvz][aeiou][bdfghjklmnprstvz]$/);
        expect(filterChat(w, { custom: null }).action).toBe('pass');
      }
      expect(normalizePassphrase(p)).toBe(p);
    }
  });

  it('refuses files with scrypt parameters outside the safe range (a crafted file cannot make it run for hours)', async () => {
    const c: RecoveryContents = { v: 1, createdAt: 1, serverName: 's', installId: '', pepper: null, backupKey: null, smtpPassword: null };
    const buf = await encryptRecovery(c, 'a long enough passphrase', FAST);
    const evil = Buffer.from(buf);
    evil[6] = 30;
    await expect(decryptRecovery(evil, 'a long enough passphrase')).rejects.toMatchObject({ code: 'EFORMAT' });
    // The verifier's crafted file: N = 2^20, r = 16, p = 4 (~2 GiB of scrypt memory, 64x the work) is refused at once;
    // so is any r / p this version doesn't write, and N above 2^18.
    for (const [i, v] of [[6, 20], [6, 19], [7, 16], [7, 1], [8, 4], [8, 2]] as const) {
      const bad = Buffer.from(buf);
      bad[i] = v;
      const t = Date.now();
      await expect(decryptRecovery(bad, 'a long enough passphrase'), `byte ${i} = ${v}`).rejects.toMatchObject({ code: 'EFORMAT' });
      expect(Date.now() - t).toBeLessThan(500);
    }
    await expect(encryptRecovery(c, 'a long enough passphrase', { log2N: 20 })).rejects.toThrow(RangeError);
  });

  it('the banner: until one exists, when a key it holds was replaced, yearly, and 14 days before the term ends', () => {
    const bk = key32();
    const pk = key32();
    const now = new Date(2026, 8, 28, 12, 0).getTime();
    expect(recoveryBanner(null, { now })?.code).toBe('recovery-missing');
    const state = { v: 1, createdAt: now - 10 * DAY, fileName: 'f.vsrec', backupKeyId: keyIdOf(bk), pepperKeyId: keyIdOf(pk, PEPPER_ID_LABEL), smtp: false };
    expect(recoveryBanner(state, { now, backupKey: bk, pepper: pk })).toBeNull();
    expect(recoveryBanner(state, { now, backupKey: key32(), pepper: pk })?.code).toBe('recovery-stale');
    expect(recoveryBanner({ ...state, createdAt: now - 400 * DAY }, { now, backupKey: bk, pepper: pk })?.code).toBe('recovery-yearly');
    expect(recoveryBanner(state, { now, backupKey: bk, pepper: pk, termEnd: '2026-10-05' })?.code).toBe('recovery-term');
    expect(recoveryBanner(state, { now, backupKey: bk, pepper: pk, termEnd: '2026-12-18' })).toBeNull();
    expect(recoveryBanner(state, { now, backupKey: bk, pepper: pk, termEnd: '2026-09-01' })).toBeNull();
  });

  it('file names are plain ASCII whatever the server is called', () => {
    const at = new Date(2026, 0, 5).getTime();
    expect(recoveryFileName('Caldwell High · Room 136 — Pilots!', at)).toBe('voidswarm-recovery-caldwell-high-room-136-pilots-2026-01-05.vsrec');
    expect(recoveryFileName('', at)).toBe('voidswarm-recovery-voidswarm-2026-01-05.vsrec');
    expect(recoveryFileName('Émilie’s Class', at)).toBe('voidswarm-recovery-emilie-s-class-2026-01-05.vsrec');
  });
});
