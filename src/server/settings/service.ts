// OWNER: SETTINGS. The settings service (docs/LAN-EDITION-proposal.md §5.13, §11.4): get, update, subscribe, audit.
//
//  - open(): load data\voidswarm.config.json, or create it (code defaults → preset → environment, first run only);
//    later runs log one warning per environment variable that differs (T-SET-1).
//  - update({ rev, patch }) (settings/update): a stale rev is 409 with the current rev (T-SET-2); an unknown,
//    read-only or invalid key is 400 naming the field; the cross-field rules (schema.ts checkRules) may answer 409
//    `needsMailTest` (T-SET-4) or 400 (School's fixed moderator tier, T-SET-7). Nothing changes on a refusal.
//  - Writes are serialized, atomic (store.ts; T-SET-6), and only then committed: the audit sink gets one `settings`
//    row per changed leaf, secrets as "(changed)" (T-SET-3), and subscribers are told (live apply, T-SET-5).
//  - The SMTP password is write-only (`mail.password` in a patch) and lives in data\secrets\smtp.secret.
// A settings file changed by another process (the tool CLI while the host runs) is re-read before each write, so
// an update made against the older copy gets the 409; the write itself holds the writers' lock and re-checks the
// stored rev (store.ts withConfigLock), so two processes saving at the same moment never lose a change.
import path from 'node:path';
import type { SecretStore } from '../secrets';
import {
  AUDIT_MASKED_PATHS, SECRET_CHANGED, SMTP_SECRET, changeWarnings, checkRules, diffSettings, failingPositiveLines,
  formatAuditValue, freezeDeep, getPath, isPlainObject, mailFingerprint, mailTested, maskAddress, mergePatch, presetValues, deepAssign,
  repairSettings, splitMailPassword, validate, RESTART_PATHS,
  type AccountsMode, type HostSettings, type LeafChange, type PasswordChange, type Preset, type RuleFailure,
} from './schema';
import {
  CONFIG_FILE, SettingsConflictError, assertStoredRev, cleanupTempFiles, createSettings, envDifferences,
  readConfigFile, readStoredRev, envValue, seedFromEnv, serializeSettings, settingsFromRaw, withConfigLock, withConfigLockSync,
  writeFileAtomic, writeFileAtomicSync, type AtomicFsAsync, type Env,
} from './store';

// ------------------------------------------------------------------------------------------
// Types
// ------------------------------------------------------------------------------------------

/** Who changed a setting (the same shape as the moderation Actor, so audit rows land in mod_actions as-is). */
export interface SettingsActor { accountId: string; name: string }
/** The server itself (retention fallback after a term, a mail test result, ...). */
export const SYSTEM_SETTINGS_ACTOR: SettingsActor = { accountId: 'system', name: 'system' };
/** The launcher (port pair, approved networks). */
export const LAUNCHER_ACTOR: SettingsActor = { accountId: 'launcher', name: 'launcher' };
/** The maintenance CLI (tool.mjs / npm run mod). */
export const CLI_SETTINGS_ACTOR: SettingsActor = { accountId: 'cli', name: 'cli' };

/** One audit row: one changed leaf. `reason` is the ready-made text: "chat.retention.days: 90 → 30". */
export interface SettingsAuditEvent {
  actor: SettingsActor;
  path: string;
  /** Formatted old value ("(changed)" for a secret). */
  old: string;
  /** Formatted new value ("(changed)" for a secret). */
  new: string;
  reason: string;
  /** Why the change happened, when not a plain edit ("preset school", "mail test", ...). */
  context?: string;
}
export type SettingsAuditSink = (e: SettingsAuditEvent) => void;

export type SettingsListener = (next: HostSettings, prev: HostSettings, changed: readonly string[]) => void;

export interface SubscribeOptions {
  /** Only call back when a changed leaf starts with one of these paths (e.g. ['rooms', 'chat.substitute']). */
  paths?: readonly string[];
  /** Also call back at once with the current settings (changed = ['*']). Default false. */
  immediate?: boolean;
}

