// OWNER: SETTINGS. Live apply (docs/LAN-EDITION-proposal.md §5.13 "Live apply: each component subscribes"): what
// each component takes from the settings, and bindSettings(), which pushes a change to every component at once.
//
//  - Zone: setChatOptions({ substitute, positiveLines, strictness }) and setLimits({ maxRooms, maxPlayingRooms,
//    maxRoomsPerAddress }) (lowering a cap never closes a room; it only stops new ones: T-SET-5).
//  - Moderation: strikes, retention and records days, the filter strictness (ModerationService.config), plus the
//    v0.6 policy (tags, retention mode, address minimisation) for whoever implements setPolicy().
//  - The ws ConnectionGate: the connection caps.
//  - Auth: the account policy and the mail settings (setPolicy / reconfigure, when the auth service has them).
// Components are duck-typed and optional: a setter that doesn't exist yet is skipped (and logged once), so the
// binding works against today's components and picks up the new setters as they land.
import type { Strictness } from '../../shared/moderation/filter';
import type { HostSubstituteMode, HostSettings, RetentionMode, TagPolicy } from './schema';
import { TERM_GRACE_DAYS } from './schema';
import type { SettingsAuditSink, SettingsService } from './service';

const MIN = 60_000;

// ------------------------------------------------------------------------------------------
// What each component takes
// ------------------------------------------------------------------------------------------

/** Zone.setLimits (§5.9, §11.8). */
export interface ZoneLimits { maxRooms: number; maxPlayingRooms: number; maxRoomsPerAddress: number }
export const zoneLimitsOf = (s: HostSettings): ZoneLimits => ({
  maxRooms: s.rooms.maxRooms, maxPlayingRooms: s.rooms.maxPlayingRooms, maxRoomsPerAddress: s.rooms.maxRoomsPerAddress,
});

/** Zone.setChatOptions (shared/room/moderation.ts ZoneChatOptions). */
export interface ZoneChatSettings { substitute: HostSubstituteMode; positiveLines: string[]; strictness: Strictness }
export const zoneChatOptionsOf = (s: HostSettings): ZoneChatSettings => ({
  substitute: s.chat.substitute, positiveLines: [...s.chat.positiveLines], strictness: s.chat.strictness,
});

/** The ModerationService config fields (moderation/service.ts ModerationConfig) the settings own. */
export interface ModerationSettingsConfig {
  strikeLimit: number;
  strikeWindowMs: number;
  autoMuteSec: number;
  /**
   * The age-based pruner's chat retention. `term` and `forever` give 3650 (no age purge): the term rule (nothing
   * before the end date, then lines older than it at end + 14 days) is retentionPolicyOf()'s, for the retention job.
   */
  retentionDays: number;
  keepDays: number;
  chatFilter: Strictness;
}
export const moderationConfigOf = (s: HostSettings): ModerationSettingsConfig => ({
  strikeLimit: s.chat.strikes.limit,
  strikeWindowMs: s.chat.strikes.windowMin * MIN,
  autoMuteSec: s.chat.strikes.autoMuteMin * 60,
  retentionDays: s.chat.retention.mode === 'days' ? s.chat.retention.days : 3650,
  keepDays: s.chat.recordsDays,
  chatFilter: s.chat.strictness,
});

/** The chat-log retention rule (§5.5) for the retention job. */
export interface RetentionPolicy {
  mode: RetentionMode;
  days: number;
  /** `term`: the end date (YYYY-MM-DD) and the grace before lines older than it go. */
  termEnd: string | null;
  graceDays: number;
  recordsDays: number;
}
export const retentionPolicyOf = (s: HostSettings): RetentionPolicy => ({
  mode: s.chat.retention.mode, days: s.chat.retention.days, termEnd: s.chat.retention.termEnd,
  graceDays: TERM_GRACE_DAYS, recordsDays: s.chat.recordsDays,
});

