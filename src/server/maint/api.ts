// OWNER: SERVER MODERATION (LAN task B5). The panel's backup endpoints as [status, body] replies
// (docs/LAN-EDITION-proposal.md §5.14 Backups card, §5.15 "Settings, server and backups"), for moderation/http.ts to
// mount like settings/api.ts:
//   backups/list            {}                                   → { ok, backups, totalBytes, capBytes, … }       cap: backups
//   backups/create          {}                                   → { ok, backup } · 507 disk · 500 failed          cap: backups
//   backups/restore  (host PC) { backup, restoreConfig?, confirm } → 409 { needsConfirm } → { ok, pending, message }
//   backups/cancelRestore (host PC) {}                           → { ok, cancelled }
//   recovery/create  (host PC) { passphrase? }                   → { ok, fileName, fileBase64, words }  (words once)
//   backups/copyNow         {}                                   → { ok, requested }
//   db/compact  ★ (host PC) { confirm }                           → 409 { needsConfirm, estimateSec } → { ok, ms, … }
//                                        · 409 EBUSY { quietInMin } (a quiet window: nobody connected for 10 minutes)
// (backups/cancelRestore and db/compact are additions to §5.15: the Restore… dialog's Cancel, and §5.16 Compact.)
// The route table (capability, sensitive ★, hostPcOnly, body limit) lives in http.ts; these only parse and answer.
// maintAdminHandlers(svc) is the map to pass as AdminHttpOptions.handlers (http.ts still decides who may call what).
import type { AdminRouteHandler } from '../moderation/http';
import type { BackupInfo } from './backups';
import { MaintError } from './protocol';
import { RecoveryError } from './recovery';
import type { MaintService } from './service';

export type MaintHttpReply = [number, Record<string, unknown>];

const obj = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {});

/** A backup as the panel shows it (no file paths). */
export function backupRow(b: BackupInfo): Record<string, unknown> {
  return {
    name: b.name, reason: b.cls, detail: b.detail, createdAt: b.createdAt, size: b.size, encrypted: b.encrypted,
    ownKey: b.ownKey, needsRecovery: b.ownKey === false,
    // Dated later than this PC's clock (kept as it is; the clock-behind banner): the date its name gives.
    datedLater: b.future, stampAt: b.stampAt,
  };
}

/** backups/list. It answers panel polls on the game thread, so data\backups is listed once per reply. */
export function backupsListReply(svc: MaintService): MaintHttpReply {
  const list = svc.list();
  const st = svc.status({ list });
  return [200, {
    ok: true,
    backups: list.map(backupRow),
    totalBytes: st.backups.totalBytes, capBytes: st.backups.capBytes,
    lastBackupAt: st.backups.lastAt,
    disk: st.disk ? { freeBytes: st.disk.freeBytes, level: st.disk.level } : null,
    db: st.db,
    pendingRestore: st.pendingRestore, lastRestore: st.lastRestore,
    recovery: st.recovery ? { createdAt: st.recovery.createdAt, fileName: st.recovery.fileName } : null,
    offPc: st.offPc ? { at: st.offPc.at, error: st.offPc.error } : null,
    keyId: svc.keyId(),
    banners: svc.banners({ list }),
  }];
}

export async function backupsCreateReply(svc: MaintService, _body: unknown, actor: string): Promise<MaintHttpReply> {
  const r = await svc.backupNow('manual', { actor });
  if (r.ok) return [200, { ok: true, backup: { name: r.name, size: r.size, ms: r.ms, removed: r.removed } }];
  if ('skipped' in r) {
    if (r.skipped === 'disk') return [507, { error: r.text, code: 'disk' }];
    return [409, { error: r.text, code: r.skipped }];
  }
  if (r.code === 'ENOSPC') return [507, { error: r.error, code: 'disk' }];
  return [500, { error: r.error, code: r.code ?? 'failed' }];
}

export function backupsRestoreReply(svc: MaintService, body: unknown, actor: string): MaintHttpReply {
  const b = obj(body);
  if (b.confirm !== true) {
    return [409, {
      needsConfirm: true, backup: typeof b.backup === 'string' ? b.backup : null,
      error: 'Restoring replaces the accounts, chat log and records with the backup\'s (the current data is backed up first). Send confirm: true.',
    }];
  }
  const r = svc.stageRestore(b.backup, b.restoreConfig === true, actor);
  if (!r.ok) return [r.status, { error: r.error }];
  return [200, { ok: true, pending: r.pending, message: r.message }];
}

