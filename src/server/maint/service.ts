// OWNER: SERVER MODERATION (LAN task B5). MaintService: the server's maintenance, on the game thread only as a
// scheduler (docs/LAN-EDITION-proposal.md §5.16, §6). It owns the worker client (client.ts), runs the start backup
// before the listener opens (the migration comes after it, §2.2 step 10), the daily backup and the FTS optimize in
// quiet windows (schedule.ts), the hourly disk check, the panel's backup / restore-stage / recovery calls (api.ts),
// and the banners they raise. It never touches the game's own connections.
//
// Wiring (startServer, B1 / B6 / B15): MaintService.start({ dataDir, secrets, settings: () => …, connections, onBackup,
// audit }) → const r = await svc.startupBackup({ migration: plan }) with plan = migrationPlan(dbPath) BEFORE
// new AuthStore(...) → if migrationBackupProblem(r, plan) is a text, DON'T open the store (it would migrate with no
// backup, against §2.2 step 10): print it and stop → svc.startTimers() once listening → await svc.stop() in the
// flush-first shutdown (before the DB closes). The panel: AdminHttpOptions.handlers gets maintAdminHandlers(svc) and
// `banners` gets svc.banners(); `audit: (e) => mod.audit(auditActorOf(e.actor), e.action, null, e.reason)` (api.ts).
// The retention caps run at start, around every backup (made or not), and hourly with the disk check, so nothing is
// kept past 35 days with daily backups off, skipped for low disk, or failing. A daily backup that was skipped or
// failed backs off (schedule.ts dailyRetryDelay), and a repeated problem is logged once.
import * as fs from 'node:fs';
import path from 'node:path';
import {
  applyRetention, backupTotals, cleanupBackupTemp, clockBanner, createBackup, DB_FILE, ensureOffPcState, lastBackupAt, lastDailyAt, listBackups, offPcBanner,
  readOffPcState, startBackupReason, type BackupInfo, type CreateBackupResult, type OffPcState,
} from './backups';
import { MaintClient, type MaintClientOptions } from './client';
import { checkDisk, dbFileBytes, dbSizeBanner, diskBanners, type Banner, type DiskStatus, type StatfsFn } from './disk';
import { keyIdOf, pepperIdOf } from './format';
import type { BackupReason } from './names';
import { COMPACT_BYTES_PER_MS } from './ops';
import { readPreviousPeppers } from './peppers';
import { MaintError } from './protocol';
import { createRecovery, readRecoveryState, recoveryBanner, writeRecoveryState, type RecoveryState } from './recovery';
import {
  asideDbBanner, cancelPendingRestore, cleanupRestoreStaging, listAsideDbs, pruneAsideDbs, readLastRestore, readPendingRestore, recoverInterruptedRestore,
  stageRestore, type LastRestore, type PendingRestore, type StageResult,
} from './restoreStage';
import { dailyClass } from './retention';
import type { HostSettings } from '../settings/schema';
import { dailyRetryDelay, dueTasks, isQuiet, QUIET_MS, STOP_OPTIMIZE_MAX_MS, TICK_MS, type MaintTask } from './schedule';

/** The settings MaintService reads (a view of HostSettings, read at each use). */
export interface MaintSettingsView {
  backups: { daily: boolean; copyTo: string; sizeCapMB: number };
  serverName: string;
  installId: string;
  /** settings.chat.retention.termEnd (the recovery reminder 14 days before it) */
  termEnd?: string | number | null;
}

/** The view from the settings service: `settings: () => maintSettingsFrom(settingsService.get())`. */
export function maintSettingsFrom(s: Pick<HostSettings, 'backups' | 'serverName' | 'installId'> & { chat?: { retention?: { termEnd?: string | null } } }): MaintSettingsView {
  return {
    backups: { daily: s.backups.daily, copyTo: s.backups.copyTo, sizeCapMB: s.backups.sizeCapMB },
    serverName: s.serverName, installId: s.installId, termEnd: s.chat?.retention?.termEnd ?? null,
  };
}