export interface SettingsOk {
  ok: true;
  settings: HostSettings;
  rev: number;
  /** The changed leaves (empty = nothing to do; the rev did not move). */
  changed: string[];
  /** Friendly notes (the alias-domain warning, "restart the host", ...). */
  warnings: string[];
  restartNeeded: boolean;
}
export interface SettingsFail {
  ok: false;
  /** 400 bad patch, 409 stale rev or needsMailTest, 500 could not save. */
  status: 400 | 409 | 500;
  error: string;
  field?: string;
  /** 409 stale: the current rev (reload and try again). */
  rev?: number;
  needsMailTest?: true;
  rejected?: { line: string; why: string }[];
}
export type SettingsResult = SettingsOk | SettingsFail;

/** Where the settings are kept: a file (the normal case) or memory (tests, a server with no data folder). */
export interface SettingsBackend {
  readonly file: string | null;
  /** The stored object, or null on the first run. Throws SettingsLoadError when unreadable. */
  load(): { raw: Record<string, unknown> | null; warnings: string[] };
  /** The stored rev right now (null = unknown / unreadable). */
  storedRev(): number | null;
  /**
   * A saved change (atomic; never blocks the game thread on the fsync). `expectedRev` = the rev this copy was made
   * from: when the stored one is newer (another process saved meanwhile) it throws SettingsConflictError instead.
   */
  save(s: HostSettings, expectedRev?: number): Promise<void>;
  /** The first-run / recovery write in open() (start-up, before anything else runs). */
  saveSync(s: HostSettings): void;
}

export function fileBackend(file: string, opts: { fs?: AtomicFsAsync } = {}): SettingsBackend {
  return {
    file,
    load: () => {
      cleanupTempFiles(file);
      const r = readConfigFile(file);
      return { raw: r.raw, warnings: r.warnings };
    },
    storedRev: () => readStoredRev(file),
    save: (s, expectedRev) => withConfigLock(file, async () => {
      assertStoredRev(file, expectedRev);
      await writeFileAtomic(file, serializeSettings(s), { fs: opts.fs, keepBackup: true });
    }),
    saveSync: (s) => withConfigLockSync(file, () => writeFileAtomicSync(file, serializeSettings(s), { keepBackup: true })),
  };
}

export function memoryBackend(initial: Record<string, unknown> | null = null): SettingsBackend & { stored: HostSettings | null } {
  const put = (s: HostSettings): void => { b.stored = JSON.parse(JSON.stringify(s)) as HostSettings; };
  const b = {
    file: null,
    stored: null as HostSettings | null,
    load: () => ({ raw: b.stored ? (JSON.parse(JSON.stringify(b.stored)) as Record<string, unknown>) : initial, warnings: [] }),
    storedRev: () => b.stored?.rev ?? null,
    save: async (s: HostSettings, expectedRev?: number) => {
      if (expectedRev !== undefined && b.stored && b.stored.rev > expectedRev) throw new SettingsConflictError(b.stored.rev);
      put(s);
    },
    saveSync: put,
  };
  return b;
}

export interface SettingsServiceOptions {
  /** The data folder: the config is `<dataDir>\voidswarm.config.json`. */
  dataDir?: string;
  /** Or an explicit backend (memoryBackend() in tests). */
  backend?: SettingsBackend;
  /** First run only: the seed. Later: compared, one warning per differing variable. Default process.env. */
  env?: Env;
  /** LAN edition defaults (true) or the VPS / npm start code defaults (false). Default true. */
  lan?: boolean;
  /** The preset of a NEW config (default 'home'; first-run setup then calls applyPreset). */
  preset?: Preset;
  accountsMode?: AccountsMode;
  /** VPS upgrade: the DB already has moderators (they keep view, log search and the trusted tier; §4.10). */
  existingModerators?: boolean;
  /** Where the SMTP password goes (data\secrets\smtp.secret). Without one, mail.password can't be set. */
  secrets?: Pick<SecretStore, 'has' | 'readText' | 'write' | 'remove'> | null;
  audit?: SettingsAuditSink | null;
  log?: (line: string) => void;
  now?: () => number;
  /** Log the "…ignored — the admin console setting wins" warnings at open (default true; the child passes false). */
  envWarnings?: boolean;
}

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