/** The v0.6 moderation policy (§5.8 per-tag policy, §6.4 address minimisation). */
export interface ModerationPolicy {
  tags: Record<string, TagPolicy>;
  tagDefault: TagPolicy;
  retention: RetentionPolicy;
  addressMinimisation: boolean;
  tier: HostSettings['moderators']['tier'];
  moderatorView: boolean;
  moderatorLogSearch: boolean;
}
export const moderationPolicyOf = (s: HostSettings): ModerationPolicy => ({
  tags: structuredClone(s.chat.tags) as Record<string, TagPolicy>,
  tagDefault: { ...s.chat.tagDefault },
  retention: retentionPolicyOf(s),
  addressMinimisation: s.chat.addressMinimisation,
  tier: s.moderators.tier,
  moderatorView: s.moderators.view,
  moderatorLogSearch: s.moderators.logSearch,
});

/** The ws ConnectionGate caps (netguard.ts GateLimits). */
export const gateLimitsOf = (s: HostSettings): { maxTotal: number; maxPerAddress: number } => ({
  maxTotal: s.rooms.maxConnections, maxPerAddress: s.rooms.maxConnectionsPerAddress,
});

/** The account policy (§4.2) as the auth service needs it. */
export type AccountPolicy = HostSettings['accounts'] & { mailReady: boolean; serverName: string };
export const accountPolicyOf = (s: HostSettings, mailReady: boolean): AccountPolicy => ({
  ...structuredClone(s.accounts), mailReady, serverName: s.serverName,
});

/** SMTP transport settings (the mailer's reconfigure). `secure` = implicit TLS; `requireTLS` = STARTTLS required. */
export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  user: string | undefined;
  pass: string | undefined;
  from: string;
  /** Host alert emails (content-free) go here; '' = off. */
  alertEmail: string;
}
export function mailConfigOf(s: HostSettings, password: string | null): MailConfig | null {
  const m = s.mail;
  if (!m.host) return null;
  const user = m.user || undefined;
  return {
    host: m.host,
    port: m.port,
    secure: m.security === 'tls',
    requireTLS: m.security === 'starttls',
    user,
    pass: user ? (password ?? '') : undefined,
    from: m.from || (user && user.includes('@') ? `Voidswarm <${user}>` : 'Voidswarm <no-reply@localhost>'),
    alertEmail: s.alerts.email,
  };
}

// ------------------------------------------------------------------------------------------
// bindSettings
// ------------------------------------------------------------------------------------------

/** The Zone's live setters (setLimits lands with B15; until then it is skipped). */
export interface ZoneTarget {
  setChatOptions?(o: ZoneChatSettings): { ok: boolean; error?: string } | unknown;
  setLimits?(l: ZoneLimits): unknown;
}
export interface ModerationTarget {
  /** Today's ModerationService: its config object is read at use time, so updating its fields applies live. */
  config?: Partial<Record<keyof ModerationSettingsConfig, unknown>>;
  setConfig?(c: ModerationSettingsConfig): unknown;
  setPolicy?(p: ModerationPolicy): unknown;
}
export interface GateTarget { limits: { maxTotal: number; maxPerAddress: number } }
export interface AuthTarget {
  setPolicy?(p: AccountPolicy): unknown;
  reconfigureMail?(c: MailConfig | null): unknown;
}

export interface SettingsTargets {
  zone?: ZoneTarget | null;
  moderation?: ModerationTarget | null;
  gate?: GateTarget | null;
  auth?: AuthTarget | null;
  log?: (line: string) => void;
}

const ZONE_PATHS = ['chat.substitute', 'chat.positiveLines', 'chat.strictness'] as const;
const LIMIT_PATHS = ['rooms.maxRooms', 'rooms.maxPlayingRooms', 'rooms.maxRoomsPerAddress'] as const;
const MOD_PATHS = ['chat.strikes', 'chat.retention', 'chat.recordsDays', 'chat.strictness'] as const;
const POLICY_PATHS = ['chat.tags', 'chat.tagDefault', 'chat.retention', 'chat.recordsDays', 'chat.addressMinimisation', 'moderators'] as const;
const GATE_PATHS = ['rooms.maxConnections', 'rooms.maxConnectionsPerAddress'] as const;
const AUTH_PATHS = ['accounts', 'serverName', 'mail'] as const;
const MAIL_PATHS = ['mail', 'alerts'] as const;

