// OWNER: SETTINGS. The host settings (docs/LAN-EDITION-proposal.md §5.13, §4.2, §4.7, §4.10, §5.2, §5.5, §5.8,
// §5.9, §3.1-§3.4, §6.1): the HostSettings shape, the code and preset defaults (Home / School), and validation.
//
// The shape is described once, as data (SETTINGS_SPEC): every leaf has a parser, and the tree says which leaves are
// read-only (system-managed: only the server itself sets them) and which are metadata (rev, timestamps: never
// audited). From that one description come:
//  - patch validation for settings/update (strict: an unknown or read-only key, or a bad value, refuses the whole
//    patch and names the field);
//  - field-by-field loading of a stored or imported config (lenient: a bad leaf falls back to its default, with a
//    warning; §6.5 "Config is validated field by field");
//  - the per-leaf diff behind the audit trail (one `settings` row per changed leaf, §5.13).
// Cross-field rules (the School preset's fixed moderator tier, `forever` retention needing the district tick, the
// self-harm tag's fixed policy, "None" mail security only to a private relay, ...) are in checkRules().
//
// No secrets live here: the SMTP password is write-only (`mail.password` in a patch) and is stored by the service
// in data\secrets\smtp.secret (../secrets.ts); the config only records `mail.passwordSet` and `mail.passwordRev`.
import { createHash } from 'node:crypto';
import { domainToASCII, domainToUnicode } from 'node:url';
import { filterChat, type Strictness } from '../../shared/moderation/filter';
import {
  DEFAULT_POSITIVE_LINES, POSITIVE_LINE_MAX_LEN, POSITIVE_LINES_MAX, POSITIVE_LINES_MIN,
  TAG_GANG, TAG_HATE, TAG_PROFANITY, TAG_SELF_HARM, TAG_THREAT, TAG_VULGAR,
} from '../../shared/room/moderation';

// ------------------------------------------------------------------------------------------
// Types
// ------------------------------------------------------------------------------------------

/**
 * The config file's own format version (migrateConfig in store.ts upgrades older ones). 2 (0.6.0-m1.1): the folder
 * permission check never blocks by default, so a version-1 `launcher.permissions: 'refuse'` (only ever the old School
 * preset default: no page could set it) becomes 'warn'.
 */
export const CONFIG_VERSION = 2;

export type Preset = 'home' | 'school';
export const PRESETS: readonly Preset[] = ['home', 'school'];
/** First-run setup's choice in School (§4.10): school email with a code, or a class roster. */
export type AccountsMode = 'email' | 'roster';

export type SignupMode = 'open' | 'rosterOnly';
export type EmailMode = 'optional' | 'required';
export type ExistingAccounts = 'grandfather' | 'verifyAtNextLogin';
export type EmailStorage = 'full' | 'hashOnly';
export type SignInOverHttp = 'allow' | 'warn' | 'block';
export type SessionStore = 'local' | 'session';
export type RateLimitMode = 'normal' | 'scaled';
export type MailPreset = 'relay' | 'gmail' | 'm365' | 'generic';
/** 'starttls' = port 587 with STARTTLS required; 'tls' = implicit TLS (465); 'none' = only to a private relay. */
export type MailSecurity = 'starttls' | 'tls' | 'none';
export type RetentionMode = 'days' | 'term' | 'forever';
export type TagNotify = 'none' | 'banner' | 'urgent';
/** Substitution modes offered in Settings (the Zone's test-only 'masked' is not one of them). */
export type HostSubstituteMode = 'sender' | 'system' | 'hide';
export type RemoteAccess = 'off' | 'limited' | 'full';
export type ModeratorTier = 'limited' | 'trusted';
export type PortAutoPick = 'firstRun' | 'never';
export type CertScope = 'pc' | 'network';
export type NewRootPolicy = 'ask' | 'never';
export type LauncherPolicy = 'warn' | 'refuse';
/** The folder permission check (§2.2 step 3): 'off' skips it (a host without administrator rights who doesn't mind). */
export type PermissionsPolicy = LauncherPolicy | 'off';

/** One allowed email domain (§4.3), stored in ASCII (punycode). `subdomains` also allows `*.domain`. */
export interface EmailDomain { domain: string; subdomains: boolean }

export interface AccountSettings {
  signup: SignupMode;
  email: EmailMode;
  domains: EmailDomain[];
  hostApproval: boolean;
  allowGuests: boolean;
  existingAccounts: ExistingAccounts;
  emailStorage: EmailStorage;
  /** Email reset links (they also need working mail and a verified email). */
  selfServiceReset: boolean;
  selfDelete: boolean;
  signInOverHttp: SignInOverHttp;
  /** Game-session lifetime in hours. */
  sessionHours: number;
  /** The default of the "Public computer" box: 'session' = ticked. */
  sessionStore: SessionStore;
  /** §4.14: 'scaled' always uses the classroom limits; 'normal' scales only when a shared address is detected. */
  rateLimits: RateLimitMode;
}

/** A successful test email (smtp/test) and the mail settings it was made with (mailFingerprint). */
export interface MailTest { at: number; fingerprint: string }

export interface MailSettings {
  preset: MailPreset;
  host: string;
  port: number;
  security: MailSecurity;
  user: string;
  from: string;
  /** Read-only: a password is saved (data\secrets\smtp.secret, or SMTP_PASS on a VPS). Never the password itself. */
  passwordSet: boolean;
  /** Read-only: bumped on every password change, so a mail test made with the old password no longer counts. */
  passwordRev: number;
  /** Read-only: the last successful test email (Required email stays locked until it matches the settings). */
  lastTest: MailTest | null;
}

export interface TagPolicy {
  /** Counts toward the strike limit. */
  strike: boolean;
  /** N strikes from this tag in the strike window → auto-mute (null = never). */
  autoMuteAfter: number | null;
  notify: TagNotify;
  /** Included in the day's counts card. */
  dailySummary: boolean;
}

export interface RetentionSettings {
  mode: RetentionMode;
  /** `days` mode: lines older than this are purged (1-3650). Also the fallback after a term with no next date. */
  days: number;
  /** `term` mode: the term's end date (YYYY-MM-DD); nothing is purged before it. */
  termEnd: string | null;
  /** School: `forever` needs the tick "My district approved keeping chat until I delete it". */
  districtApproved: boolean;
}

export interface ClassPeriod {
  name: string;
  /** HH:MM, 24-hour, host local time. */
  start: string;
  end: string;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
}

export interface StrikeSettings {
  /** MOD_STRIKE_LIMIT: blocked lines within the window that trigger an automatic mute. */
  limit: number;
  /** MOD_STRIKE_WINDOW_MIN. */
  windowMin: number;
  /** MOD_AUTOMUTE_MIN: the automatic mute's length. */
  autoMuteMin: number;
}

export interface ChatSettings {
  strictness: Strictness;
  /** The host's own line added to the generated chat notice (at most 200 characters, filtered). */
  notice: string;
  retention: RetentionSettings;
  /** Reports, audit, ended bans and conduct counters (days). */
  recordsDays: number;
  classPeriods: ClassPeriod[];
  /** Per-tag policy (§5.8), keyed by tag label (the built-in tags plus confirmed custom labels). */
  tags: Record<string, TagPolicy>;
  /** The policy of custom labels without their own row ("Other custom labels"). */
  tagDefault: TagPolicy;
  substitute: HostSubstituteMode;
  positiveLines: string[];
  /** §6.4: account lines lose their address after 7 days; guest lines keep only the address tag. */
  addressMinimisation: boolean;
  strikes: StrikeSettings;
}

export interface AdminSettings {
  remoteAccess: RemoteAccess;
  /** Admin-session idle timeout (5-240 minutes). */
  idleMinutes: number;
  /** Step-up freshness for ★ actions (5-30 minutes). */
  stepUpMinutes: number;
  /** An open Live view keeps a localhost session alive (at most 3 h). */
  liveKeepsAlive: boolean;
  /** Presenting mode is on when the panel opens (School). */
  presentingAtLogin: boolean;
}

export interface ModeratorSettings {
  /** moderatorView: moderators may sign in to the panel's Moderator view. */
  view: boolean;
  /** moderatorLogSearch: trusted moderators may search the Chat log. */
  logSearch: boolean;
  /** moderators.tier (§5.2): fixed to 'limited' in the School preset. */
  tier: ModeratorTier;
}

