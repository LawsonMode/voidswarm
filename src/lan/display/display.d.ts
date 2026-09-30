// OWNER: ADMIN UI (B9). Types for display.js (the /display projector page; a plain browser ES module).

export const STATE_URL: string;
export const DISPLAY_WAIT_SEC: number;
export const RETRY_MS: number;
export const MIN_GAP_MS: number;
export interface DisplayModelRoom {
  name: string; typeLabel: string; subModeLabel: string; phase: string; phaseLabel: string; humans: number; spectators: number; maxPlayers: number; house: boolean;
}
export interface DisplayModel {
  rev: number; serverName: string; joinUrl: string; secureUrl: string; fingerprint: string; notServing: string;
  rooms: DisplayModelRoom[]; announcement: { text: string; target: string; at: number } | null; notice: string;
}
export function displayModel(state: unknown): DisplayModel;
export function roomMode(r: DisplayModelRoom): string;
export function roomCounts(r: DisplayModelRoom): string;
export function clockText(ms: number): string;
export function renderDisplay(doc: unknown, model: DisplayModel): void;
export function bootDisplay(env: { doc: unknown; win: unknown }): { done: Promise<void>; stop(): void };