export interface MaintSecrets {
  read(name: 'backup.key' | 'pepper.key'): Buffer | null;
  readText(name: 'smtp.secret'): string | null;
  /** data\secrets (SecretStore.dir): where the peppers a restore replaced are kept (pepper.previous.json) */
  readonly dir?: string | null;
}

export interface MaintAuditEvent {
  action: 'backup' | 'restore' | 'recovery';
  actor: string;
  reason: string;
}

/** What MaintService needs from the worker client (MaintClient; tests pass fakes). */
export type MaintRunner = Pick<MaintClient, 'call' | 'setConfig' | 'close'> & { failed?: string | null };

export interface MaintServiceOptions {
  dataDir: string;
  dbPath?: string;
  secrets: MaintSecrets;
  settings: () => MaintSettingsView;
  appVersion?: string;
  log?: (line: string) => void;
  now?: () => number;
  /** people connected right now (the quiet windows) */
  connections?: () => number;
  /** after every successful backup: the launcher copies it off the PC (the child can't write there) */
  onBackup?: (b: { name: string; file: string; reason: BackupReason }) => void;
  /** "Copy now": ask the launcher to run the off-PC copy */
  onCopyRequest?: () => boolean;
  /** audit rows (mod_actions: backup, restore, recovery) */
  audit?: (e: MaintAuditEvent) => void;
  statfs?: StatfsFn;
  /** the worker client (default: MaintClient.start with `worker`); null = no worker (backups run in-thread) */
  runner?: MaintRunner | null;
  worker?: Partial<MaintClientOptions>;
  /** the scheduler's period (default 60 s); 0 = no timer (tests call tick()) */
  tickMs?: number;
}

export interface MaintStatus {
  disk: DiskStatus | null;
  /** the database file and its -wal (the Server panel's "DB and WAL size") */
  db: { bytes: number; walBytes: number };
  backups: { count: number; totalBytes: number; capBytes: number; newest: BackupInfo | null; last: CreateBackupResult | null; lastAt: number | null };
  pendingRestore: PendingRestore | null;
  lastRestore: LastRestore | null;
  recovery: RecoveryState | null;
  offPc: OffPcState | null;
  worker: { ok: boolean; error: string | null };
  indexTidyPending: boolean;
}

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

/**
 * Why the pending migration must NOT run (§2.2 step 10 "the migration, after an encrypted backup"): the start
 * backup before it was skipped (low disk) or failed. Null when there is no migration or the backup was made.
 * startServer (B1) prints it and stops instead of opening the auth store.
 */
export function migrationBackupProblem(r: CreateBackupResult | null, migration: { from: number; to: number } | null | undefined): string | null {
  if (!migration) return null;
  if (r?.ok) return null;
  const why = !r ? 'no backup was made' : 'skipped' in r ? r.text : r.error;
  return `The database must be upgraded (v${migration.from} → v${migration.to}), and the backup that has to come first could not be made: ${why} `
    + 'Nothing was changed. Free some space on the data drive (or fix the problem above), then start Voidswarm again.';
}