export interface RoomLimits {
  /** House rooms count (5-24). */
  maxRooms: number;
  maxPlayingRooms: number;
  maxRoomsPerAddress: number;
  /** WebSocket connections in total (ConnectionGate). */
  maxConnections: number;
  maxConnectionsPerAddress: number;
}

/** A network the host approved (or refused) serving players on (network/approve; §3.1). */
export interface ApprovedNetwork { id: string; serve: boolean; at: number }

export interface NetworkSettings {
  /** The game port P (restart needed). */
  port: number;
  /** The admin port A (P+1 unless changed; restart needed). */
  adminPort: number;
  portAutoPick: PortAutoPick;
  /** Pin the primary address to one adapter (its name or IPv4); null = the default route. */
  serveOnAdapter: string | null;
  /** "Devices here trust this server's certificate": QR → https, http → https redirect, remote `full` allowed. */
  devicesTrustCert: boolean;
  /** IT's extra names / addresses (exact names, never a whole domain). */
  extraNames: string[];
  /** Read-only: the host installed its own certificate (cert/own). */
  ownCertificate: boolean;
  /** 443 plus 80 (advanced). */
  standardPorts: boolean;
  openBrowser: boolean;
  /** The scope of a new root: this PC's address (/32) or this network (/24). */
  certScope: CertScope;
  /** A new root for a new network: 'ask' (Home) or 'never' automatically (School). */
  newRoot: NewRootPolicy;
  /** Read-only here (network/approve). */
  approvedNetworks: ApprovedNetwork[];
}

export interface LauncherSettings {
  /** Started as administrator. */
  elevated: LauncherPolicy;
  /** Folder permission problems ('off': not checked at all; the panel's "Don't warn me again"). */
  permissions: PermissionsPolicy;
}

export interface BackupSettings {
  daily: boolean;
  /** "Also copy backups to" (a USB stick or district share; the launcher copies). '' = off. */
  copyTo: string;
  /** Total size cap in MB (the oldest go first). */
  sizeCapMB: number;
}

export interface HostSettings {
  /** Read-only metadata. */
  configVersion: number;
  /** Read-only: bumped on every saved change; settings/update must send the rev it read (409 otherwise). */
  rev: number;
  /** Read-only: a random id for this install (backups, the recovery file). */
  installId: string;
  createdAt: number;
  updatedAt: number;
  /** Read-only: the environment variables that seeded this config on its first run. */
  seededFromEnv: string[];
  /** Read-only here: chosen at first-run setup (SettingsService.applyPreset). */
  preset: Preset;
  serverName: string;
  accounts: AccountSettings;
  mail: MailSettings;
  alerts: { /** Content-free host alert emails go here ('' = off). */ email: string };
  chat: ChatSettings;
  admin: AdminSettings;
  moderators: ModeratorSettings;
  rooms: RoomLimits;
  network: NetworkSettings;
  launcher: LauncherSettings;
  backups: BackupSettings;
  /** Optional integrations: only the seam exists in 0.6.0 (always disabled). */
  integrations: { hostedModeration: { enabled: boolean } };
}

type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> | null } : T;
/**
 * A settings/update patch: any subset of the writable leaves. `mail.password` is write-only (a string saves it,
 * '' or null removes it). Maps (`chat.tags`) merge per key; `null` removes a custom tag's row.
 */
export type SettingsPatch = DeepPartial<HostSettings> & { mail?: DeepPartial<MailSettings> & { password?: string | null } };

// ------------------------------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------------------------------

export const DEFAULT_SERVER_NAME = 'Voidswarm';
export const SERVER_NAME_MAX = 60;
export const NOTICE_MAX = 200;
export const MAX_DOMAINS = 20;
export const MAX_CLASS_PERIODS = 24;
export const MAX_EXTRA_NAMES = 16;
export const MAX_APPROVED_NETWORKS = 64;
export const MAX_CUSTOM_TAGS = 64;
export const TAG_LABEL_MAX = 24;
export const SMTP_PASSWORD_MAX = 1024;
/** `term` retention: lines older than the end date go this many days after it (§5.5). */
export const TERM_GRACE_DAYS = 14;
/** The owner's defaults (§5.5 and Owner decisions). */
export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_RECORDS_DAYS = 365;
export const DEFAULT_GAME_PORT = 7777;
export const DEFAULT_SIZE_CAP_MB = 2048;
/** The secret file that holds the SMTP password (data\secrets\smtp.secret). */
export const SMTP_SECRET = 'smtp.secret';

/** Written to the audit trail instead of a secret's value (§5.13). */
export const SECRET_CHANGED = '(changed)';

/** The §5.8 default tag policy (A1). SELF-HARM's strike and auto-mute are fixed; its notify is at least `banner`. */
export function defaultTagPolicies(): Record<string, TagPolicy> {
  return {
    [TAG_THREAT]: { strike: true, autoMuteAfter: 2, notify: 'urgent', dailySummary: true },
    [TAG_SELF_HARM]: { strike: false, autoMuteAfter: null, notify: 'urgent', dailySummary: true },
    [TAG_HATE]: { strike: true, autoMuteAfter: 3, notify: 'banner', dailySummary: true },
    [TAG_GANG]: { strike: true, autoMuteAfter: 3, notify: 'banner', dailySummary: true },
    [TAG_PROFANITY]: { strike: true, autoMuteAfter: 3, notify: 'none', dailySummary: true },
    [TAG_VULGAR]: { strike: true, autoMuteAfter: 3, notify: 'none', dailySummary: true },
  };
}
/** Built-in tags always have a row (they can't be removed). */
export const FIXED_TAGS: readonly string[] = [TAG_THREAT, TAG_SELF_HARM, TAG_HATE, TAG_GANG, TAG_PROFANITY, TAG_VULGAR];
export const DEFAULT_TAG_DEFAULT: Readonly<TagPolicy> = Object.freeze({ strike: false, autoMuteAfter: null, notify: 'none', dailySummary: true });

// ------------------------------------------------------------------------------------------
// Defaults and presets
// ------------------------------------------------------------------------------------------

export interface DefaultsOptions {
  preset?: Preset;
  /** The LAN edition (true) or the VPS / `npm start` (false, the code defaults for rooms). Default true. */
  lan?: boolean;
  accountsMode?: AccountsMode;
}

/** The code defaults, with the preset applied (§4.2, §5.9, §5.13). Metadata is zero (the store fills it in). */
export function defaultSettings(opts: DefaultsOptions = {}): HostSettings {
  const lan = opts.lan !== false;
  const s: HostSettings = {
    configVersion: CONFIG_VERSION,
    rev: 0,
    installId: '',
    createdAt: 0,
    updatedAt: 0,
    seededFromEnv: [],
    preset: 'home',
    serverName: DEFAULT_SERVER_NAME,
    accounts: {
      signup: 'open', email: 'optional', domains: [], hostApproval: false, allowGuests: true,
      existingAccounts: 'verifyAtNextLogin', emailStorage: 'full', selfServiceReset: true, selfDelete: true,
      signInOverHttp: 'warn', sessionHours: 720, sessionStore: 'local', rateLimits: 'normal',
    },
    mail: { preset: 'relay', host: '', port: 587, security: 'starttls', user: '', from: '', passwordSet: false, passwordRev: 0, lastTest: null },
    alerts: { email: '' },
    chat: {
      strictness: 'strict',
      notice: '',
      retention: { mode: 'days', days: DEFAULT_RETENTION_DAYS, termEnd: null, districtApproved: false },
      recordsDays: DEFAULT_RECORDS_DAYS,
      classPeriods: [],
      tags: defaultTagPolicies(),
      tagDefault: { ...DEFAULT_TAG_DEFAULT },
      substitute: 'sender',
      positiveLines: [...DEFAULT_POSITIVE_LINES],
      addressMinimisation: false,
      strikes: { limit: 3, windowMin: 10, autoMuteMin: 10 },
    },
    admin: { remoteAccess: 'off', idleMinutes: 30, stepUpMinutes: 10, liveKeepsAlive: true, presentingAtLogin: false },
    moderators: { view: false, logSearch: false, tier: 'limited' },
    rooms: {
      // §5.9: the LAN default is 12 rooms (house rooms count); the VPS keeps the code defaults (Zone MAX_ROOMS 24,
      // MAX_ROOMS_PER_ADDRESS 6).
      maxRooms: lan ? 12 : 24, maxPlayingRooms: 6, maxRoomsPerAddress: lan ? 3 : 6, maxConnections: 512, maxConnectionsPerAddress: 64,
    },
    network: {
      port: DEFAULT_GAME_PORT, adminPort: DEFAULT_GAME_PORT + 1, portAutoPick: 'firstRun', serveOnAdapter: null,
      devicesTrustCert: false, extraNames: [], ownCertificate: false, standardPorts: false, openBrowser: true,
      certScope: 'network', newRoot: 'ask', approvedNetworks: [],
    },
    launcher: { elevated: 'warn', permissions: 'warn' },
    backups: { daily: true, copyTo: '', sizeCapMB: DEFAULT_SIZE_CAP_MB },
    integrations: { hostedModeration: { enabled: false } },
  };
  return deepAssign(s, presetValues(opts.preset ?? 'home', { lan, accountsMode: opts.accountsMode })) as HostSettings;
}