/** §4.2 for a restored config: Required email needs a mail server. */
const RESTORED_REQUIRED_WITHOUT_MAIL = 'WARNING: the restored settings require email, but they have no mail server — accounts use '
  + 'OPTIONAL email until mail works. Set up Mail, send a test email, then switch to Required.';

// ------------------------------------------------------------------------------------------
// The service
// ------------------------------------------------------------------------------------------

export class SettingsService {
  /** True when this open() created the config (first run: env seeded, no audit). */
  readonly created: boolean;
  /** Everything worth telling the host from the load (repairs, env differences, fallbacks). Also logged. */
  readonly warnings: readonly string[];
  /** The variables that seeded a new config (empty unless created). */
  readonly seeded: readonly string[];
  private cur: HostSettings;
  private readonly backend: SettingsBackend;
  private readonly env: Env;
  private readonly lan: boolean;
  private readonly secrets: SettingsServiceOptions['secrets'];
  private audit: SettingsAuditSink | null;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly listeners = new Set<{ fn: SettingsListener; paths: readonly string[] | null }>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  /** Load or create the settings. Throws SettingsLoadError when the file and its .bak are both damaged. */
  static open(opts: SettingsServiceOptions = {}): SettingsService {
    return new SettingsService(opts);
  }

  private constructor(opts: SettingsServiceOptions) {
    this.env = opts.env ?? process.env;
    this.lan = opts.lan !== false;
    this.secrets = opts.secrets ?? null;
    this.audit = opts.audit ?? null;
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.now = opts.now ?? Date.now;
    if (!opts.backend && !opts.dataDir) throw new Error('SettingsService needs a dataDir or a backend');
    this.backend = opts.backend ?? fileBackend(path.join(opts.dataDir!, CONFIG_FILE));

    const warnings: string[] = [];
    const loaded = this.backend.load();
    warnings.push(...loaded.warnings);
    let created = false;
    let seeded: string[] = [];
    let s: HostSettings;
    if (loaded.raw) {
      s = settingsFromRaw(loaded.raw, { lan: this.lan }, warnings);
    } else {
      const c = createSettings({
        lan: this.lan, preset: opts.preset, accountsMode: opts.accountsMode, env: this.env,
        existingModerators: opts.existingModerators, now: this.now(),
      });
      s = c.settings;
      seeded = c.seeded;
      warnings.push(...c.warnings);
      created = true;
    }
    this.syncPasswordSet(s);
    if (created || loaded.warnings.length) {
      // First run, or recovered from the .bak: write a good main file now (a failure here is fatal on purpose:
      // the host must not run with settings it can't save).
      this.backend.saveSync(s);
    }
    // One line per differing variable, worded for the host exactly as §5.13 shows it (no prefix).
    const envLines = !created && opts.envWarnings !== false ? envDifferences(s, this.env) : [];
    this.cur = freezeDeep(s);
    this.created = created;
    this.seeded = seeded;
    this.warnings = [...warnings, ...envLines];
    if (created) this.log(`[settings] created ${this.backend.file ?? 'the settings'} (${s.preset} preset${seeded.length ? `; from the environment: ${seeded.join(', ')}` : ''})`);
    for (const w of warnings) this.log(w.startsWith('WARNING') ? w : `[settings] ${w}`);
    for (const w of envLines) this.log(w);
  }

  // --- reading ---

