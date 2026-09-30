// OWNER: ADMIN UI (B9). Types for the helpers exported by admin.js (a plain browser ES module, shipped without a build
// step). Only the tests import it; the server serves admin.js / .html / .css.

export const TOKEN_KEY: string;
export const MODE_KEY: string;
export const PREFS_KEY: string;
export const ONLINE_REFRESH_MS: number;
export const HOME_REFRESH_MS: number;
export const ME_REFRESH_MS: number;
export const REPORTS_POLL_MS: number;
export const CLOCK_TICK_MS: number;
export const LIVE_WAIT_SEC: number;
export const LIVE_KEEP: number;
export const LIVE_MIN_GAP_MS: number;
export const LIVE_RETRY_MS: number;
export const LIVE_BUSY_RETRY_MS: number;
export const PAGE_SIZE: number;
export const REVEAL_MAX: number;
export const REASON_MAX: number;
export const NOTE_MAX: number;
export const GREP_MAX: number;
export const NAME_MAX: number;
export const ANNOUNCE_MAX: number;
export const HOT_STRIKES: number;
export const MAX_PERIOD_DAYS: number;
export const WELLBEING_TEXT: string;
export const PRESENT_NAME: string;
export const PRESENT_TEXT: string;
export const ANNOUNCE_QUICK: readonly string[];
export const ENDPOINTS: readonly string[];
export const SESSIONLESS: readonly string[];

export interface TabDef { readonly id: string; readonly label: string; readonly cap: string; readonly locked: boolean }
export const TABS: readonly TabDef[];
export const TAB_IDS: readonly string[];
export const LEGACY_CAPS: readonly string[];
export function visibleTabs(caps: readonly string[] | unknown): string[];
export function defaultTab(tabs: readonly string[]): string | null;
export function principalText(p: unknown, legacy?: boolean): string;

export type DurationId = '10m' | '1h' | '1d' | '7d' | 'perm';
export const DURATION_PRESETS: readonly { readonly id: DurationId; readonly label: string }[];
export const QUICK_MUTES: readonly DurationId[];
export const DEFAULT_DURATION: { readonly ban: DurationId; readonly mute: DurationId };
export function isDurationPreset(id: unknown): boolean;
export function durationLabel(id: unknown): string;
export function durationChoices(kind: 'ban' | 'mute', caps: readonly string[]): DurationId[];

export type ChatAction = 'pass' | 'flag' | 'mask' | 'block' | 'spam' | 'muted';
export const CHAT_ACTIONS: Readonly<Record<ChatAction, { readonly label: string; readonly hidden: boolean }>>;
export function chatActionInfo(action: unknown): { id: string; label: string; hidden: boolean };
export function chatRowClass(action: unknown): string;
export type Display = 'as-typed' | 'masked' | 'substituted' | 'system' | 'hidden' | 'withheld';
export const DISPLAY_INFO: Readonly<Record<Display, { readonly label: string }>>;
export function displayLabel(display: unknown): string;
export const CHANNEL_LABELS: Readonly<Record<string, string>>;
export const TEAM_NAMES: readonly string[];
export function teamText(team: unknown): string;
/** A room as Presenting shows it: "Room 2" from its id, never its name. */
export function presentingRoomLabel(row: unknown): string;
export function whereLabel(row: unknown, presenting?: boolean): string;
export interface ShownView { kind: 'text' | 'substituted' | 'masked' | 'hidden' | 'withheld'; text: string; note: string }
export function shownView(row: unknown): ShownView;
export function attributionText(row: unknown): string;
export const TAG_PROFANITY: string;
export const TAG_VULGAR: string;
export const TAG_HATE: string;
export const TAG_THREAT: string;
export const TAG_SELF_HARM: string;
export const TAG_GANG: string;
export const BUILTIN_TAGS: readonly string[];
export function tagClass(tag: unknown): string;
export function tagText(tag: unknown): string;
export function rowTags(row: unknown): string[];
export function isWellbeingRow(row: unknown): boolean;

export function formatDateTime(ms: unknown): string;
export function formatShortTime(ms: unknown, now?: number): string;
export function formatSpan(ms: unknown): string;
export function formatExpiry(expiresAt: number | null | undefined, now?: number): string;
export function formatCount(n: unknown): string;
export function formatBytes(n: unknown): string;
export function formatDay(ms: unknown, now?: number): string;
export function formatClock(ms: unknown): string;
export function roomSpanText(firstTs: unknown, lastTs: unknown, now?: number): string;
export function formatWhen(ms: unknown, now?: number): string;
export function parseLocalDateTime(value: unknown): number | null;
export function parseLocalDate(value: unknown, plusDays?: number): number | null;
export function isoDay(ms: unknown): string;
export function cleanText(v: unknown, max: number): string;
export function plural(n: number, one: string, many?: string): string;