/**
 * The values a preset sets (§5.13's preset table, plus the §4.2 rows that differ between Home and School). Setup
 * applies them once; every value can still be changed afterwards (except School's fixed moderator tier).
 * `accountsMode` (School setup: school email or class roster) sets `signup` too; without it `signup` is untouched.
 */
export function presetValues(preset: Preset, opts: { lan?: boolean; accountsMode?: AccountsMode } = {}): SettingsPatch {
  const lan = opts.lan !== false;
  const school = preset === 'school';
  const roster = opts.accountsMode === 'roster';
  const accounts: { -readonly [K in keyof AccountSettings]?: AccountSettings[K] } = {
    // School: guest play is off (accountability: required email + domains, or roster accounts, §4.2 / §8.2).
    allowGuests: school ? false : !roster,
    signInOverHttp: school ? 'block' : 'warn',
    sessionHours: school ? 12 : 720,
    sessionStore: school ? 'session' : 'local',
    selfDelete: !school,
    rateLimits: school ? 'scaled' : 'normal',
  };
  if (opts.accountsMode) accounts.signup = roster ? 'rosterOnly' : 'open';
  return {
    preset,
    accounts,
    chat: { strictness: 'strict', addressMinimisation: school },
    admin: { presentingAtLogin: school },
    moderators: { tier: 'limited' },
    rooms: { maxRoomsPerAddress: school ? 6 : lan ? 3 : 6, maxConnectionsPerAddress: school ? 128 : 64 },
    network: { certScope: school ? 'pc' : 'network', newRoot: school ? 'never' : 'ask', portAutoPick: school ? 'never' : 'firstRun' },
    // The permission check warns in both presets (0.6.0-m1.1): a teacher without administrator rights must be able
    // to host; 'refuse' stays available.
    launcher: { elevated: school ? 'refuse' : 'warn', permissions: 'warn' },
  };
}

// ------------------------------------------------------------------------------------------
// Small parsers
// ------------------------------------------------------------------------------------------

export type Parsed<T = unknown> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Control characters, line / paragraph separators and bidi overrides: never in a one-line setting. */
const UNSAFE_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TAG_LABEL_RE = /^[A-Z0-9][A-Z0-9 -]{0,23}$/;

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

export const isIPv4 = (s: string): boolean => IPV4_RE.test(s);