  /** The settings in force (deep-frozen; never contains a secret). */
  get(): HostSettings { return this.cur; }
  get rev(): number { return this.cur.rev; }
  get file(): string | null { return this.backend.file; }

  /** One value by its dotted path ('rooms.maxRooms'). */
  value(p: string): unknown { return getPath(this.cur, p); }

  /** A test email succeeded with the current mail settings (Required can be switched on). */
  mailReady(): boolean { return mailTested(this.cur.mail); }

  /** The mail settings' fingerprint: smtp/test takes it BEFORE sending and hands it to recordMailTest. */
  mailFingerprint(): string { return mailFingerprint(this.cur.mail); }

  /**
   * The positive lines the chat filter catches now (a custom term added after they were saved; the Zone skips
   * them). Settings → Chat shows them; the custom-terms code can call this after setCustomTerms for a banner.
   */
  failingPositiveLines(): string[] { return failingPositiveLines(this.cur); }

  /** The SMTP password: data\secrets\smtp.secret, else SMTP_PASS from the environment (VPS), else null. */
  mailPassword(): string | null {
    try {
      const s = this.secrets?.readText(SMTP_SECRET);
      if (s) return s;
    } catch (e) {
      this.log(`[settings] could not read the SMTP password: ${errMsg(e)}`);
    }
    return envValue(this.env, 'SMTP_PASS') ?? null;
  }

  /**
   * Would settings/update accept this patch now (schema.ts validate: the same leaf and cross-field checks, nothing
   * saved, no rev check)? The panel's "check before saving" and an import's dry run.
   */
  check(patch: unknown): { ok: true; settings: HostSettings } | RuleFailure {
    const split = splitMailPassword(patch);
    if (split.ok && split.password && !this.secrets) {
      return { ok: false, status: 400, error: "This server can't store a mail password (set SMTP_PASS in its environment instead).", field: 'mail.password' };
    }
    return validate(this.cur, patch, { lan: this.lan, envPassword: !!envValue(this.env, 'SMTP_PASS') });
  }

  // --- subscribing ---

  /** Call `fn` after every saved change (optionally only for some paths). Returns the unsubscribe. */
  subscribe(fn: SettingsListener, opts: SubscribeOptions = {}): () => void {
    const entry = { fn, paths: opts.paths && opts.paths.length ? [...opts.paths] : null };
    this.listeners.add(entry);
    if (opts.immediate) this.call(entry, this.cur, this.cur, ['*']);
    return () => { this.listeners.delete(entry); };
  }

  /** Where audit rows go (the moderation service opens after the settings). null = nowhere. */
  setAudit(sink: SettingsAuditSink | null): void { this.audit = sink; }

  // --- writing ---

  /**
   * settings/update from the panel: `{ rev, patch }`. The rev must be the one the panel read (else 409 with the
   * current rev); read-only leaves are refused.
   */
  update(req: unknown, actor: SettingsActor): Promise<SettingsResult> {
    return this.serial(() => {
      if (!isPlainObject(req)) return fail(400, 'Send { rev, patch }.');
      const rev = req.rev;
      if (typeof rev !== 'number' || !Number.isInteger(rev)) return fail(400, 'rev is required (the rev you read with settings/get).', 'rev');
      this.refreshFromDisk();
      if (rev !== this.cur.rev) {
        return { ok: false, status: 409, error: 'The settings changed since you opened them — reload them and try again.', rev: this.cur.rev };
      }
      return this.commit(req.patch, actor, { system: false });
    });
  }

  /** A change made by the server itself (no rev check; read-only leaves allowed). */
  apply(patch: unknown, actor: SettingsActor = SYSTEM_SETTINGS_ACTOR, opts: { context?: string } = {}): Promise<SettingsResult> {
    return this.serial(() => {
      this.refreshFromDisk();
      return this.commit(patch, actor, { system: true, context: opts.context });
    });
  }