const hits = (changed: readonly string[], paths: readonly string[]): boolean =>
  changed.includes('*') || changed.some((c) => paths.some((p) => c === p || c.startsWith(`${p}.`)));

/**
 * Apply the settings to every component now, and again after each saved change (only the parts that changed).
 * Each component is isolated: one failing never stops the others. Returns the unsubscribe.
 */
export function bindSettings(service: SettingsService, targets: SettingsTargets): () => void {
  const log = targets.log ?? ((line: string) => console.log(line));
  const missing = new Set<string>();
  const skip = (what: string): void => {
    if (missing.has(what)) return;
    missing.add(what);
    log(`[settings] ${what} is not available yet — that setting applies after a restart`);
  };
  const guard = (what: string, fn: () => void): void => {
    try { fn(); } catch (e) { log(`[settings] could not apply ${what}: ${(e as Error)?.message ?? e}`); }
  };

  const apply = (s: HostSettings, changed: readonly string[]): void => {
    const z = targets.zone;
    if (z && hits(changed, ZONE_PATHS)) {
      guard('the chat options', () => {
        if (typeof z.setChatOptions !== 'function') { skip('Zone.setChatOptions'); return; }
        const r = z.setChatOptions(zoneChatOptionsOf(s)) as { ok?: boolean; error?: string } | undefined;
        if (r && r.ok === false) log(`[settings] the Zone refused the chat options: ${r.error ?? 'unknown'}`);
      });
    }
    if (z && hits(changed, LIMIT_PATHS)) {
      guard('the room limits', () => {
        if (typeof z.setLimits !== 'function') { skip('Zone.setLimits'); return; }
        z.setLimits(zoneLimitsOf(s));
      });
    }
    const m = targets.moderation;
    if (m && hits(changed, MOD_PATHS)) {
      guard('the moderation config', () => {
        const c = moderationConfigOf(s);
        if (typeof m.setConfig === 'function') m.setConfig(c);
        else if (m.config && typeof m.config === 'object') Object.assign(m.config, c);
        else skip('ModerationService.setConfig');
      });
    }
    if (m && hits(changed, POLICY_PATHS) && typeof m.setPolicy === 'function') {
      guard('the moderation policy', () => { m.setPolicy!(moderationPolicyOf(s)); });
    }
    const g = targets.gate;
    if (g && hits(changed, GATE_PATHS)) {
      guard('the connection limits', () => { Object.assign(g.limits, gateLimitsOf(s)); });
    }
    const a = targets.auth;
    if (a && hits(changed, AUTH_PATHS)) {
      guard('the account policy', () => {
        if (typeof a.setPolicy === 'function') a.setPolicy(accountPolicyOf(s, service.mailReady()));
      });
    }
    if (a && (hits(changed, MAIL_PATHS) || changed.includes('mail.password'))) {
      guard('the mail settings', () => {
        if (typeof a.reconfigureMail === 'function') a.reconfigureMail(mailConfigOf(s, service.mailPassword()));
      });
    }
  };

  return service.subscribe((next, _prev, changed) => apply(next, changed), { immediate: true });
}

// ------------------------------------------------------------------------------------------
// The audit trail
// ------------------------------------------------------------------------------------------

/** What auditToModeration needs: ModerationService.audit (the row lands in mod_actions with action 'settings'). */
export interface AuditTarget {
  audit(actor: { accountId: string; name: string }, action: string, target: null, reason: string): void;
}

/** Settings audit rows → mod_actions (`settings`, one row per changed leaf, §5.13; mod_actions.action has no CHECK). */
export function auditToModeration(mod: AuditTarget): SettingsAuditSink {
  return (e) => { mod.audit(e.actor, 'settings', null, e.reason); };
}
