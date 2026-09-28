// OWNER: ADMIN DASHBOARD builder. Types for the pure helpers exported by admin.js (a plain browser ES module,
// shipped without a build step). Only admin.test.ts imports it; the server serves admin.js / .html / .css.

export const TOKEN_KEY: string;
export const LIVE_REFRESH_MS: number;
export const REPORTS_POLL_MS: number;
export const PAGE_SIZE: number;
export const REASON_MAX: number;
export const NOTE_MAX: number;
export const GREP_MAX: number;
export const NAME_MAX: number;
export const HOT_STRIKES: number;
export const ENDPOINTS: readonly string[];

export type DurationId = '10m' | '1h' | '1d' | '7d' | 'perm';
export const DURATION_PRESETS: readonly { readonly id: DurationId; readonly label: string }[];
export const DEFAULT_DURATION: { readonly ban: DurationId; readonly mute: DurationId };
export function isDurationPreset(id: unknown): boolean;
export function durationLabel(id: unknown): string;

export type ChatAction = 'pass' | 'mask' | 'block' | 'spam' | 'muted';
export const CHAT_ACTIONS: Readonly<Record<ChatAction, { readonly label: string; readonly hidden: boolean }>>;
export function chatActionInfo(action: unknown): { id: string; label: string; hidden: boolean };
export function chatRowClass(action: unknown): string;
export const CHANNEL_LABELS: Readonly<Record<string, string>>;

export function formatDateTime(ms: unknown): string;
export function formatShortTime(ms: unknown, now?: number): string;
export function formatSpan(ms: unknown): string;
export function formatExpiry(expiresAt: number | null | undefined, now?: number): string;
export function parseLocalDateTime(value: unknown): number | null;
export function cleanText(v: unknown, max: number): string;

export interface LogForm {
  player?: string; grep?: string; address?: string; roomId?: string; action?: string;
  range?: string; from?: string; to?: string;
}
export function buildLogQuery(form: LogForm, before: number | null, limit?: number):
  { query: Record<string, string | number>; error?: undefined } | { error: string; query?: undefined };
export function checkReason(raw: unknown, opts?: { required?: boolean; max?: number; what?: string }):
  { value: string; error?: undefined } | { error: string; value?: undefined };

export interface Pager { readonly stack: readonly (number | null)[]; readonly next: number | null }
export function pagerInit(): Pager;
export function pagerCursor(p: Pager): number | null;
export function pagerLoaded(p: Pager, nextBefore: unknown): Pager;
export function pagerOlder(p: Pager): Pager;
export function pagerNewer(p: Pager): Pager;
export function pagerLabel(p: Pager, shown: number): string;
export function nextTabIndex(current: number, key: string, count: number): number;
export function latestOnly(): () => () => boolean;

export function banTargetText(b: unknown): string;
export const SCOPE_LABELS: Readonly<Record<string, string>>;
export function actionTargetText(a: unknown): string;
export function actionDurationText(a: unknown): string;
export function isDashboardRead(a: unknown): boolean;

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
export interface FetchLikeResponse {
  ok: boolean; status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}
export interface Api {
  login(login: string, password: string): Promise<Record<string, unknown>>;
  logout(token: string): Promise<Record<string, unknown>>;
  admin(endpoint: string, body?: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export function createApi(opts: {
  fetchImpl: (url: string, init: { method: string; headers: Record<string, string>; body: string; [k: string]: unknown }) => Promise<FetchLikeResponse>;
  getToken: () => string | null;
  onAuthLost?: (status: number, message: string) => void;
}): Api;
export function errorText(err: unknown): string;

export interface StorageLike {
  getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void;
}
export function createTokenStore(getStorage: () => StorageLike | null | undefined): {
  get(): string | null; set(token: string): void; clear(): void;
};