  /**
   * First-run setup's Home / School choice (§5.13 presets). Sets the preset's values (every one can still be changed
   * afterwards), then re-applies the environment variables that seeded this config (an operator's explicit choice
   * outranks a preset default). School: `forever` retention without the district tick becomes 90 days.
   */
  applyPreset(preset: Preset, actor: SettingsActor, opts: { accountsMode?: AccountsMode; serverName?: string } = {}): Promise<SettingsResult> {
    return this.serial(() => {
      if (preset !== 'home' && preset !== 'school') return fail(400, 'The preset is home or school.', 'preset');
      if (opts.accountsMode !== undefined && opts.accountsMode !== 'email' && opts.accountsMode !== 'roster') {
        return fail(400, 'accountsMode is email or roster.', 'accountsMode');
      }
      this.refreshFromDisk();
      const next = structuredClone(this.cur) as HostSettings;
      deepAssign(next, presetValues(preset, { lan: this.lan, accountsMode: opts.accountsMode }));
      if (this.cur.seededFromEnv.length) {
        seedFromEnv(next, { lan: this.lan, env: this.env }, this.cur.seededFromEnv);
      }
      if (preset === 'school' && next.moderators.tier !== 'limited') next.moderators.tier = 'limited';
      const extraWarnings: string[] = [];
      if (preset === 'school' && next.chat.retention.mode === 'forever' && !next.chat.retention.districtApproved) {
        next.chat.retention.mode = 'days';
        extraWarnings.push(`Keeping chat forever needs the district tick in School — chat is kept ${next.chat.retention.days} days.`);
      }
      const patch: Record<string, unknown> = { ...stripMeta(next) };
      if (opts.serverName !== undefined) patch.serverName = opts.serverName;
      return this.commit(patch, actor, { system: true, context: `preset ${preset}`, extraWarnings });
    });
  }

  /**
   * smtp/test succeeded: remember it (unlocks Required). `tested.fingerprint` is svc.mailFingerprint() taken BEFORE
   * the test email was sent: when the mail settings (or the password) changed while it was on its way, the test
   * doesn't count for the new ones (409, field `mail`: send it again).
   */
  recordMailTest(actor: SettingsActor, tested: { fingerprint: string; at?: number }): Promise<SettingsResult> {
    return this.serial(() => {
      this.refreshFromDisk();
      if (!this.cur.mail.host) return fail(400, 'Set up the mail server first.', 'mail.host');
      const fp = tested && typeof tested === 'object' ? tested.fingerprint : undefined;
      if (typeof fp !== 'string' || !/^[0-9a-f]{16}$/.test(fp)) return fail(400, 'The mail settings fingerprint of the test is missing.', 'fingerprint');
      if (fp !== mailFingerprint(this.cur.mail)) {
        return fail(409, 'The mail settings changed while the test email was being sent — send the test again.', 'mail');
      }
      const at = typeof tested.at === 'number' && Number.isFinite(tested.at) && tested.at >= 0 ? tested.at : this.now();
      return this.commit({ mail: { lastTest: { at: Math.floor(at), fingerprint: fp } } }, actor, { system: true, context: 'mail test' });
    });
  }

  /** network/approve: serve players (or not) on a network the launcher saw. */
  approveNetwork(networkId: string, serve: boolean, actor: SettingsActor): Promise<SettingsResult> {
    return this.serial(() => {
      if (typeof networkId !== 'string' || !networkId.trim() || networkId.length > 64) return fail(400, 'networkId is required.', 'networkId');
      if (typeof serve !== 'boolean') return fail(400, 'serve must be true or false.', 'serve');
      this.refreshFromDisk();
      const list = this.cur.network.approvedNetworks.filter((n) => n.id !== networkId.trim());
      list.push({ id: networkId.trim(), serve, at: Math.floor(this.now()) });
      return this.commit({ network: { approvedNetworks: list } }, actor, { system: true, context: 'network approval' });
    });
  }