/** A private (RFC 1918) or loopback IPv4 address, or `localhost` (§4.7: "None" security only to such a relay). */
export function isPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === 'localhost') return true;
  if (!isIPv4(h)) return false;
  const [a, b] = h.split('.').map(Number) as [number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** A DNS host name in ASCII (single-label names such as a PC name allowed), or an IPv4 address. */
export function isHostName(s: string): boolean {
  if (!s || s.length > 253) return false;
  if (isIPv4(s)) return true;
  const labels = s.split('.');
  if (labels.some((l) => !LABEL_RE.test(l))) return false;
  return !/^\d+$/.test(labels[labels.length - 1]!); // "10.0.0" is not a name
}

/**
 * §4.3: an allowed email domain → its stored ASCII form. Trim, NFC, lower case, IDN → punycode (domainToASCII);
 * no IP literals, empty labels or trailing dot; at least two labels.
 */
export function normalizeDomain(input: string): Parsed<string> {
  const d = input.normalize('NFC').trim().toLowerCase();
  if (!d) return bad('Enter a domain, for example example.org.');
  if (d.length > 253 || UNSAFE_CHARS_RE.test(d) || /\s/.test(d)) return bad("That doesn't look like a domain.");
  if (d.includes('[') || d.includes(']') || d.includes(':') || isIPv4(d) || /^[\d.]+$/.test(d)) return bad("An IP address can't be an email domain.");
  if (d.endsWith('.')) return bad('Remove the dot at the end of the domain.');
  if (d.split('.').some((l) => !l)) return bad("That domain has an empty part (two dots in a row).");
  const ascii = domainToASCII(d);
  if (!ascii) return bad("That doesn't look like a domain.");
  const labels = ascii.split('.');
  if (labels.length < 2) return bad('Use the whole domain, for example example.org.');
  if (labels.some((l) => !LABEL_RE.test(l)) || /^\d+$/.test(labels[labels.length - 1]!)) return bad("That doesn't look like a domain.");
  return ok(ascii);
}

/** The stored (punycode) domain as the host typed it (for display). */
export const domainForDisplay = (ascii: string): string => domainToUnicode(ascii) || ascii;

/** "example.org", "@example.org", "*.example.org" or { domain, subdomains }. */
export function parseDomainEntry(v: unknown): Parsed<EmailDomain> {
  let raw: string;
  let subdomains = false;
  if (typeof v === 'string') {
    raw = v.trim();
    if (raw.startsWith('*.')) { subdomains = true; raw = raw.slice(2); }
  } else if (isPlainObject(v) && typeof v.domain === 'string') {
    raw = v.domain.trim();
    if (v.subdomains !== undefined && typeof v.subdomains !== 'boolean') return bad('subdomains must be true or false.');
    subdomains = v.subdomains === true;
    if (raw.startsWith('*.')) { subdomains = true; raw = raw.slice(2); }
  } else {
    return bad('Each domain is a name like example.org.');
  }
  if (raw.startsWith('@')) raw = raw.slice(1);
  const d = normalizeDomain(raw);
  return d.ok ? ok({ domain: d.value, subdomains }) : d;
}

/**
 * The allowed domains: at most MAX_DOMAINS entries; the same domain twice is one entry (with subdomains if either
 * asked for them), so "example.org,*.example.org" is one domain with its subdomains.
 */
export function parseDomainList(v: unknown): Parsed<EmailDomain[]> {
  if (!Array.isArray(v)) return bad('The email domains must be a list.');
  const out: EmailDomain[] = [];
  for (let i = 0; i < v.length; i++) {
    const p = parseDomainEntry(v[i]);
    if (!p.ok) return bad(v.length > 1 ? `Email domain ${i + 1}: ${p.error}` : p.error);
    const same = out.find((d) => d.domain === p.value.domain);
    if (same) same.subdomains ||= p.value.subdomains;
    else out.push(p.value);
  }
  if (out.length > MAX_DOMAINS) return bad(`Allow at most ${MAX_DOMAINS} email domains.`);
  return ok(out);
}

/** A plain email address (the host's alert address). */
export function isEmailAddress(s: string): boolean {
  if (s.length > 254 || UNSAFE_CHARS_RE.test(s) || /\s/.test(s)) return false;
  const at = s.lastIndexOf('@');
  if (at < 1 || at > 64) return false;
  const local = s.slice(0, at);
  if (/["(),:;<>[\\\]]/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  return normalizeDomain(s.slice(at + 1)).ok;
}

/** A From header: `address` or `Name <address>` (no line breaks: header injection). */
export function isFromHeader(s: string): boolean {
  if (s.length > 320 || UNSAFE_CHARS_RE.test(s)) return false;
  const m = /^\s*([^<>]*?)\s*<([^<>]+)>\s*$/.exec(s);
  return m ? isEmailAddress(m[2]!.trim()) : isEmailAddress(s.trim());
}

/** A valid calendar date YYYY-MM-DD. */
export function isIsoDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2200) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** A tag key: upper case, spaces / underscores folded (as the chat tags are, `tagOfCategory`). */
export function tagKey(k: string): string | null {
  const t = k.trim().toUpperCase().replace(/[\s_]+/g, ' ');
  return TAG_LABEL_RE.test(t) ? t : null;
}

/**
 * The filter's verdict on a host-written line: 'pass' (and review-only 'flag' when `allowFlag`) are fine.
 * `builtinOnly` leaves the host's custom terms out (load-time repair: a host-supplied, possibly unconfirmed term
 * never deletes the host's own lines or name from the config; the Zone skips a line the installed set catches).
 */
function filterOk(text: string, strictness: Strictness, allowFlag: boolean, builtinOnly = false): boolean {
  try {
    const a = filterChat(text, builtinOnly ? { strictness, custom: null } : { strictness }).action;
    return a === 'pass' || (allowFlag && a === 'flag');
  } catch {
    return false;
  }
}

/**
 * The positive lines the chat filter catches now, with the installed custom terms (the Zone skips them). A custom
 * term added after the lines were saved can catch one: Settings shows them, and the host edits the list.
 */
export function failingPositiveLines(s: HostSettings): string[] {
  return s.chat.positiveLines.filter((l) => !filterOk(l, s.chat.strictness, false));
}

/**
 * "Also copy backups to" (§6.1): a full folder path — a drive (E:\Voidswarm backups), a share
 * (\\district-fs\share\voidswarm) or, on a Mac / Linux host, /media/usb/voidswarm. Never relative (the launcher
 * would resolve it against its own folder), never with `.` / `..` parts, device paths (\\?\, \\.\) or an NTFS
 * stream (`:` after the drive).
 */
function parseCopyTo(v: unknown): Parsed<string> {
  const p = oneLine(v, 'The backup copy folder', 260);
  if (!p.ok || !p.value) return p;
  const s = p.value;
  const example = 'Use a full folder path, for example E:\\Voidswarm backups or \\\\district-fs\\share\\voidswarm.';
  const drive = /^[A-Za-z]:[\\/]/.test(s);
  const share = /^(\\\\|\/\/)/.test(s);
  const posixAbs = s.startsWith('/') && !share;
  if (!drive && !share && !posixAbs) return bad(example);
  if (/[<>"|?*]/.test(s) || (drive ? s.slice(2) : s).includes(':')) return bad("The backup copy folder can't contain < > \" | ? * or : (except after the drive letter).");
  const parts = s.split(/[\\/]+/);
  if (parts.some((x) => x === '.' || x === '..')) return bad("The backup copy folder can't contain . or .. parts: " + example);
  if (share) {
    const [server, shareName] = s.slice(2).split(/[\\/]/);
    if (!server || !shareName || server === '.' || server === '?') return bad(example);
  }
  return ok(s);
}

/** Collapse whitespace; refuse control characters and bidi overrides. */
function oneLine(v: unknown, label: string, max: number, min = 0): Parsed<string> {
  if (typeof v !== 'string') return bad(`${label} must be text.`);
  if (UNSAFE_CHARS_RE.test(v)) return bad(`${label} can't contain line breaks or control characters.`);
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length < min) return bad(min === 1 ? `${label} can't be empty.` : `${label} needs at least ${min} characters.`);
  if (s.length > max) return bad(`${label} can be at most ${max} characters.`);
  return ok(s);
}

// ------------------------------------------------------------------------------------------
// The spec
// ------------------------------------------------------------------------------------------

interface SpecBase {
  /** System-managed: only SettingsService.apply(..., { system: true }) may set it (never settings/update). */
  ro?: boolean;
  /** Metadata: never diffed or audited. */
  meta?: boolean;
}
export interface LeafSpec extends SpecBase { k: 'leaf'; parse(v: unknown): Parsed }
export interface ObjSpec extends SpecBase { k: 'obj'; fields: Readonly<Record<string, Spec>> }
export interface MapSpec extends SpecBase {
  k: 'map';
  key(k: string): string | null;
  of: ObjSpec;
  /** Keys that always exist and can't be removed. */
  fixed: readonly string[];
  max: number;
  /** The starting values of a new key (e.g. chat.tagDefault). */
  template(root: HostSettings): Record<string, unknown>;
}
export type Spec = LeafSpec | ObjSpec | MapSpec;

const leaf = (parse: (v: unknown) => Parsed, flags: SpecBase = {}): LeafSpec => ({ k: 'leaf', parse, ...flags });
const obj = (fields: Record<string, Spec>, flags: SpecBase = {}): ObjSpec => ({ k: 'obj', fields, ...flags });

function oneOf<T extends string>(label: string, values: readonly T[], flags: SpecBase = {}): LeafSpec {
  return leaf((v) => (typeof v === 'string' && (values as readonly string[]).includes(v)
    ? ok(v)
    : bad(`${label} must be one of: ${values.join(', ')}.`)), flags);
}
function int(label: string, min: number, max: number, flags: SpecBase = {}): LeafSpec {
  return leaf((v) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
    ? ok(v)
    : bad(`${label} must be a whole number from ${min} to ${max}.`)), flags);
}
function bool(label: string, flags: SpecBase = {}): LeafSpec {
  return leaf((v) => (typeof v === 'boolean' ? ok(v) : bad(`${label} must be true or false.`)), flags);
}
function nullable(inner: LeafSpec): LeafSpec {
  return leaf((v) => (v === null ? ok(null) : inner.parse(v)), { ro: inner.ro, meta: inner.meta });
}
function list<T>(label: string, max: number, item: (v: unknown, i: number) => Parsed<T>, key?: (t: T) => string, flags: SpecBase = {}): LeafSpec {
  return leaf((v) => {
    if (!Array.isArray(v)) return bad(`${label} must be a list.`);
    if (v.length > max) return bad(`${label} can have at most ${max} entries.`);
    const out: T[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < v.length; i++) {
      const p = item(v[i], i);
      if (!p.ok) return bad(v.length > 1 ? `${label}, entry ${i + 1}: ${p.error}` : p.error);
      const k = key ? key(p.value) : null;
      if (k !== null) { if (seen.has(k)) continue; seen.add(k); } // duplicates are dropped
      out.push(p.value);
    }
    return ok(out);
  }, flags);
}

const tagPolicySpec: ObjSpec = obj({
  strike: bool('strike'),
  autoMuteAfter: nullable(int('autoMuteAfter', 1, 100)),
  notify: oneOf('notify', ['none', 'banner', 'urgent'] as const),
  dailySummary: bool('dailySummary'),
});

function parsePeriod(v: unknown): Parsed<ClassPeriod> {
  if (!isPlainObject(v)) return bad('A class period has a name, a start and an end time.');
  const name = oneLine(v.name, 'The period name', 40, 1);
  if (!name.ok) return name;
  if (typeof v.start !== 'string' || !TIME_RE.test(v.start) || typeof v.end !== 'string' || !TIME_RE.test(v.end)) {
    return bad('Class period times are HH:MM (24-hour), for example 08:05.');
  }
  if (v.end <= v.start) return bad(`"${name.value}" must end after it starts.`);
  let days = [1, 2, 3, 4, 5];
  if (v.days !== undefined) {
    if (!Array.isArray(v.days) || !v.days.length || v.days.some((d) => typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6)) {
      return bad('Class period days are numbers from 0 (Sunday) to 6 (Saturday).');
    }
    days = [...new Set(v.days as number[])].sort((a, b) => a - b);
  }
  return ok({ name: name.value, start: v.start, end: v.end, days });
}

function parseExtraName(v: unknown): Parsed<string> {
  if (typeof v !== 'string') return bad('An extra name is a host name or an IPv4 address.');
  const s = v.trim().toLowerCase().replace(/\.$/, '');
  if (s.includes('*')) return bad('Use exact names, never a whole domain (*).');
  const ascii = isIPv4(s) ? s : domainToASCII(s);
  if (!ascii || !isHostName(ascii)) return bad(`"${s.slice(0, 64)}" isn't a host name or an IPv4 address.`);
  return ok(ascii);
}

function parseApproved(v: unknown): Parsed<ApprovedNetwork> {
  if (!isPlainObject(v) || typeof v.id !== 'string' || !v.id || v.id.length > 64 || UNSAFE_CHARS_RE.test(v.id)
    || typeof v.serve !== 'boolean' || typeof v.at !== 'number' || !Number.isFinite(v.at) || v.at < 0) {
    return bad('An approved network is { id, serve, at }.');
  }
  return ok({ id: v.id, serve: v.serve, at: Math.floor(v.at) });
}

function parseMailTest(v: unknown): Parsed<MailTest> {
  if (!isPlainObject(v) || typeof v.at !== 'number' || !Number.isFinite(v.at) || v.at < 0
    || typeof v.fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(v.fingerprint)) {
    return bad('lastTest is { at, fingerprint }.');
  }
  return ok({ at: Math.floor(v.at), fingerprint: v.fingerprint });
}

/**
 * The positive lines (§5.8): each 1..60 characters after collapsing whitespace; duplicates (any case) dropped;
 * 5..200 lines. The filter check needs the final strictness, so it is in checkRules().
 */
function parsePositiveLines(v: unknown): Parsed<string[]> {
  if (!Array.isArray(v)) return bad('The positive lines are a list of short lines.');
  if (v.length > POSITIVE_LINES_MAX) return bad(`Keep at most ${POSITIVE_LINES_MAX} positive lines.`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < v.length; i++) {
    const p = oneLine(v[i], `Positive line ${i + 1}`, POSITIVE_LINE_MAX_LEN, 1);
    if (!p.ok) return p;
    const k = p.value.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p.value);
  }
  if (out.length < POSITIVE_LINES_MIN) return bad(`Keep at least ${POSITIVE_LINES_MIN} different positive lines.`);
  return ok(out);
}

const text = (label: string, max: number, min = 0, extra?: (s: string) => string | null, flags: SpecBase = {}): LeafSpec =>
  leaf((v) => {
    const p = oneLine(v, label, max, min);
    if (!p.ok) return p;
    const e = extra && p.value ? extra(p.value) : null;
    return e ? bad(e) : p;
  }, flags);

/** The whole settings tree, as data. */
export const SETTINGS_SPEC: ObjSpec = obj({
  configVersion: int('configVersion', 1, 1000, { ro: true, meta: true }),
  rev: int('rev', 0, Number.MAX_SAFE_INTEGER, { ro: true, meta: true }),
  installId: leaf((v) => (typeof v === 'string' && /^[0-9a-f]{0,32}$/.test(v) ? ok(v) : bad('installId is hex.')), { ro: true, meta: true }),
  createdAt: int('createdAt', 0, Number.MAX_SAFE_INTEGER, { ro: true, meta: true }),
  updatedAt: int('updatedAt', 0, Number.MAX_SAFE_INTEGER, { ro: true, meta: true }),
  seededFromEnv: list('seededFromEnv', 64, (v) => (typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(v) ? ok(v) : bad('an environment variable name')),
    (s) => s, { ro: true, meta: true }),
  preset: oneOf('preset', PRESETS, { ro: true }),
  // The chat-filter checks of the server name, the notice and the positive lines are in checkRules / repairSettings
  // (they depend on the host's custom terms, so they run only when the value itself changes).
  serverName: text('The server name', SERVER_NAME_MAX, 1),
  accounts: obj({
    signup: oneOf('accounts.signup', ['open', 'rosterOnly'] as const),
    email: oneOf('accounts.email', ['optional', 'required'] as const),
    domains: leaf(parseDomainList),
    hostApproval: bool('accounts.hostApproval'),
    allowGuests: bool('accounts.allowGuests'),
    existingAccounts: oneOf('accounts.existingAccounts', ['grandfather', 'verifyAtNextLogin'] as const),
    emailStorage: oneOf('accounts.emailStorage', ['full', 'hashOnly'] as const),
    selfServiceReset: bool('accounts.selfServiceReset'),
    selfDelete: bool('accounts.selfDelete'),
    signInOverHttp: oneOf('accounts.signInOverHttp', ['allow', 'warn', 'block'] as const),
    sessionHours: int('The session length (hours)', 1, 720),
    sessionStore: oneOf('accounts.sessionStore', ['local', 'session'] as const),
    rateLimits: oneOf('accounts.rateLimits', ['normal', 'scaled'] as const),
  }),
  mail: obj({
    preset: oneOf('mail.preset', ['relay', 'gmail', 'm365', 'generic'] as const),
    host: text('The mail server', 253, 0, (s) => {
      const a = isIPv4(s) ? s : domainToASCII(s.toLowerCase());
      return a && isHostName(a) ? null : "The mail server isn't a host name or an IPv4 address.";
    }),
    port: int('The mail port', 1, 65535),
    security: oneOf('mail.security', ['starttls', 'tls', 'none'] as const),
    user: text('The mail username', 254),
    from: text('The From address', 320, 0, (s) => (isFromHeader(s) ? null : 'The From address must be an email address, or Name <address>.')),
    // Not audited itself: the audit trail shows the password change as "mail.password: (changed)".
    passwordSet: bool('mail.passwordSet', { ro: true, meta: true }),
    passwordRev: int('mail.passwordRev', 0, Number.MAX_SAFE_INTEGER, { ro: true, meta: true }),
    lastTest: nullable(leaf(parseMailTest, { ro: true })),
  }),
  alerts: obj({
    email: text('The alert email', 254, 0, (s) => (isEmailAddress(s) ? null : "The alert email isn't an email address.")),
  }),
  chat: obj({
    strictness: oneOf('chat.strictness', ['strict', 'standard'] as const),
    notice: text('The notice line', NOTICE_MAX),
    retention: obj({
      mode: oneOf('chat.retention.mode', ['days', 'term', 'forever'] as const),
      days: int('The chat-log retention (days)', 1, 3650),
      termEnd: nullable(leaf((v) => (typeof v === 'string' && isIsoDate(v) ? ok(v) : bad('The term end is a date, YYYY-MM-DD.')))),
      districtApproved: bool('chat.retention.districtApproved'),
    }),
    recordsDays: int('The records retention (days)', 30, 3650),
    classPeriods: list('The class periods', MAX_CLASS_PERIODS, parsePeriod, (p) => p.name.toLowerCase()),
    tags: {
      k: 'map',
      key: tagKey,
      of: tagPolicySpec,
      fixed: FIXED_TAGS,
      max: FIXED_TAGS.length + MAX_CUSTOM_TAGS,
      template: (root) => ({ ...(root.chat?.tagDefault ?? DEFAULT_TAG_DEFAULT) }),
    },
    tagDefault: tagPolicySpec,
    substitute: oneOf('chat.substitute', ['sender', 'system', 'hide'] as const),
    positiveLines: leaf(parsePositiveLines),
    addressMinimisation: bool('chat.addressMinimisation'),
    strikes: obj({
      limit: int('The strike limit', 1, 100),
      windowMin: int('The strike window (minutes)', 1, 24 * 60),
      autoMuteMin: int('The automatic mute (minutes)', 1, 7 * 24 * 60),
    }),
  }),
  admin: obj({
    remoteAccess: oneOf('admin.remoteAccess', ['off', 'limited', 'full'] as const),
    idleMinutes: int('The idle timeout (minutes)', 5, 240),
    stepUpMinutes: int('The password re-check (minutes)', 5, 30),
    liveKeepsAlive: bool('admin.liveKeepsAlive'),
    presentingAtLogin: bool('admin.presentingAtLogin'),
  }),
  moderators: obj({
    view: bool('moderators.view'),
    logSearch: bool('moderators.logSearch'),
    tier: oneOf('moderators.tier', ['limited', 'trusted'] as const),
  }),
  rooms: obj({
    maxRooms: int('The room limit', 5, 24),
    maxPlayingRooms: int('The playing-room limit', 1, 12),
    maxRoomsPerAddress: int('The rooms per address', 1, 24),
    maxConnections: int('The connection limit', 1, 4096),
    maxConnectionsPerAddress: int('The connections per address', 1, 1024),
  }),
  network: obj({
    port: int('The game port', 1, 65535),
    adminPort: int('The control panel port', 1, 65535),
    portAutoPick: oneOf('network.portAutoPick', ['firstRun', 'never'] as const),
    serveOnAdapter: nullable(text('The adapter', 64, 1)),
    devicesTrustCert: bool('network.devicesTrustCert'),
    extraNames: list('The extra names', MAX_EXTRA_NAMES, parseExtraName, (s) => s),
    ownCertificate: bool('network.ownCertificate', { ro: true }),
    standardPorts: bool('network.standardPorts'),
    openBrowser: bool('network.openBrowser'),
    certScope: oneOf('network.certScope', ['pc', 'network'] as const),
    newRoot: oneOf('network.newRoot', ['ask', 'never'] as const),
    approvedNetworks: list('The approved networks', MAX_APPROVED_NETWORKS, parseApproved, (n) => n.id, { ro: true }),
  }),
  launcher: obj({
    elevated: oneOf('launcher.elevated', ['warn', 'refuse'] as const),
    permissions: oneOf('launcher.permissions', ['warn', 'refuse', 'off'] as const),
  }),
  backups: obj({
    daily: bool('backups.daily'),
    copyTo: leaf(parseCopyTo),
    sizeCapMB: int('The backup size cap (MB)', 256, 1024 * 1024),
  }),
  integrations: obj({
    hostedModeration: obj({ enabled: bool('integrations.hostedModeration.enabled') }),
  }),
});

/** Leaves whose change needs a restart of the host (Settings → Network → port, §5.13). */
export const RESTART_PATHS: readonly string[] = ['network.port', 'network.adminPort', 'network.standardPorts', 'network.serveOnAdapter'];

// ------------------------------------------------------------------------------------------
// Generic walks: patch merge (strict), load (lenient), diff
// ------------------------------------------------------------------------------------------

export interface FieldError { field: string; error: string }

export interface MergeOptions {
  /** Allow read-only (system-managed) leaves (SettingsService.apply with system: true). */
  system?: boolean;
}

const join = (base: string, k: string): string => (base ? `${base}.${k}` : k);

/**
 * Merge a patch into `cur` (which is not modified). Returns the merged tree, or the first error (the field's path
 * and a message for the host). Plain objects merge; leaves (including lists) are replaced.
 */
export function mergePatch(cur: HostSettings, patch: unknown, opts: MergeOptions = {}): Parsed<HostSettings> & { field?: string } {
  const errors: FieldError[] = [];
  const out = mergeObj(SETTINGS_SPEC, cur as unknown as Record<string, unknown>, patch, '', opts, cur, errors);
  if (errors.length) return { ok: false, error: errors[0]!.error, field: errors[0]!.field };
  return ok(out as unknown as HostSettings);
}

function mergeObj(spec: ObjSpec, cur: Record<string, unknown>, patch: unknown, path: string, opts: MergeOptions,
  root: HostSettings, errors: FieldError[]): Record<string, unknown> {
  if (!isPlainObject(patch)) {
    errors.push({ field: path || 'patch', error: `${path || 'The patch'} must be an object.` });
    return cur;
  }
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(patch)) {
    if (errors.length) break;
    const p = join(path, k);
    const fs = Object.prototype.hasOwnProperty.call(spec.fields, k) ? spec.fields[k] : undefined;
    if (!fs) { errors.push({ field: p, error: `Unknown setting: ${p}.` }); break; }
    if (fs.ro && !opts.system) { errors.push({ field: p, error: `${p} is managed by the server and can't be changed here.` }); break; }
    let next: unknown;
    if (fs.k === 'leaf') {
      const r = fs.parse(v);
      if (!r.ok) { errors.push({ field: p, error: r.error }); break; }
      next = r.value;
    } else if (fs.k === 'obj') {
      next = mergeObj(fs, (cur[k] ?? {}) as Record<string, unknown>, v, p, opts, root, errors);
    } else {
      next = mergeMap(fs, (cur[k] ?? {}) as Record<string, unknown>, v, p, opts, root, errors);
    }
    if (errors.length) break;
    out ??= { ...cur };
    out[k] = next;
  }
  return out ?? cur;
}

