// OWNER: SERVER MODERATION. The one capability table (docs/LAN-EDITION-proposal.md §5.2): `can(principal, cap)`, used by
// BOTH the admin HTTP routes (./http.ts) and the in-game moderator commands (./commands.ts, through commandPolicy()).
//
// Principals (§5.15): the host admin, by where the session was made (on the host PC; remote over TLS the devices trust,
// `full`; remote otherwise, `limited`), or a moderator, by the server-wide tier (`limited` everywhere by default and
// fixed in the School preset; `trusted` only for a VPS host who chooses it).
//
// Two rules sit beside the table and are NOT expressed as capabilities:
//  - place: a host-PC-only capability also needs the request to come from the host PC (isHostPc, listeners.ts);
//  - step-up: a ★ (sensitive) capability needs the password within the last N minutes of deliberate activity
//    (hostAdmin.ts); otherwise the route answers 401 `reauth`.
// Pure data and functions: no I/O, no settings reads (the caller passes what it knows in CanContext).

// ------------------------------------------------------------------------------------------
// Principals
// ------------------------------------------------------------------------------------------

/** Where a host session is allowed to act from: the host PC, remote over trusted TLS, remote otherwise. */
export type HostVia = 'local' | 'full' | 'limited';
export type ModeratorTier = 'trusted' | 'limited';
export type Principal = { kind: 'host'; via: HostVia } | { kind: 'moderator'; tier: ModeratorTier };

/**
 * How an admin session reached the server (admin_sessions.via):
 *  - `local`: the admin listener's loopback binding (the host PC);
 *  - `https`: the admin listener's LAN binding (TLS);
 *  - `proxy`: the main port behind a reverse proxy or tunnel (a VPS);
 *  - `direct`: the main port from a loopback socket with no forwarding header (`npm start` on the operator's own PC).
 */
export type SessionVia = 'local' | 'https' | 'proxy' | 'direct';
export const SESSION_VIAS: readonly SessionVia[] = ['local', 'https', 'proxy', 'direct'];

/** The remote-access setting (admin.remoteAccess). */
export type RemoteAccess = 'off' | 'limited' | 'full';

export interface HostPrincipalInput {
  via: SessionVia;
  /** The request passed isHostPc (only ever true on the admin listener's loopback binding). */
  hostPc: boolean;
  remoteAccess: RemoteAccess;
  /** The TLS in front of this request is one the devices really trust (§4.10): IT-pushed root, own or public certificate. */
  trustedTls: boolean;
}

/** Remote access is refused for this route: `null` from hostPrincipal. */
export const REMOTE_OFF = 'Remote access to the control panel is off. Sign in on the host PC.';

/**
 * The host principal for a request (null = remote access is off for it). On the host PC it is `local`; the main port
 * seen from the operator's own loopback (`direct`) is `full` (never host PC: there is no admin listener there). Remote
 * sessions are `full` only with remoteAccess `full` AND trusted TLS; a click-through never gets more than `limited`.
 */
export function hostPrincipal(i: HostPrincipalInput): Principal | null {
  if (i.via === 'local') return { kind: 'host', via: i.hostPc ? 'local' : 'full' };
  if (i.via === 'direct') return { kind: 'host', via: 'full' };
  if (i.remoteAccess === 'off') return null;
  return { kind: 'host', via: i.remoteAccess === 'full' && i.trustedTls ? 'full' : 'limited' };
}

export const isHost = (p: Principal): p is { kind: 'host'; via: HostVia } => p.kind === 'host';
export const isModerator = (p: Principal): p is { kind: 'moderator'; tier: ModeratorTier } => p.kind === 'moderator';

/** A short label for logs and the audit trail ("host (host PC)", "moderator (limited)"). */
export function principalLabel(p: Principal): string {
  if (p.kind === 'host') return p.via === 'local' ? 'host (host PC)' : `host (remote ${p.via})`;
  return `moderator (${p.tier})`;
}

// ------------------------------------------------------------------------------------------
// Capabilities
// ------------------------------------------------------------------------------------------