export class MaintService {
  readonly dataDir: string;
  readonly dbPath: string;
  private readonly opts: MaintServiceOptions;
  private runner: MaintRunner | null;
  private runnerError: string | null = null;
  private disk: DiskStatus | null = null;
  private lastDiskAt: number | null = null;
  private last: CreateBackupResult | null = null;
  private lastSkip: Banner | null = null;
  private lastFail: Banner | null = null;
  private lastBusyAt: number | null = null;
  private indexDirty = false;
  /** skipped / failed daily backups in a row, and when the next one may be tried */
  private dailyFails = 0;
  private dailyRetryAt: number | null = null;
  /** the last problem line logged (a repeat isn't logged again) */
  private lastProblemLog: string | null = null;
  private migrationProblem: string | null = null;
  private readonly startedAt: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<MaintTask[]> | null = null;
  private stopped = false;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  private constructor(opts: MaintServiceOptions, runner: MaintRunner | null, runnerError: string | null) {
    this.opts = opts;
    this.dataDir = opts.dataDir;
    this.dbPath = opts.dbPath ?? path.join(opts.dataDir, DB_FILE);
    this.runner = runner;
    this.runnerError = runnerError;
    this.log = opts.log ?? (() => undefined);
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** Start the worker (a failure is logged and shown; backups then run in-thread) and check the disk. */
  static async start(opts: MaintServiceOptions): Promise<MaintService> {
    // Before anything opens the database: a restore's swap that a crash interrupted (the LAN launcher does this too;
    // this covers the npm / VPS path).
    try {
      const note = recoverInterruptedRestore(opts.dataDir, { now: (opts.now ?? Date.now)() });
      if (note) opts.log?.(`[maint] ${note}`);
    } catch { /* next start */ }
    let runner: MaintRunner | null = null;
    let error: string | null = null;
    if (opts.runner !== undefined) runner = opts.runner;
    else {
      const s = opts.settings();
      try {
        let pepper: Buffer | null = null;
        try { pepper = opts.secrets.read('pepper.key'); } catch { /* the ledger then uses its account ids only */ }
        runner = await MaintClient.start({
          dataDir: opts.dataDir, dbPath: opts.dbPath, backupKey: opts.secrets.read('backup.key'), sizeCapMB: s.backups.sizeCapMB,
          installId: s.installId, appVersion: opts.appVersion ?? '', pepper, previousPeppers: readPreviousPeppers(opts.secrets.dir), log: opts.log,
          ...opts.worker,
        });
      } catch (e) {
        error = errMsg(e);
        opts.log?.(`[maint] the maintenance worker did not start (${error}); backups run on the server thread`);
      }
    }
    const svc = new MaintService(opts, runner, error);
    try { cleanupBackupTemp(svc.dataDir, svc.now()); } catch { /* next time */ }
    // A restore killed after decrypting left the whole database in plain text: no restore runs while a host does.
    if (cleanupRestoreStaging(svc.dataDir)) svc.log('[maint] removed the leftover data\\restore.staging of an interrupted restore');
    // The off-PC banner's clock (30 days from the first start until the first copy).
    try { ensureOffPcState(svc.dataDir, svc.now()); } catch { /* the banner falls back to the backups' age */ }
    svc.retention();
    await svc.checkDisk();
    if (runner && fs.existsSync(svc.dbPath)) {
      try {
        const st = await runner.call<{ indexTidyPending?: boolean }>('db.stats', undefined, { timeoutMs: 10_000 });
        svc.indexDirty = st?.indexTidyPending === true;
      } catch { /* an older database (no chat log yet): nothing to tidy */ }
    }
    return svc;
  }

  /** Start the minute timer (after the listener is open). */
  startTimers(): void {
    const ms = this.opts.tickMs ?? TICK_MS;
    if (this.timer || ms <= 0 || this.stopped) return;
    this.timer = setInterval(() => { void this.tick(); }, ms);
    this.timer.unref?.();
  }

  private key(): Buffer | null {
    try { return this.opts.secrets.read('backup.key'); } catch { return null; }
  }

  private pepper(): Buffer | null {
    try { return this.opts.secrets.read('pepper.key'); } catch { return null; }
  }

  /**
   * This install's own backups (made with its backup key), for the schedule: another install's, copied into
   * data\backups to bring its data across (§6.3), never stand in for a start or daily backup of this one. With no
   * readable key every backup counts.
   */
  private ownBackups(now: number): BackupInfo[] {
    return listBackups(this.dataDir, { key: this.key(), now }).filter((b) => b.ownKey !== false);
  }

  /** The age and size caps on data\backups now, on this thread (a directory listing; cheap). Never throws. */
  private retention(): string[] {
    this.pruneAside();
    try {
      const removed = applyRetention(this.dataDir, { now: this.now(), sizeCapMB: this.opts.settings().backups.sizeCapMB, key: this.key() });
      if (removed.length) this.log(`[maint] removed ${removed.length} backup(s) past the retention caps`);
      return removed;
    } catch (e) {
      this.log(`[maint] the retention pass failed: ${errMsg(e)}`);
      return [];
    }
  }

  /**
   * The database files a restore moved aside (data\unreadable-db-<stamp>\: plaintext, out of the deletion ledger's
   * reach) go after 35 days, like the backups (§4.13, §8.1). At start and hourly. Never throws.
   */
  private pruneAside(): void {
    try {
      const removed = pruneAsideDbs(this.dataDir, this.now());
      if (removed.length) this.log(`[maint] removed ${removed.length} folder(s) of database files a restore had kept aside for 35 days`);
    } catch { /* the next pass */ }
  }

  /** The hourly retention pass: in the worker's backup queue when it runs (never beside a backup), else here. */
  private async retentionHourly(): Promise<void> {
    this.pruneAside();
    if (this.runner) {
      try {
        const r = await this.runner.call<{ removed: string[] }>('backup.retention', { now: this.now() }, { timeoutMs: 60_000 });
        if (r?.removed?.length) this.log(`[maint] removed ${r.removed.length} backup(s) past the retention caps`);
        return;
      } catch (e) {
        if (!(e instanceof MaintError && e.code === 'EWORKER')) { this.log(`[maint] the retention pass failed: ${errMsg(e)}`); return; }
      }
    }
    this.retention();
  }

  /** Log a problem line unless it repeats the last one. */
  private logProblem(line: string): void {
    if (line === this.lastProblemLog) return;
    this.lastProblemLog = line;
    this.log(line);
  }

  private async checkDisk(): Promise<DiskStatus> {
    const d = await checkDisk(this.dataDir, { statfs: this.opts.statfs, now: this.now() });
    if (this.disk?.level !== d.level && (d.level === 'low' || d.level === 'critical')) this.log(`[maint] ${diskBanners(d)[0]?.text ?? 'low disk'}`);
    this.disk = d;
    this.lastDiskAt = d.checkedAt;
    return d;
  }

  private remember(r: CreateBackupResult, reason: BackupReason, actor: string): CreateBackupResult {
    this.last = r;
    if (r.ok) {
      this.lastSkip = null;
      this.lastFail = null;
      this.lastProblemLog = null;
      this.log(`[maint] backup ${r.name} (${Math.round(r.size / 1024)} KB, ${r.ms} ms)${r.removed.length ? `; removed ${r.removed.length} old backup(s)` : ''}`);
      try { this.opts.audit?.({ action: 'backup', actor, reason: `${reason}: ${r.name}` }); } catch { /* audit is best effort */ }
      try { this.opts.onBackup?.({ name: r.name, file: r.file, reason }); } catch (e) { this.log(`[maint] off-PC copy hook failed: ${errMsg(e)}`); }
    } else if ('skipped' in r) {
      if (r.skipped === 'disk') {
        this.lastSkip = { code: 'backup-skipped', level: 'warn', text: `A backup was skipped: ${r.text}` };
        this.logProblem(`[maint] backup skipped: ${r.text}`);
      }
    } else {
      this.lastFail = { code: 'backup-failed', level: 'urgent', text: `${r.error} Check the free space on the data drive, then use Server → Backups → Back up now.` };
      this.logProblem(`[maint] backup failed: ${r.error}`);
    }
    return r;
  }

  private async run(reason: BackupReason, detail: string | null, actor: string, opts: { inThread?: boolean } = {}): Promise<CreateBackupResult> {
    const key = this.key();
    if (!key) return this.remember({ ok: false, error: 'There is no backup key (data\\secrets\\backup.key).', code: 'ENOKEY' }, reason, actor);
    const disk = await this.checkDisk();
    const s = this.opts.settings();
    const pepper = this.pepper();
    if (this.runner && !opts.inThread) {
      this.runner.setConfig({ backupKey: key, sizeCapMB: s.backups.sizeCapMB, installId: s.installId, pepper });
      try {
        const r = await this.runner.call<CreateBackupResult>('backup.create', { reason, detail, now: this.now() });
        return this.remember(r, reason, actor);
      } catch (e) {
        if (!(e instanceof MaintError && e.code === 'EWORKER')) return this.remember({ ok: false, error: `The backup failed: ${errMsg(e)}` }, reason, actor);
        this.log(`[maint] the worker is down (${errMsg(e)}); backing up on the server thread`);
      }
    }
    return this.remember(await createBackup({
      dataDir: this.dataDir, dbPath: this.dbPath, key, reason, detail, now: this.now(), appVersion: this.opts.appVersion ?? '',
      installId: s.installId, sizeCapMB: s.backups.sizeCapMB, disk, pepperId: pepper ? pepperIdOf(pepper) : null,
    }), reason, actor);
  }

  /**
   * §6.1 "at start, when a migration is pending or the last backup is more than 6 h old", and §2.2 step 10 "the
   * migration, after an encrypted backup": call BEFORE the auth store opens (and migrates). `migration` is
   * auth/store.ts migrationPlan(dbPath). Runs on this thread (nothing else is running yet). Null = not needed.
   */
  async startupBackup(o: { migration?: { from: number; to: number } | null } = {}): Promise<CreateBackupResult | null> {
    const dbExists = fs.existsSync(this.dbPath);
    const reason = startBackupReason({
      migrationPending: !!o.migration, lastBackupAt: lastBackupAt(this.ownBackups(this.now())), now: this.now(), dbExists,
    });
    const r = reason ? await this.run(reason, reason === 'pre-migration' && o.migration ? `v${o.migration.from}` : null, 'system', { inThread: true }) : null;
    this.migrationProblem = dbExists ? migrationBackupProblem(r, o.migration) : null;
    if (this.migrationProblem) this.log(`[maint] ${this.migrationProblem}`);
    return r;
  }

  /** migrationBackupProblem of the last startupBackup (null: none, or no migration). */
  get migrationBlocked(): string | null { return this.migrationProblem; }

  /** Back up now: the panel's "Back up now" (manual), or before a term purge / a New certificate (pre-*). */
  backupNow(reason: BackupReason = 'manual', o: { actor?: string; detail?: string | null } = {}): Promise<CreateBackupResult> {
    return this.run(reason, o.detail ?? null, o.actor ?? 'system');
  }

  list(): BackupInfo[] {
    return listBackups(this.dataDir, { key: this.key(), now: this.now() });
  }

  /** Server → Backups → Restore… (host PC): stage it for the next start. */
  stageRestore(backup: unknown, restoreConfig: unknown, actor: string): StageResult {
    const r = stageRestore(this.dataDir, { backup, restoreConfig, by: actor, now: this.now() }, { key: this.key() });
    if (r.ok) {
      this.log(`[maint] restore of ${r.pending.backup} staged for the next start`);
      try { this.opts.audit?.({ action: 'restore', actor, reason: `staged ${r.pending.backup}${r.pending.restoreConfig ? ' (with settings)' : ''}` }); } catch { /* best effort */ }
    }
    return r;
  }

  cancelRestore(actor: string): boolean {
    const had = cancelPendingRestore(this.dataDir);
    if (had) { try { this.opts.audit?.({ action: 'restore', actor, reason: 'cancelled the staged restore' }); } catch { /* best effort */ } }
    return had;
  }

  /** recovery/create (host PC): the file's bytes and the generated words, returned once. */
  async createRecovery(passphrase: string | null | undefined, actor: string): Promise<{ fileName: string; bytes: Buffer; words: string | null }> {
    const s = this.opts.settings();
    const made = await createRecovery({
      secrets: this.opts.secrets, serverName: s.serverName, installId: s.installId, passphrase: passphrase ?? null, now: this.now(),
    });
    writeRecoveryState(this.dataDir, made.state);
    try { this.opts.audit?.({ action: 'recovery', actor, reason: `created ${made.fileName}` }); } catch { /* best effort */ }
    this.log('[maint] a recovery file was created');
    return { fileName: made.fileName, bytes: made.bytes, words: made.words };
  }

  /** "Copy now": the launcher copies (true when it was asked). */
  requestCopy(): boolean {
    try { return this.opts.onCopyRequest?.() ?? false; } catch { return false; }
  }

  /**
   * The Home / Server banners of this module. `list`: a listing the caller already made (backupsListReply lists once
   * per panel reply).
   */
  banners(o: { list?: readonly BackupInfo[] } = {}): Banner[] {
    const out: Banner[] = [...diskBanners(this.disk)];
    if (this.migrationProblem) out.push({ code: 'migration-blocked', level: 'urgent', text: this.migrationProblem });
    const size = dbFileBytes(this.dbPath);
    const big = dbSizeBanner(size.dbBytes + size.walBytes);
    if (big) out.push(big);
    if (this.lastSkip && !out.some((b) => b.code === 'disk-low' || b.code === 'disk-critical')) out.push(this.lastSkip);
    if (this.lastFail) out.push(this.lastFail);
    const now = this.now();
    const s = this.opts.settings();
    const pepper = this.pepper();
    const rb = recoveryBanner(readRecoveryState(this.dataDir), { now, backupKey: this.key(), pepper, termEnd: s.termEnd ?? null });
    if (rb) out.push(rb);
    const list = o.list ?? listBackups(this.dataDir, { now });
    const ob = offPcBanner({ state: readOffPcState(this.dataDir), copyTo: s.backups.copyTo, now, oldestBackupAt: list.length ? Math.min(...list.map((b) => b.createdAt)) : null });
    if (ob) out.push(ob);
    const cb = clockBanner(list, now);
    if (cb) out.push(cb);
    const ab = asideDbBanner(listAsideDbs(this.dataDir, now), now);
    if (ab) out.push(ab);
    const pending = readPendingRestore(this.dataDir);
    if (pending) {
      out.push({ code: 'restore-pending', level: 'info', text: `A restore of ${pending.backup} is staged: stop the host and start it again to restore it (Server → Backups to cancel).` });
    }
    const lr = readLastRestore(this.dataDir);
    if (lr && now - lr.at < 24 * 60 * 60_000) {
      out.push(lr.ok
        ? { code: 'restored', level: 'info', text: lr.message }
        : { code: 'restore-failed', level: 'urgent', text: lr.message });
    }
    if (this.runnerError || this.runner?.failed) {
      out.push({ code: 'maint-worker', level: 'warn', text: this.runner?.failed ?? `The maintenance worker is not running (${this.runnerError}).` });
    }
    return out;
  }

  /** `list`: a listing the caller already made (this.list()). */
  status(o: { list?: BackupInfo[] } = {}): MaintStatus {
    const list = o.list ?? this.list();
    const s = this.opts.settings();
    const size = dbFileBytes(this.dbPath);
    return {
      disk: this.disk,
      db: { bytes: size.dbBytes, walBytes: size.walBytes },
      backups: { count: list.length, ...backupTotals(list, s.backups.sizeCapMB), newest: list[0] ?? null, last: this.last, lastAt: lastBackupAt(list) },
      pendingRestore: readPendingRestore(this.dataDir),
      lastRestore: readLastRestore(this.dataDir),
      recovery: readRecoveryState(this.dataDir),
      offPc: readOffPcState(this.dataDir),
      worker: { ok: !!this.runner && !this.runner.failed, error: this.runner?.failed ?? this.runnerError },
      indexTidyPending: this.indexDirty,
    };
  }

  /** Purges / deletions ran: an FTS optimize is due in the next quiet window. */
  noteIndexDirty(): void { this.indexDirty = true; }

  /**
   * The hourly look at mod_meta.fts_dirty (in the worker; no row count), so a purge or deletion that ran in another
   * op (B8b's writes, a ledger re-apply) gets its optimize in the next quiet window even if nobody called
   * noteIndexDirty().
   */
  private async refreshIndexDirty(): Promise<void> {
    if (!this.runner || this.indexDirty || !fs.existsSync(this.dbPath)) return;
    try {
      const r = await this.runner.call<{ rows?: number }>('fts.pending', undefined, { timeoutMs: 30_000 });
      if ((r?.rows ?? 0) > 0) this.indexDirty = true;
    } catch { /* an older worker or database: the next hour */ }
  }

  /** One scheduler step (the minute timer; tests call it). Returns what ran. */
  tick(): Promise<MaintTask[]> {
    if (this.ticking) return this.ticking.then(() => [], () => []);
    const p = this.tickOnce();
    this.ticking = p;
    // Registered first, so it runs before the caller's own continuation.
    p.finally(() => { if (this.ticking === p) this.ticking = null; }).catch(() => undefined);
    return p;
  }

  private async tickOnce(): Promise<MaintTask[]> {
    if (this.stopped) return [];
    const now = this.now();
    let connections = 0;
    try { connections = Math.max(0, Math.floor(this.opts.connections?.() ?? 0)); } catch { /* treat as 0 */ }
    if (connections > 0) this.lastBusyAt = now;
    const s = this.opts.settings();
    if (this.runner) this.runner.setConfig({ sizeCapMB: s.backups.sizeCapMB, installId: s.installId });
    const list = this.ownBackups(now).filter((b) => !b.future);
    const tasks = dueTasks({
      now, startedAt: this.startedAt, dailyEnabled: s.backups.daily, lastDailyAt: lastDailyAt(list),
      connections, lastBusyAt: this.lastBusyAt, indexDirty: this.indexDirty, lastDiskAt: this.lastDiskAt, dailyRetryAt: this.dailyRetryAt,
    });
    for (const t of tasks) {
      try {
        if (t === 'disk') {
          await this.checkDisk();
          await this.retentionHourly();
          await this.refreshIndexDirty();
        } else if (t === 'daily-backup') {
          const r = await this.run(dailyClass(list.map((b) => ({ cls: b.cls, at: b.createdAt })), now), null, 'system');
          if (r.ok) { this.dailyFails = 0; this.dailyRetryAt = null; }
          else { this.dailyFails++; this.dailyRetryAt = now + dailyRetryDelay(this.dailyFails); }
        } else if (t === 'optimize') await this.optimize();
      } catch (e) {
        this.log(`[maint] ${t} failed: ${errMsg(e)}`);
      }
    }
    return tasks;
  }

  /**
   * §5.16 "before the listener opens at start": the FTS optimize when purges left index entries behind. `notice`
   * gets the one console line ("Tidying the chat log index… about 4 s"). Null when there was nothing to do.
   */
  async startupTidy(notice?: (text: string) => void): Promise<{ ms: number } | null> {
    if (!this.runner || !this.indexDirty) return null;
    try {
      const st = await this.runner.call<{ optimizeEstimateMs: number }>('db.stats', undefined, { timeoutMs: 30_000 });
      notice?.(`Tidying the chat log index… about ${Math.max(1, Math.round(st.optimizeEstimateMs / 1000))} s`);
      return await this.optimize();
    } catch (e) {
      this.log(`[maint] the index tidy at start was skipped: ${errMsg(e)}`);
      return null;
    }
  }

  /**
   * Compact's estimate (the "this takes about N s" line) and whether it may run now: a quiet window (§5.16, as for
   * the daily backup and the optimize: nobody connected now, nor for the last 10 minutes, counting from the start).
   * VACUUM holds the write lock for its whole run, so a class that starts joining just after it began would wait on
   * it, and sign-ins would fail after busy_timeout. `quietInMin`: how long until the window opens (0 when open).
   */
  async compactInfo(): Promise<{ estimateSec: number; quiet: boolean; quietInMin: number; connections: number; dbBytes: number }> {
    let dbBytes = 0;
    for (const f of [this.dbPath, `${this.dbPath}-wal`]) { try { dbBytes += fs.statSync(f).size; } catch { /* none */ } }
    let connections = 0;
    try { connections = Math.max(0, Math.floor(this.opts.connections?.() ?? 0)); } catch { /* 0 */ }
    const now = this.now();
    if (connections > 0) this.lastBusyAt = now;
    const quiet = isQuiet({ now, connections, lastBusyAt: this.lastBusyAt, startedAt: this.startedAt });
    const quietInMin = quiet ? 0 : Math.max(1, Math.ceil((QUIET_MS - (now - (this.lastBusyAt ?? this.startedAt))) / 60_000));
    return { estimateSec: Math.max(1, Math.ceil(dbBytes / COMPACT_BYTES_PER_MS / 1000)), quiet, quietInMin, connections, dbBytes };
  }

  /** Compact database (VACUUM; ★, host PC): only in a quiet window (compactInfo), with twice the DB size free. */
  async compact(actor: string): Promise<{ ms: number; beforeBytes: number; afterBytes: number }> {
    if (!this.runner) throw new MaintError('EWORKER', this.runnerError ?? 'The maintenance worker is not running.');
    const info = await this.compactInfo();
    if (!info.quiet) {
      throw new MaintError('EBUSY', info.connections > 0
        ? `Compact runs only after nobody has been connected for ${QUIET_MS / 60_000} minutes (${info.connections} connected now): try again after class.`
        : `Compact runs only after nobody has been connected for ${QUIET_MS / 60_000} minutes: try again in ${info.quietInMin} min.`);
    }
    const r = await this.runner.call<{ ms: number; beforeBytes: number; afterBytes: number }>('db.compact', undefined, { timeoutMs: Math.max(60_000, info.estimateSec * 4000) });
    this.log(`[maint] database compacted in ${r.ms} ms (${Math.round(r.beforeBytes / 1048576)} MB → ${Math.round(r.afterBytes / 1048576)} MB)`);
    try { this.opts.audit?.({ action: 'backup', actor, reason: 'compacted the database' }); } catch { /* best effort */ }
    return r;
  }

  /** FTS optimize now (in the worker). */
  async optimize(): Promise<{ ms: number } | null> {
    if (!this.runner) return null;
    const r = await this.runner.call<{ ms: number; tidied: number }>('fts.optimize');
    this.indexDirty = false;
    this.log(`[maint] chat log index tidied in ${r.ms} ms`);
    return r;
  }

  /** Stop: the FTS optimize when due and quick (< 10 s), then the worker. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking?.catch(() => undefined);
    if (this.runner) {
      if (this.indexDirty) {
        try {
          const st = await this.runner.call<{ optimizeEstimateMs: number; indexTidyPending: boolean }>('db.stats', undefined, { timeoutMs: 5000 });
          if (st.optimizeEstimateMs < STOP_OPTIMIZE_MAX_MS) await this.runner.call('fts.optimize', undefined, { timeoutMs: STOP_OPTIMIZE_MAX_MS + 5000 });
        } catch (e) { this.log(`[maint] the index tidy at stop was skipped: ${errMsg(e)}`); }
      }
      try { await this.runner.close(); } catch { /* gone */ }
    }
  }

  /** The backup key's id (the Server panel shows it next to "encrypted ✓"). */
  keyId(): string | null {
    const k = this.key();
    return k ? keyIdOf(k) : null;
  }
}