export function backupsCancelRestoreReply(svc: MaintService, _body: unknown, actor: string): MaintHttpReply {
  return [200, { ok: true, cancelled: svc.cancelRestore(actor) }];
}

export async function recoveryCreateReply(svc: MaintService, body: unknown, actor: string): Promise<MaintHttpReply> {
  const b = obj(body);
  const pass = typeof b.passphrase === 'string' && b.passphrase.trim() ? b.passphrase : null;
  try {
    const r = await svc.createRecovery(pass, actor);
    return [200, {
      ok: true, fileName: r.fileName, fileBase64: r.bytes.toString('base64'), words: r.words,
      note: r.words
        ? 'Write these 4 words down and keep them apart from the file. They are shown only now.'
        : 'Keep your passphrase apart from the file.',
    }];
  } catch (e) {
    if (e instanceof RecoveryError) return [400, { error: e.message, code: e.code }];
    return [500, { error: `The recovery file could not be made: ${String((e as Error)?.message ?? e)}` }];
  }
}

export function backupsCopyNowReply(svc: MaintService): MaintHttpReply {
  const requested = svc.requestCopy();
  return requested ? [200, { ok: true, requested: true }] : [409, { error: 'Set Settings → Backups → "Also copy backups to" first (a USB stick or a district share).' }];
}

export async function dbCompactReply(svc: MaintService, body: unknown, actor: string): Promise<MaintHttpReply> {
  const info = await svc.compactInfo();
  if (obj(body).confirm !== true) {
    return [409, {
      needsConfirm: true, estimateSec: info.estimateSec, quiet: info.quiet, quietInMin: info.quietInMin,
      error: `Compact takes about ${info.estimateSec} s and runs only after nobody has been connected for 10 minutes. Send confirm: true.`,
    }];
  }
  try {
    const r = await svc.compact(actor);
    return [200, { ok: true, ...r }];
  } catch (e) {
    const code = e instanceof MaintError ? e.code : 'EFAIL';
    if (code === 'EBUSY') {
      const now = await svc.compactInfo();
      return [409, { error: String((e as Error)?.message ?? e), code, quietInMin: now.quietInMin }];
    }
    return [code === 'EDISK' ? 507 : 500, { error: String((e as Error)?.message ?? e), code }];
  }
}

/** The actor string MaintService records ('host:<name>'), from the admin API's Actor ({ accountId: 'host', name }). */
export function maintActorOf(actor: { accountId: string; name: string } | null | undefined): string {
  if (!actor) return 'system';
  return `${actor.accountId || 'host'}:${actor.name || actor.accountId || 'host'}`.slice(0, 64);
}

/**
 * The moderation Actor for a MaintService audit event (MaintServiceOptions.audit → ModerationService.audit): the
 * part before the first ':' is the account id ('host', 'system', 'cli'), the rest the name.
 */
export function auditActorOf(actor: string): { accountId: string; name: string } {
  const s = String(actor ?? '').slice(0, 64) || 'system';
  const i = s.indexOf(':');
  return i > 0 ? { accountId: s.slice(0, i), name: s.slice(i + 1) || s.slice(0, i) } : { accountId: s, name: s };
}

/**
 * The backup endpoints as AdminHttpOptions.handlers (startServer: `handlers: { ...maintAdminHandlers(maint), … }`).
 * backups/cancelRestore and db/compact need their route entries in http.ts ADMIN_ROUTES too.
 */
export function maintAdminHandlers(svc: MaintService): Record<string, AdminRouteHandler> {
  return {
    'backups/list': () => backupsListReply(svc),
    'backups/create': (b, c) => backupsCreateReply(svc, b, maintActorOf(c.actor)),
    'backups/restore': (b, c) => backupsRestoreReply(svc, b, maintActorOf(c.actor)),
    'backups/cancelRestore': (b, c) => backupsCancelRestoreReply(svc, b, maintActorOf(c.actor)),
    'recovery/create': (b, c) => recoveryCreateReply(svc, b, maintActorOf(c.actor)),
    'backups/copyNow': () => backupsCopyNowReply(svc),
    'db/compact': (b, c) => dbCompactReply(svc, b, maintActorOf(c.actor)),
  };
}