  /**
   * Restore a whole config (§6.2 step 7 "optionally restore the config"; §6.5 "Config is validated field by field"):
   * `raw` is the parsed voidswarm.config.json from a backup or another install. It REPLACES the settings (a custom
   * tag absent from it goes), as one audited change (context "restore"): every bad leaf takes its default with a
   * warning, the cross-field rules are repaired, not refused. The rev moves forward from the current one (never back
   * to the backup's, so every open panel gets its 409), and this install keeps its own installId unless
   * `keepInstallId: false` (moving PCs: the recovery file's id comes with the raw config). No secret is read from
   * `raw`: passwordSet follows data\secrets (§6.5 "Secrets come only from a recovery file"). A mail test in `raw`
   * never counts, Required email without a mail server becomes optional (§4.2), and the host's custom terms apply
   * to the restored name, notice and positive lines.
   */
  restore(raw: unknown, actor: SettingsActor, opts: { keepInstallId?: boolean; context?: string } = {}): Promise<SettingsResult> {
    return this.serial(() => {
      if (!isPlainObject(raw)) return fail(400, 'The saved settings are not a settings file.');
      this.refreshFromDisk();
      const prev = this.cur;
      const warnings: string[] = [];
      const next = settingsFromRaw(raw, { lan: this.lan }, warnings);
      if (opts.keepInstallId !== false || !next.installId) next.installId = prev.installId;
      next.createdAt = prev.createdAt;
      next.rev = prev.rev;
      next.updatedAt = prev.updatedAt;
      // This install's own first-run record (applyPreset re-applies those variables from THIS environment).
      next.seededFromEnv = [...prev.seededFromEnv];
      // Nothing can claim a password the secret store doesn't hold, or a test made with another password.
      next.mail.passwordRev = prev.mail.passwordRev;
      this.syncPasswordSet(next);
      // A restored mail test never counts: the fingerprint is not a secret (the installId and the mail settings are in
      // the file), so a hand-made one would unlock Required. Required already on stays on; switching it on needs a
      // new test email after a restore.
      next.mail.lastTest = null;
      // §4.2: Required email without a mail server falls back to optional, loudly (as an env seed does).
      if (next.accounts.email === 'required' && !next.mail.host) {
        warnings.push(RESTORED_REQUIRED_WITHOUT_MAIL);
        next.accounts.email = 'optional';
      }
      // The host's custom terms count here too (the result must pass checkRules), and passwordSet is now known.
      repairSettings(next, warnings, { lan: this.lan, installedFilter: true });
      for (const w of warnings) this.log(`[settings] restore: ${w}`);
      return this.save(prev, next, actor, { context: opts.context ?? 'restore', extraWarnings: warnings, restore: true });
    });
  }

  /** Re-read the file when another process saved a newer rev. True when something was reloaded. */
  reload(): boolean {
    return this.refreshFromDisk();
  }

  /** Wait for queued writes; later writes are refused. */
  async close(): Promise<void> {
    this.closed = true;
    try { await this.queue; } catch { /* each write reported its own error */ }
    this.listeners.clear();
  }

  // --- internals ---

  private serial(fn: () => SettingsResult | Promise<SettingsResult>): Promise<SettingsResult> {
    const run = async (): Promise<SettingsResult> => {
      if (this.closed) return fail(500, 'The server is stopping.');
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn();
        } catch (e) {
          // Another process saved in between: re-read and run again (each write re-checks what it depends on: an
          // update's rev then no longer matches, so it answers 409; a server-side change is merged onto the new copy).
          if (e instanceof SettingsConflictError && attempt < 3) {
            this.refreshFromDisk();
            continue;
          }
          this.log(`[settings] error: ${(e as Error)?.stack ?? e}`);
          return fail(500, `Could not save the settings: ${errMsg(e)}`);
        }
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p;
    return p;
  }