export interface ClassPeriod { name: string; start: string; end: string; days: number[] }
export interface TimeRange { since: number; until: number }
export function normalizePeriod(p: unknown): ClassPeriod | null;
export function periodRangeOn(period: unknown, dayMs: number): TimeRange | null;
export function currentPeriod(periods: unknown, now?: number): { period: ClassPeriod; range: TimeRange } | null;
export function periodRanges(period: unknown, since: number, until: number): TimeRange[];

export const LOG_ACTION_FILTERS: Readonly<Record<string, { readonly action?: string; readonly display?: string | readonly string[]; readonly legacy?: { action: string } }>>;
export const LOG_RANGES: readonly string[];
export const LOG_CHANNELS: readonly string[];
export interface LogForm {
  range?: string; from?: string; to?: string; player?: string; room?: string; period?: string; channel?: string; action?: string;
  tag?: string; q?: string; jump?: string;
}
export type LogCursor = number | { before: number; beforeTs?: number } | null;
export function buildLogQuery(form: LogForm, opts?: { now?: number; periods?: unknown; cursor?: LogCursor; limit?: number; legacy?: boolean }):
  { query: Record<string, unknown>; error?: undefined } | { error: string; query?: undefined };
export function checkReason(raw: unknown, opts?: { required?: boolean; max?: number; what?: string }):
  { value: string; error?: undefined } | { error: string; value?: undefined };

export interface Pager { readonly stack: readonly LogCursor[]; readonly next: LogCursor }
export function pagerInit(): Pager;
export function pagerCursor(p: Pager): LogCursor;
export function pagerLoaded(p: Pager, nextBefore: unknown, nextBeforeTs?: unknown): Pager;
export function pagerOlder(p: Pager): Pager;
export function pagerNewer(p: Pager): Pager;
export function pagerLabel(p: Pager, shown: number): string;
export function pageSpanText(p: Pager, shown: number, size?: number): string;
export function nextTabIndex(current: number, key: string, count: number): number;
export function latestOnly(): () => () => boolean;

export interface LiveFilters { roomUid?: string; channel?: string; tag?: string; player?: string; flaggedOnly?: boolean }
export function liveRequestBody(filters: LiveFilters | null | undefined, after: number | null | undefined, waitSec?: number): Record<string, unknown>;
export function mergeLive<T extends { seq: number }>(current: readonly T[], incoming: readonly T[], keep?: number): T[];

export function setupCodeFromHash(hash: unknown): string;
export function normalizeSetupCode(v: unknown): string;
export const DOMAINS_MAX: number;
export function domainListOf(text: unknown, subdomains?: boolean):
  { domains: { domain: string; subdomains: boolean }[]; error?: undefined } | { error: string; domains?: undefined };
export function setupBody(form: Record<string, unknown>, first?: boolean):
  { body: Record<string, unknown>; error?: undefined; field?: undefined } | { error: string; field: string; body?: undefined };

export function exportBody(filter: Record<string, unknown> | null | undefined, o?: {
  scope?: 'filter' | 'range' | 'all'; from?: string; to?: string; format?: string; includeOriginal?: boolean; includeWellbeing?: boolean; saveOnHost?: boolean;
}): { body: Record<string, unknown>; error?: undefined } | { error: string; body?: undefined };
export function announceBody(text: unknown, target: unknown): { body: { text: string; roomId?: string }; error?: undefined } | { error: string; body?: undefined };
export function retentionText(r: unknown, now?: number): string;
export function statsText(s: unknown, now?: number): string;
export function retentionPatch(f: { mode?: unknown; days?: unknown; termEnd?: unknown; districtApproved?: unknown } | null | undefined, school?: boolean):
  { patch: Record<string, unknown>; error?: undefined } | { error: string; patch?: undefined };

export function sessionClock(session: unknown, now?: number): { idleLeftMs: number | null; freshLeftMs: number; fresh: boolean };
export function idleText(ms: number | null | undefined): string;
/** The only endpoints a timer or the visibility handler may call (each a passive route). */
export const BACKGROUND_ENDPOINTS: readonly string[];
export function openReportsOf(reply: unknown): { open: number; more: boolean } | null;
export function homeAlertParts(alerts: unknown): { text: string; urgent: boolean }[];