function mergeMap(spec: MapSpec, cur: Record<string, unknown>, patch: unknown, path: string, opts: MergeOptions,
  root: HostSettings, errors: FieldError[]): Record<string, unknown> {
  if (!isPlainObject(patch)) {
    errors.push({ field: path, error: `${path} must be an object.` });
    return cur;
  }
  const out: Record<string, unknown> = { ...cur };
  for (const [rawKey, v] of Object.entries(patch)) {
    const k = spec.key(rawKey);
    const p = join(path, k ?? rawKey);
    if (!k) { errors.push({ field: p, error: `"${rawKey.slice(0, 30)}" isn't a tag label (letters, digits, spaces and dashes, at most ${TAG_LABEL_MAX}).` }); break; }
    if (v === null) {
      if (spec.fixed.includes(k)) { errors.push({ field: p, error: `The built-in tag ${k} can't be removed.` }); break; }
      delete out[k];
      continue;
    }
    const base = (out[k] ?? spec.template(root)) as Record<string, unknown>;
    const merged = mergeObj(spec.of, base, v, p, opts, root, errors);
    if (errors.length) break;
    // A new key must end up complete (every field of the template is there, so this only guards odd templates).
    out[k] = merged;
  }
  if (!errors.length && Object.keys(out).length > spec.max) errors.push({ field: path, error: `At most ${spec.max} tags can have their own policy.` });
  return out;
}