  /** passwordSet mirrors the secret store (or SMTP_PASS on a VPS). */
  private syncPasswordSet(s: HostSettings): void {
    let has = false;
    try { has = !!this.secrets?.has(SMTP_SECRET); } catch { has = false; }
    s.mail.passwordSet = has || !!envValue(this.env, 'SMTP_PASS');
  }

  private refreshFromDisk(): boolean {
    const stored = this.backend.storedRev();
    if (stored === null || stored <= this.cur.rev) return false;
    try {
      const loaded = this.backend.load();
      if (!loaded.raw) return false;
      const warnings: string[] = [...loaded.warnings];
      const s = settingsFromRaw(loaded.raw, { lan: this.lan }, warnings);
      this.syncPasswordSet(s);
      const prev = this.cur;
      this.cur = freezeDeep(s);
      for (const w of warnings) this.log(`[settings] ${w}`);
      this.log(`[settings] reloaded ${this.backend.file ?? 'the settings'} (rev ${prev.rev} → ${s.rev}, changed elsewhere)`);
      const changed = diffSettings(prev, this.cur).map((c) => c.path);
      if (changed.length) this.notify(this.cur, prev, changed);
      return true;
    } catch (e) {
      this.log(`[settings] could not re-read the settings file: ${errMsg(e)}`);
      return false;
    }
  }

  private async commit(patch: unknown, actor: SettingsActor, opts: { system: boolean; context?: string; extraWarnings?: string[] }): Promise<SettingsResult> {
    // The write-only password is taken out of the patch first (schema.ts splitMailPassword, shared with validate()).
    const split = splitMailPassword(patch);
    if (!split.ok) return fail(400, split.error, split.field);
    const password = split.password;
    if (password && !this.secrets) return fail(400, "This server can't store a mail password (set SMTP_PASS in its environment instead).", 'mail.password');
    const prev = this.cur;
    const merged = mergePatch(prev, split.body, { system: opts.system });
    if (!merged.ok) return fail(400, merged.error, merged.field);
    return this.save(prev, structuredClone(merged.value) as HostSettings, actor, { ...opts, password });
  }

  /**
   * Save `next` (a complete tree) in place of `prev`: the cross-field rules, the password secret, the atomic write,
   * then the audit rows and the subscribers. Nothing changes on a refusal or a failed write.
   */
  private async save(prev: HostSettings, next: HostSettings, actor: SettingsActor, opts: {
    context?: string; extraWarnings?: string[]; password?: PasswordChange | null; restore?: boolean;
  }): Promise<SettingsResult> {
    const password = opts.password ?? null;
    let passwordChanged = false;
    if (password) {
      const had = (() => { try { return this.secrets!.has(SMTP_SECRET); } catch { return false; } })();
      const same = (() => { try { return had && password.set !== null && this.secrets!.readText(SMTP_SECRET) === password.set; } catch { return false; } })();
      passwordChanged = password.set === null ? had : !same;
      if (passwordChanged) {
        next.mail.passwordRev = prev.mail.passwordRev + 1;
        next.mail.passwordSet = password.set !== null || !!envValue(this.env, 'SMTP_PASS');
      }
    }
    // A restored config was accepted when it was set: its Required email stays (repairSettings already put every
    // other rule right), so the "send a test email first" lock is only for a switch made here.
    const rule = checkRules(next, opts.restore ? { ...prev, accounts: { ...prev.accounts, email: next.accounts.email } } : prev, { lan: this.lan });
    if (rule) return { ...rule };
    const changes = diffSettings(prev, next);
    if (!changes.length && !passwordChanged) {
      return { ok: true, settings: prev, rev: prev.rev, changed: [], warnings: [...(opts.extraWarnings ?? [])], restartNeeded: false };
    }
    // Save: the secret first (so the config never claims a password that isn't there), then the config.
    let oldSecret: string | null = null;
    if (passwordChanged) {
      try {
        oldSecret = this.secrets!.readText(SMTP_SECRET);
        if (password!.set === null) this.secrets!.remove(SMTP_SECRET);
        else this.secrets!.write(SMTP_SECRET, password!.set);
      } catch (e) {
        return fail(500, `Could not save the mail password: ${errMsg(e)}`, 'mail.password');
      }
    }
    next.rev = prev.rev + 1;
    next.updatedAt = Math.max(Math.floor(this.now()), prev.updatedAt);
    try {
      await this.backend.save(next, prev.rev);
    } catch (e) {
      if (passwordChanged) {
        try {
          if (oldSecret === null) this.secrets!.remove(SMTP_SECRET);
          else this.secrets!.write(SMTP_SECRET, oldSecret);
        } catch { /* the password stays changed; mail.passwordRev on disk is the old one */ }
      }
      if (e instanceof SettingsConflictError) throw e; // serial() re-reads and runs the write again
      this.log(`[settings] could not save: ${errMsg(e)}`);
      return fail(500, `Could not save the settings: ${errMsg(e)}`);
    }
    this.cur = freezeDeep(next);
    const changed = changes.map((c) => c.path);
    if (passwordChanged) changed.push('mail.password');
    this.writeAudit(actor, changes, passwordChanged, opts.context);
    this.notify(this.cur, prev, changed);
    const warnings = [...(opts.extraWarnings ?? []), ...changeWarnings(this.cur, prev)];
    return {
      ok: true, settings: this.cur, rev: this.cur.rev, changed, warnings,
      restartNeeded: changed.some((c) => RESTART_PATHS.includes(c)),
    };
  }