export function banTargetText(b: unknown): string;
export const SCOPE_LABELS: Readonly<Record<string, string>>;
export function actionTargetText(a: unknown): string;
export function actionDurationText(a: unknown): string;
export function isDashboardRead(a: unknown): boolean;
export function auditMatches(a: unknown, f?: { actor?: string; kind?: string }): boolean;

export interface Subject {
  name: string; playerId: number | null; accountId: string | null; username: string | null; address: string | null; online: boolean;
}
export function toSubject(src: unknown, online?: boolean): Subject;
export interface ScopeChoice { value: 'account' | 'guest-name' | 'guest' | 'address'; label: string; hint: string }
export function scopeChoices(kind: 'ban' | 'mute', subject: Subject): ScopeChoice[];
export function banCreateBody(args: {
  kind: string; subject: Subject; scope: string; duration: string; reason: string; confirm?: boolean;
}): { body: Record<string, unknown>; error?: undefined } | { error: string; body?: undefined };
export function manualBanBody(args: {
  kind: string; scope: string; target: string; duration: string; reason: string; confirm?: boolean;
}): { body: Record<string, unknown>; error?: undefined } | { error: string; body?: undefined };

export class ApiError extends Error {
  constructor(status: number, message: string, body?: Record<string, unknown> | null, retryAfterSec?: number | null);
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  readonly retryAfterSec: number | null;
}
export function isReauth(err: unknown): boolean;
/** A 400 with no body: the listener closing a connection, read as the answer to a request (sent again when safe). */
export function isLostAnswer(err: unknown): boolean;
export const LOST_ANSWER_RETRY: readonly string[];
export const LOST_ANSWER_TRIES: number;
export function fileNameOf(disposition: unknown, fallback?: string): string;
export interface FetchLikeResponse {
  ok: boolean; status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  blob?(): Promise<unknown>;
}
export interface Api {
  login(role: 'host' | 'moderator', username: string, password: string): Promise<{ token: string; session: unknown; legacy: boolean }>;
  logout(token: string, legacy?: boolean): Promise<void>;
  admin(endpoint: string, body?: Record<string, unknown>, extra?: { signal?: AbortSignal; noReauth?: boolean }): Promise<Record<string, unknown>>;
  file(endpoint: string, body?: Record<string, unknown>, extra?: { signal?: AbortSignal }):
    Promise<{ kind: 'file'; blob: unknown; filename: string; rows: number | null } | { kind: 'json'; data: Record<string, unknown> }>;
}
export function createApi(opts: {
  fetchImpl: (url: string, init: { method: string; headers: Record<string, string>; body: string; [k: string]: unknown }) => Promise<FetchLikeResponse>;
  getToken: () => string | null;
  onAuthLost?: (status: number, message: string) => void;
  onReauth?: () => Promise<boolean> | boolean;
  isLegacy?: () => boolean;
  /** The page's sign-in generation: an answer that lands after it changed is dropped (ApiError 0 `aborted`). */
  epoch?: () => number;
  /** This sign-in's AbortSignal, for calls that bring none of their own. */
  signal?: () => AbortSignal | undefined;
}): Api;
export function errorText(err: unknown): string;

export interface StorageLike {
  getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void;
}
export function createTokenStore(getStorage: () => StorageLike | null | undefined): {
  get(): string | null; set(token: string): void; clear(): void;
};
export function createPrefs(getStorage: () => StorageLike | null | undefined): { presenting(): boolean | null; setPresenting(on: boolean): void };
export function presentingAtStart(o: { remembered: boolean | null; atLogin: unknown; freshLogin: boolean }): boolean;

// DOM (a real document in the page; a fake one in tests)
export type H = (tag: string, props?: Record<string, unknown> | null, ...children: unknown[]) => any;
export function makeH(doc: unknown): H;
export interface RowCtx {
  presenting?: boolean; caps?: readonly string[]; now?: number; legacy?: boolean; revealed?: Map<number, string>;
  on?: Record<string, (row: any) => void>;
}
export function renderLiveLine(h: H, line: Record<string, unknown>, ctx: RowCtx): any;
export function renderLogRow(h: H, row: Record<string, unknown>, ctx: RowCtx): any;
export function presentingWellbeingRow(h: H, cols: number, at?: number, text?: string): any;
export function boot(env: { doc: unknown; win: unknown }): {
  stop(): void;
  state(): { signedIn: boolean; legacy: boolean; presenting: boolean; caps: string[]; tabs: string[]; currentTab: string | null; liveAfter: number | null; revealed: Map<number, string> };
};