/**
 * Lenient load (§6.5 "validated field by field"): every leaf of `raw` that parses is kept; a missing leaf takes
 * the default silently; a bad one takes the default and adds a warning. Unknown keys are dropped.
 */
export function coerceSettings(raw: unknown, defaults: HostSettings, warnings: string[] = []): HostSettings {
  return coerceObj(SETTINGS_SPEC, raw, defaults as unknown as Record<string, unknown>, '', defaults, warnings) as unknown as HostSettings;
}

function coerceObj(spec: ObjSpec, raw: unknown, dflt: Record<string, unknown>, path: string, root: HostSettings, warnings: string[]): Record<string, unknown> {
  if (raw === undefined) return structuredClone(dflt);
  if (!isPlainObject(raw)) {
    warnings.push(`${path || 'settings'}: not an object — using the defaults`);
    return structuredClone(dflt);
  }
  const out: Record<string, unknown> = {};
  for (const [k, fs] of Object.entries(spec.fields)) {
    const p = join(path, k);
    const v = raw[k];
    if (fs.k === 'leaf') {
      if (v === undefined) { out[k] = structuredClone(dflt[k]); continue; }
      const r = fs.parse(v);
      if (r.ok) out[k] = r.value;
      else { out[k] = structuredClone(dflt[k]); warnings.push(`${p}: ${r.error} — using the default`); }
    } else if (fs.k === 'obj') {
      out[k] = coerceObj(fs, v, (dflt[k] ?? {}) as Record<string, unknown>, p, root, warnings);
    } else {
      out[k] = coerceMap(fs, v, (dflt[k] ?? {}) as Record<string, unknown>, p, root, warnings);
    }
  }
  return out;
}

function coerceMap(spec: MapSpec, raw: unknown, dflt: Record<string, unknown>, path: string, root: HostSettings, warnings: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of spec.fixed) out[k] = structuredClone(dflt[k] ?? spec.template(root));
  if (raw === undefined) return { ...structuredClone(dflt), ...out };
  if (!isPlainObject(raw)) {
    warnings.push(`${path}: not an object — using the defaults`);
    return { ...structuredClone(dflt), ...out };
  }
  for (const [rawKey, v] of Object.entries(raw)) {
    const k = spec.key(rawKey);
    if (!k) { warnings.push(`${path}: "${rawKey.slice(0, 30)}" isn't a tag label — dropped`); continue; }
    if (Object.keys(out).length >= spec.max && !(k in out)) { warnings.push(`${path}: too many entries — "${k}" dropped`); continue; }
    const base = (dflt[k] ?? out[k] ?? spec.template(root)) as Record<string, unknown>;
    out[k] = coerceObj(spec.of, v, base, join(path, k), root, warnings);
  }
  return out;
}

/** One changed leaf (the audit trail writes one row per entry). */
export interface LeafChange { path: string; old: unknown; new: unknown }

/** Leaf equality; a missing value and null are the same (a new map entry's null leaf is no change). */
const sameValue = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null) || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Every changed leaf between two settings trees (metadata excluded), in spec order. */
export function diffSettings(a: HostSettings, b: HostSettings): LeafChange[] {
  const out: LeafChange[] = [];
  diffObj(SETTINGS_SPEC, a as unknown as Record<string, unknown>, b as unknown as Record<string, unknown>, '', out);
  return out;
}