/** Every capability, grouped as the §5.2 table rows. */
export const CAPABILITIES = [
  // Home, Server status (moderators: counts only)
  'status', 'status.counts',
  // Live and Chat log: shown text and tags
  'live', 'log',
  // ★ reveal original text; ★ export, ★ purge; stats
  'reveal', 'log.export', 'log.purge', 'log.stats',
  'announce',
  'rooms.read', 'rooms.manage',
  // Accounts: list (masked) and actions; ★ reveal email, ★ export, ★ delete
  'accounts', 'accounts.reveal', 'accounts.export', 'accounts.delete',
  // ★ Conduct, ★ wellbeing alerts (and ★ acknowledging an alert)
  'conduct', 'wellbeing', 'alerts.ack',
  // Reports (reports.reporter = see who reported)
  'reports', 'reports.reporter',
  // Mute ≤ 24 h, kick, warn | ban, network ban, unban, mute of any length | host bans | acting on a moderator
  'moderate', 'ban', 'ban.host', 'moderators.act',
  // Network addresses (without it: the address tag only); whois (scrubbed per principal)
  'addresses', 'whois',
  // Threat alerts (in the panel)
  'alerts.threat',
  // ★ Custom terms, ★ Settings, mail test
  'terms', 'settings', 'mail.test',
  // Backups: list, back up now; renew the leaf certificate
  'backups', 'cert.renew',
  // Host PC only
  'backups.restore', 'recovery', 'stop', 'cert.new', 'cert.own', 'folders.open', 'update', 'compact', 'setup',
  // Audit trail
  'audit',
  // In-game only (trusted moderators): /log shows original text; a threat alert names the student (no text)
  'log.original.ingame', 'alerts.threat.ingame',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const set = (xs: readonly Capability[]): ReadonlySet<Capability> => new Set<Capability>(xs);

/** ★: needs the password within the last N minutes of deliberate activity (§4.10). */
export const SENSITIVE_CAPS: ReadonlySet<Capability> = set([
  'reveal', 'log.export', 'log.purge', 'accounts.reveal', 'accounts.export', 'accounts.delete',
  'conduct', 'wellbeing', 'alerts.ack', 'terms', 'settings', 'compact',
]);

/** Only on the host PC (isHostPc), whatever the principal. */
export const HOST_PC_ONLY_CAPS: ReadonlySet<Capability> = set([
  'backups.restore', 'recovery', 'stop', 'cert.new', 'cert.own', 'folders.open', 'update', 'compact', 'setup',
]);

/** Remote `limited` (§4.10, §5.2): Live, Chat log (shown text), Rooms, Reports, announcements, mute / kick / warn, bans. */
const HOST_LIMITED: ReadonlySet<Capability> = set([
  'status', 'status.counts', 'live', 'log', 'announce', 'rooms.read', 'rooms.manage', 'reports', 'reports.reporter',
  'moderate', 'ban', 'ban.host', 'moderators.act', 'whois', 'alerts.threat',
]);

/** `trusted` moderators (a VPS host's choice). `log` also needs moderatorLogSearch. */
const MOD_TRUSTED: ReadonlySet<Capability> = set([
  'status.counts', 'live', 'log', 'rooms.read', 'reports', 'reports.reporter', 'moderate', 'ban', 'addresses', 'whois',
  'log.original.ingame', 'alerts.threat.ingame',
]);

/** `limited` moderators (the default, fixed in School): Live only, rooms, reports without the reporter, mute ≤ 24 h. */
const MOD_LIMITED: ReadonlySet<Capability> = set(['status.counts', 'live', 'rooms.read', 'reports', 'moderate', 'whois']);

const HOST_FULL: ReadonlySet<Capability> = set(CAPABILITIES.filter((c) => !HOST_PC_ONLY_CAPS.has(c)));
const HOST_LOCAL: ReadonlySet<Capability> = set(CAPABILITIES);

export interface CanContext {
  /** moderators.logSearch (moderatorLogSearch): trusted moderators may search the Chat log. Default false. */
  logSearch?: boolean;
  /**
   * The session came over TLS the devices don't really trust (a click-through). A remote session then never gets more
   * than the host's `limited` set, whatever the principal (§4.10). Host principals already encode it in `via`.
   */
  untrustedTls?: boolean;
}

function grants(p: Principal): ReadonlySet<Capability> {
  if (p.kind === 'host') return p.via === 'local' ? HOST_LOCAL : p.via === 'full' ? HOST_FULL : HOST_LIMITED;
  return p.tier === 'trusted' ? MOD_TRUSTED : MOD_LIMITED;
}

/** The §5.2 table. Place (host PC) and step-up (freshness) are checked by the caller. */
export function can(p: Principal, cap: Capability, ctx: CanContext = {}): boolean {
  if (!grants(p).has(cap)) return false;
  if (p.kind === 'moderator' && cap === 'log' && !ctx.logSearch) return false;
  if (ctx.untrustedTls && !HOST_LIMITED.has(cap)) return false;
  return true;
}

/** `me`'s capability list (table order). */
export function capabilitiesOf(p: Principal, ctx: CanContext = {}): Capability[] {
  return CAPABILITIES.filter((c) => can(p, c, ctx));
}

export const isSensitive = (cap: Capability): boolean => SENSITIVE_CAPS.has(cap);
export const isHostPcOnly = (cap: Capability): boolean => HOST_PC_ONLY_CAPS.has(cap);
export const isCapability = (v: unknown): v is Capability => typeof v === 'string' && (CAPABILITIES as readonly string[]).includes(v);

// ------------------------------------------------------------------------------------------
// Moderation rules beside the table (HTTP and in-game)
// ------------------------------------------------------------------------------------------

/** A mute a principal without `ban` may give: at most 24 h (§5.2 "Mute ≤ 24 h"). */
export const LIMITED_MUTE_MAX_SEC = 24 * 3600;

/** The longest mute this principal may give, in seconds (null = any length, including permanent). */
export function muteLimitSec(p: Principal, ctx: CanContext = {}): number | null {
  return can(p, 'ban', ctx) ? null : LIMITED_MUTE_MAX_SEC;
}

/** May `p` give a mute of `durationSec` (null = permanent)? */
export function mayMute(p: Principal, durationSec: number | null, ctx: CanContext = {}): boolean {
  if (!can(p, 'moderate', ctx)) return false;
  const max = muteLimitSec(p, ctx);
  return max === null || (durationSec !== null && durationSec > 0 && durationSec <= max);
}

/** "Nobody below the host can act on a moderator" (§5.2). */
export const mayActOnModerator = (p: Principal, ctx: CanContext = {}): boolean => can(p, 'moderators.act', ctx);

/** What a refused in-game command answers (§5.2: "/ban, /ipban, /unban | limited: answer 'Ask the host'"). */
export const ASK_THE_HOST = 'Ask the host.';
export const NOT_FOR_YOUR_ROLE = 'Not allowed for your role.';
export const NOT_ON_A_MODERATOR = 'Only the host can act on a moderator.';

export interface LiftInput {
  kind: 'ban' | 'mute';
  /** bans.by: who created it. */
  by: string;
  /** The ban was created by the host (the host admin, the host's CLI): trusted moderators can't lift it. */
  hostBan: boolean;
}

/**
 * May `p` lift this ban or mute? Bans need `ban` (and `ban.host` for a host ban); a mute can be lifted by anyone with
 * `ban`, and by a principal without it only when they created it (§5.2 "/unmute: only mutes they created").
 */
export function mayLift(p: Principal, b: LiftInput, actorName: string, ctx: CanContext = {}): boolean {
  if (b.hostBan && !can(p, 'ban.host', ctx)) return false;
  if (b.kind === 'ban') return can(p, 'ban', ctx);
  if (can(p, 'ban', ctx)) return true;
  return can(p, 'moderate', ctx) && b.by.trim().toLowerCase() === actorName.trim().toLowerCase();
}

/** The in-game moderator command set (commands.ts MOD_COMMANDS + /confirm). */
export type ModCommand = 'modhelp' | 'kick' | 'warn' | 'mute' | 'unmute' | 'ban' | 'ipban' | 'unban' | 'log' | 'whois' | 'reports' | 'confirm';

/** Per-principal behaviour of the in-game commands (§5.2 "In-game commands, through can()"). */
export interface CommandPolicy {
  /** null = any length. */
  muteMaxSec: number | null;
  /** /unmute: only mutes this moderator created. */
  unmuteOwnOnly: boolean;
  /** /ban, /ipban, /unban are allowed (else "Ask the host"). */
  canBan: boolean;
  /** Host bans can be lifted. */
  liftHostBans: boolean;
  /** /log: original text (else shown text plus tag chips). */
  logOriginal: boolean;
  /** /log: at most this many lines. */
  logMaxLines: number;
  /** /reports: show who reported. */
  showReporter: boolean;
  /** /whois: today's full view (without emails); else only the current room and any active mute. */
  whoisFull: boolean;
  /** Network addresses (in /whois, the ban lines). */
  addresses: boolean;
  /** Acting on a moderator is allowed. */
  actOnModerators: boolean;
  /** A threat alert in game may name the student (never any text). SELF-HARM never reaches a moderator. */
  threatAlerts: boolean;
}

export function commandPolicy(p: Principal, ctx: CanContext = {}): CommandPolicy {
  const trustedLike = p.kind === 'host' || p.tier === 'trusted';
  return {
    muteMaxSec: muteLimitSec(p, ctx),
    unmuteOwnOnly: !can(p, 'ban', ctx),
    canBan: can(p, 'ban', ctx),
    liftHostBans: can(p, 'ban.host', ctx),
    logOriginal: p.kind === 'host' ? can(p, 'reveal', ctx) : can(p, 'log.original.ingame', ctx),
    logMaxLines: trustedLike ? 50 : 10,
    showReporter: can(p, 'reports.reporter', ctx),
    whoisFull: trustedLike,
    addresses: can(p, 'addresses', ctx),
    actOnModerators: can(p, 'moderators.act', ctx),
    threatAlerts: p.kind === 'host' ? can(p, 'alerts.threat', ctx) : can(p, 'alerts.threat.ingame', ctx),
  };
}

/** Is an in-game command open to `p`? `reply` is what a refused one answers. */
export function commandAllowed(p: Principal, cmd: ModCommand, ctx: CanContext = {}): { ok: true } | { ok: false; reply: string } {
  switch (cmd) {
    case 'ban': case 'ipban': case 'unban':
      return can(p, 'ban', ctx) ? { ok: true } : { ok: false, reply: ASK_THE_HOST };
    case 'reports':
      return can(p, 'reports', ctx) ? { ok: true } : { ok: false, reply: NOT_FOR_YOUR_ROLE };
    case 'whois':
      return can(p, 'whois', ctx) ? { ok: true } : { ok: false, reply: NOT_FOR_YOUR_ROLE };
    default:
      return can(p, 'moderate', ctx) ? { ok: true } : { ok: false, reply: NOT_FOR_YOUR_ROLE };
  }
}