  private writeAudit(actor: SettingsActor, changes: LeafChange[], passwordChanged: boolean, context?: string): void {
    const sink = this.audit;
    if (!sink) return;
    const rows: SettingsAuditEvent[] = changes.map((c) => {
      const masked = AUDIT_MASKED_PATHS.includes(c.path);
      const old = formatAuditValue(masked ? maskAddress(c.old) : c.old);
      const nw = formatAuditValue(masked ? maskAddress(c.new) : c.new);
      return { actor, path: c.path, old, new: nw, reason: `${c.path}: ${old} → ${nw}${context ? ` (${context})` : ''}`, context };
    });
    if (passwordChanged) {
      rows.push({ actor, path: 'mail.password', old: SECRET_CHANGED, new: SECRET_CHANGED, reason: `mail.password: ${SECRET_CHANGED}${context ? ` (${context})` : ''}`, context });
    }
    for (const r of rows) {
      try { sink(r); } catch (e) { this.log(`[settings] could not write the audit trail: ${errMsg(e)}`); }
    }
  }

  private notify(next: HostSettings, prev: HostSettings, changed: readonly string[]): void {
    for (const l of [...this.listeners]) this.call(l, next, prev, changed);
  }

  private call(l: { fn: SettingsListener; paths: readonly string[] | null }, next: HostSettings, prev: HostSettings, changed: readonly string[]): void {
    if (l.paths && !changed.includes('*') && !changed.some((c) => l.paths!.some((p) => c === p || c.startsWith(`${p}.`)))) return;
    try { l.fn(next, prev, changed); } catch (e) { this.log(`[settings] a settings subscriber failed: ${(e as Error)?.stack ?? e}`); }
  }
}

function fail(status: 400 | 409 | 500, error: string, field?: string): SettingsFail {
  return field ? { ok: false, status, error, field } : { ok: false, status, error };
}

/** The writable part of a settings tree (metadata and system-managed leaves the preset never sets are dropped). */
function stripMeta(s: HostSettings): Record<string, unknown> {
  const { configVersion: _v, rev: _r, installId: _i, createdAt: _c, updatedAt: _u, seededFromEnv: _e, mail, network, ...rest } = s;
  const { passwordSet: _ps, passwordRev: _pr, lastTest: _lt, ...mailRest } = mail;
  const { ownCertificate: _oc, approvedNetworks: _an, ...netRest } = network;
  return { ...rest, mail: mailRest, network: netRest };
}