function diffObj(spec: ObjSpec, a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined, path: string, out: LeafChange[]): void {
  for (const [k, fs] of Object.entries(spec.fields)) {
    if (fs.meta) continue;
    const p = join(path, k);
    const av = a?.[k];
    const bv = b?.[k];
    if (fs.k === 'leaf') {
      if (!sameValue(av, bv)) out.push({ path: p, old: av, new: bv });
    } else if (fs.k === 'obj') {
      diffObj(fs, av as Record<string, unknown> | undefined, bv as Record<string, unknown> | undefined, p, out);
    } else {
      const am = (av ?? {}) as Record<string, unknown>;
      const bm = (bv ?? {}) as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(am), ...Object.keys(bm)])];
      for (const key of keys) diffObj(fs.of, am[key] as Record<string, unknown> | undefined, bm[key] as Record<string, unknown> | undefined, join(p, key), out);
    }
  }
}

/** The value at a dotted path (undefined when absent). */
export function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const k of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Deep-assign plain objects from `src` into `dst` (arrays and leaves replaced). Returns `dst`. Trusted input only. */
export function deepAssign<T extends object>(dst: T, src: unknown): T {
  if (!isPlainObject(src)) return dst;
  const d = dst as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (isPlainObject(v) && isPlainObject(d[k])) deepAssign(d[k] as object, v);
    else d[k] = Array.isArray(v) ? [...v] : isPlainObject(v) ? structuredClone(v) : v;
  }
  return dst;
}

/** A frozen deep copy (what SettingsService.get() hands out). */
export function freezeDeep<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v as object)) freezeDeep(x);
    Object.freeze(v);
  }
  return v;
}

/**
 * Leaves that hold a person's email address (the teacher's alert address, the mail login and From). The audit trail
 * shows them masked, "n…@example.org": until the panel makes the trail host-only (§5.2), the v0.4 moderator
 * dashboard can list mod_actions.
 */
export const AUDIT_MASKED_PATHS: readonly string[] = ['alerts.email', 'mail.user', 'mail.from'];

/** "Name <no-reply@example.org>" → "n…@example.org"; a plain login "relay-user" → "r…". */
export function maskAddress(v: unknown): unknown {
  if (typeof v !== 'string' || !v) return v;
  const m = /<([^<>]*)>/.exec(v);
  const addr = (m ? m[1]! : v).trim();
  const at = addr.lastIndexOf('@');
  return at < 0 ? `${addr.slice(0, 1)}…` : `${addr.slice(0, 1)}…@${addr.slice(at + 1)}`;
}

/** How a value reads in the audit trail: `chat.retention.days: 90 → 30`. */
export function formatAuditValue(v: unknown): string {
  if (v === undefined || v === null) return '(none)';
  if (typeof v === 'string') return JSON.stringify(v.length > 120 ? `${v.slice(0, 119)}…` : v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
    const s = JSON.stringify(v);
    return s.length > 160 ? `${s.slice(0, 150)}…] (${v.length} entries)` : s;
  }
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 160 ? `${s.slice(0, 159)}…` : s;
}

// ------------------------------------------------------------------------------------------
// Mail fingerprint and cross-field rules
// ------------------------------------------------------------------------------------------

/** The mail settings a test email was made with (host, port, security, user, From, password revision). */
export function mailFingerprint(m: MailSettings): string {
  return createHash('sha256')
    .update(JSON.stringify([m.host.toLowerCase(), m.port, m.security, m.user, m.from, m.passwordRev]))
    .digest('hex')
    .slice(0, 16);
}

/** A test email succeeded with the current mail settings (§4.7: Required stays locked until then). */
export function mailTested(m: MailSettings): boolean {
  return !!m.host && !!m.lastTest && m.lastTest.fingerprint === mailFingerprint(m);
}

export type RuleFailure = { ok: false; status: 400 | 409; error: string; field?: string; needsMailTest?: true; rejected?: { line: string; why: string }[] };

export interface RuleOptions {
  /** The LAN edition (default) or a VPS / `npm start`: the trusted moderator tier is for a VPS host only (§5.2). */
  lan?: boolean;
}

const TRUSTED_TIER_LAN = 'The trusted moderator tier is only for a server on the internet (VPS); on the LAN moderators are limited.';

/**
 * The rules that span fields (§4.2, §4.7, §5.2, §5.5, §5.8, §5.12). `prev` is the settings before the change
 * (null when validating a whole config). Returns null when `next` is fine.
 *
 * With a `prev`, a rule runs only when one of ITS fields changed: a stored value that a later event made invalid
 * (a host custom term that now catches a positive line, SMTP_PASS added to a VPS environment) never refuses an
 * unrelated change (the §4.7 escape hatch "switch the account policy to Optional" must always work). Load-time
 * repair (repairSettings) and Settings' warnings (changeWarnings) cover those.
 */
export function checkRules(next: HostSettings, prev: HostSettings | null, opts: RuleOptions = {}): RuleFailure | null {
  const lan = opts.lan !== false;
  const fail = (field: string, error: string, status: 400 | 409 = 400): RuleFailure => ({ ok: false, status, error, field });
  const touched = (...paths: string[]): boolean => !prev || paths.some((p) => !sameValue(getPath(next, p), getPath(prev, p)));
  const school = next.preset === 'school';
  if (touched('preset', 'moderators.tier')) {
    if (school && next.moderators.tier !== 'limited') return fail('moderators.tier', 'The moderator tier is fixed to limited in the School preset.');
    if (lan && next.moderators.tier === 'trusted') return fail('moderators.tier', TRUSTED_TIER_LAN);
  }
  const r = next.chat.retention;
  if (touched('chat.retention.mode', 'chat.retention.termEnd') && r.mode === 'term' && !r.termEnd) {
    return fail('chat.retention.termEnd', "Set the term's end date (the log keeps everything until then).");
  }
  if (touched('preset', 'chat.retention.mode', 'chat.retention.districtApproved') && school && r.mode === 'forever' && !r.districtApproved) {
    return fail('chat.retention.districtApproved', 'Keeping chat forever needs the tick "My district approved keeping chat until I delete it".');
  }
  if (touched(`chat.tags.${TAG_SELF_HARM}`)) {
    const sh = next.chat.tags[TAG_SELF_HARM];
    if (!sh || sh.strike || sh.autoMuteAfter !== null) {
      return fail(`chat.tags.${TAG_SELF_HARM}`, 'A wellbeing (SELF-HARM) line is never an offence: it can\'t count as a strike or lead to a mute.');
    }
    if (sh.notify === 'none') return fail(`chat.tags.${TAG_SELF_HARM}.notify`, 'Wellbeing alerts can\'t be switched off (banner or urgent).');
  }
  const m = next.mail;
  if (m.security === 'none' && touched('mail.security', 'mail.host', 'mail.user', 'mail.passwordSet')) {
    if (m.host && !isPrivateHost(m.host)) return fail('mail.security', '"None" (no encryption) is only allowed to a relay on a private address.');
    if (m.user || m.passwordSet) return fail('mail.security', 'Never send a mail password without encryption: choose STARTTLS or TLS.');
  }
  if (touched('network.port', 'network.adminPort') && next.network.port === next.network.adminPort) {
    return fail('network.adminPort', 'The control panel needs its own port (the game port plus one).');
  }
  if (touched('integrations.hostedModeration.enabled') && next.integrations.hostedModeration.enabled) {
    return fail('integrations.hostedModeration.enabled', 'Hosted moderation is not available in this version.');
  }
  // Host-written text must pass the chat filter (with the host's custom terms: the Zone skips what they catch).
  if (touched('serverName') && !filterOk(next.serverName, 'strict', true)) return fail('serverName', "The server name doesn't pass the chat filter.");
  if (touched('chat.notice') && next.chat.notice && !filterOk(next.chat.notice, 'strict', true)) {
    return fail('chat.notice', "The notice line doesn't pass the chat filter.");
  }
  // The positive lines, at the strictness in force: checked when the list or the strictness changes.
  if (touched('chat.positiveLines', 'chat.strictness')) {
    const rejected = failingPositiveLines(next).map((line) => ({ line, why: "doesn't pass the chat filter" }));
    if (rejected.length) {
      return { ok: false, status: 400, field: 'chat.positiveLines', error: `${rejected.length} positive line(s) don't pass the chat filter.`, rejected };
    }
  }
  // §4.2 / §4.7: switching to Required needs a test email that succeeded with the current mail settings.
  if (next.accounts.email === 'required' && (!prev || prev.accounts.email !== 'required') && !mailTested(next.mail)) {
    return {
      ok: false, status: 409, field: 'accounts.email', needsMailTest: true,
      error: 'Send a test email first: Required email stays locked until a test succeeds with the current mail settings.',
    };
  }
  return null;
}

/** The write-only SMTP password taken out of a patch: a string saves it, null ('' in the patch) removes it. */
export interface PasswordChange { set: string | null }

/**
 * Take the write-only `mail.password` out of a settings/update patch (it never reaches the tree: the service keeps
 * it in data\secrets\smtp.secret). `password` is null when the patch doesn't mention it. A bad password (not text,
 * too long, a NUL) is a 400 naming `mail.password`.
 */
export function splitMailPassword(patch: unknown): { ok: true; body: unknown; password: PasswordChange | null } | RuleFailure {
  if (!isPlainObject(patch) || !isPlainObject(patch.mail) || !Object.prototype.hasOwnProperty.call(patch.mail, 'password')) {
    return { ok: true, body: patch, password: null };
  }
  const pw = patch.mail.password;
  const fail = (error: string): RuleFailure => ({ ok: false, status: 400, error, field: 'mail.password' });
  if (pw !== null && typeof pw !== 'string') return fail('The mail password must be text.');
  if (typeof pw === 'string' && pw.length > SMTP_PASSWORD_MAX) return fail(`The mail password can be at most ${SMTP_PASSWORD_MAX} characters.`);
  if (typeof pw === 'string' && pw.includes('\0')) return fail("The mail password can't contain a NUL character.");
  const { password: _drop, ...mailRest } = patch.mail;
  return { ok: true, body: { ...patch, mail: mailRest }, password: { set: pw ? pw : null } };
}

export interface ValidateOptions extends MergeOptions, RuleOptions {
  /** SMTP_PASS is set in the server's environment (a VPS): removing the saved password still leaves one. */
  envPassword?: boolean;
}

/**
 * §11.4 `validate`: would settings/update accept `patch` on top of `cur`? The same checks, in the same order, with
 * nothing saved and no rev check: the write-only password's shape, every leaf (an unknown, read-only or bad key is
 * 400 naming the field), then the cross-field rules (409 `needsMailTest`, School's fixed moderator tier, ...).
 * The merged tree comes back on success (the panel's "check before saving", an import's dry run, the tool CLI).
 * A patch that sets a password is checked as if it were saved (`mail.passwordSet`; removing it leaves only SMTP_PASS).
 */
export function validate(cur: HostSettings, patch: unknown, opts: ValidateOptions = {}): { ok: true; settings: HostSettings } | RuleFailure {
  const split = splitMailPassword(patch);
  if (!split.ok) return split;
  const merged = mergePatch(cur, split.body, { system: opts.system });
  if (!merged.ok) return { ok: false, status: 400, error: merged.error, ...(merged.field ? { field: merged.field } : {}) };
  const next = structuredClone(merged.value) as HostSettings;
  if (split.password) next.mail.passwordSet = split.password.set !== null || !!opts.envPassword;
  const rule = checkRules(next, cur, { lan: opts.lan });
  return rule ?? { ok: true, settings: next };
}

/** Friendly notes for an accepted change (the domain editor's alias warning, "restart needed", ...). */
export function changeWarnings(next: HostSettings, prev: HostSettings): string[] {
  const out: string[] = [];
  if (next.accounts.domains.length > 1 && next.accounts.domains.length > prev.accounts.domains.length) {
    out.push('Allowing an alias domain lets one student verify several accounts. Most schools need only the student domain.');
  }
  if (next.admin.remoteAccess === 'full' && !next.network.devicesTrustCert) {
    out.push('Remote "full" works only when devices trust this server\'s certificate; until then remote sessions are limited.');
  }
  if (RESTART_PATHS.some((p) => !sameValue(getPath(next, p), getPath(prev, p)))) {
    out.push('Restart the host for the new port or adapter to take effect.');
  }
  // Lines a custom term caught after they were saved (checkRules refuses them only when the list is edited).
  if (sameValue(next.chat.positiveLines, prev.chat.positiveLines) && next.chat.strictness === prev.chat.strictness) {
    const caught = failingPositiveLines(next).length;
    if (caught) out.push(`${caught} positive line(s) are caught by the chat filter now (a custom term?) and are not used: edit them in Settings → Chat.`);
  }
  return out;
}

export interface RepairOptions {
  /** The LAN edition (default): a `trusted` moderator tier becomes `limited` (§5.2). */
  lan?: boolean;
  /**
   * Also check host-written text against the host's installed custom terms (restore: the result must pass
   * checkRules). Default false: at load only the built-in lists count, so a custom term never deletes a line.
   */
  installedFilter?: boolean;
}

/**
 * Load-time repair (a stored or imported config): the same rules as checkRules, but instead of refusing, each
 * broken rule is put right, with a warning. Mutates and returns `s`. The Required-email rule is not repaired here:
 * a stored `required` was accepted when it was set.
 */
export function repairSettings(s: HostSettings, warnings: string[] = [], opts: RepairOptions = {}): HostSettings {
  const warn = (w: string): void => { warnings.push(w); };
  const builtinOnly = !opts.installedFilter;
  if (s.preset === 'school' && s.moderators.tier !== 'limited') {
    s.moderators.tier = 'limited';
    warn('moderators.tier: fixed to limited in the School preset');
  } else if (opts.lan !== false && s.moderators.tier === 'trusted') {
    s.moderators.tier = 'limited';
    warn('moderators.tier: trusted is only for a VPS host — limited on the LAN');
  }
  const r = s.chat.retention;
  if (r.mode === 'term' && !r.termEnd) {
    r.mode = 'days';
    warn(`chat.retention: a term without an end date — keeping ${r.days} days`);
  }
  if (s.preset === 'school' && r.mode === 'forever' && !r.districtApproved) {
    r.mode = 'days';
    warn(`chat.retention: "forever" needs the district tick in the School preset — keeping ${r.days} days`);
  }
  const sh = s.chat.tags[TAG_SELF_HARM] ?? { strike: false, autoMuteAfter: null, notify: 'urgent', dailySummary: true };
  if (sh.strike || sh.autoMuteAfter !== null || sh.notify === 'none') {
    warn(`chat.tags.${TAG_SELF_HARM}: wellbeing lines never count as strikes and always alert the host`);
  }
  s.chat.tags[TAG_SELF_HARM] = { strike: false, autoMuteAfter: null, notify: sh.notify === 'none' ? 'banner' : sh.notify, dailySummary: sh.dailySummary };
  const m = s.mail;
  if (m.security === 'none' && ((m.host && !isPrivateHost(m.host)) || m.user || m.passwordSet)) {
    m.security = 'starttls';
    warn('mail.security: "None" is only for a private relay without a password — using STARTTLS');
  }
  if (s.network.port === s.network.adminPort) {
    s.network.adminPort = s.network.port < 65535 ? s.network.port + 1 : s.network.port - 1;
    warn(`network.adminPort: the same as the game port — using ${s.network.adminPort}`);
  }
  if (s.integrations.hostedModeration.enabled) {
    s.integrations.hostedModeration.enabled = false;
    warn('integrations.hostedModeration: not available in this version — off');
  }
  if (!filterOk(s.serverName, 'strict', true, builtinOnly)) {
    s.serverName = DEFAULT_SERVER_NAME;
    warn(`serverName: it doesn't pass the chat filter — using "${DEFAULT_SERVER_NAME}"`);
  }
  if (s.chat.notice && !filterOk(s.chat.notice, 'strict', true, builtinOnly)) {
    s.chat.notice = '';
    warn("chat.notice: it doesn't pass the chat filter — removed");
  }
  const good = s.chat.positiveLines.filter((l) => filterOk(l, s.chat.strictness, false, builtinOnly));
  if (good.length !== s.chat.positiveLines.length) {
    warn(`chat.positiveLines: ${s.chat.positiveLines.length - good.length} line(s) no longer pass the chat filter — dropped`);
    s.chat.positiveLines = good.length >= POSITIVE_LINES_MIN
      ? good
      : DEFAULT_POSITIVE_LINES.filter((l) => filterOk(l, s.chat.strictness, false, builtinOnly));
  }
  return s;
}
