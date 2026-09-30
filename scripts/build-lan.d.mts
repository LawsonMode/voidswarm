// OWNER: PACKAGING (LAN task B11). Types for scripts/build-lan.mjs (the package tests import it).
export const PROJECT_ROOT: string;
export const LAN_FOLDER: string;
export const NODE_MAJOR: number;
export const ZIP_MAX_BYTES: number;
export const NODE_SIGNER: string;
export const SUMS_FILE: string;
export const TEMPLATES_DIR: string;
export const NODE_LICENSE: string;
export const APP_ENTRIES: Readonly<Record<'server' | 'launch' | 'tool' | 'maint', string>>;
export const STATIC_PAGES: readonly { from: string; to: string; later: boolean }[];
export const STUBS: readonly { name: string; later: boolean }[];
export const ROOT_DOCS: readonly string[];
export const CREATE_REQUIRE_BANNER: string;

export class BuildError extends Error {}

export interface Metafile {
  inputs: Record<string, unknown>;
  outputs: Record<string, { inputs: Record<string, unknown>; bytes: number }>;
}

export interface BuildResult {
  version: string;
  stageRoot: string | null;
  zip: string | null;
  sha256: string | null;
  size: number;
  node: string;
  metafile: Metafile;
  serverOutput: string | null;
}

export interface BuildOptions {
  projectRoot?: string;
  out?: string;
  node?: string;
  platform?: NodeJS.Platform;
  version?: string;
  buildDate?: string;
  keepStage?: boolean;
  zip?: boolean;
  log?: (line: string) => void;
  /** vite logs nothing */
  quiet?: boolean;
  /** the git check-ignore used by the --out guard (tests) */
  gitIgnored?: (projectRoot: string, file: string) => boolean | null;
}

export function zipName(version: string): string;
export function isPageFile(name: string): boolean;
export function readVersion(projectRoot?: string): string;
export function walkFiles(dir: string): string[];
export const NON_FETCH_URLS: readonly string[];
export function findExternalUrls(webDir: string): string[];
export function isInside(p: string, dir: string, platform?: NodeJS.Platform): boolean;
export function placeUnder(p: string, dir: string, platform?: NodeJS.Platform): string | null;
export function isNetworkPath(p: string, platform?: NodeJS.Platform): boolean;
export function gitIgnores(projectRoot: string, file: string): boolean | null;
export function checkOutDir(out: string, opts?: { projectRoot?: string; platform?: NodeJS.Platform; gitIgnored?: (projectRoot: string, file: string) => boolean | null }): void;
export function buildWeb(webDir: string, opts?: { projectRoot?: string; log?: (l: string) => void; quiet?: boolean }): Promise<void>;
export function appBuildOptions(appDir: string, opts?: { projectRoot?: string; entryPoints?: Record<string, string> }): import('esbuild').BuildOptions & { metafile: true };
export function bundleApp(appDir: string, opts?: { projectRoot?: string; log?: (l: string) => void }): Promise<Metafile>;
export function legalCommentsOf(metafile: Metafile, output: string, projectRoot?: string): string[];
export function copyStaticPages(appDir: string, opts?: { projectRoot?: string; log?: (l: string) => void }): Record<string, string[]>;
export function authenticode(file: string): { status: string; subject: string | null; error?: string };
export function isOpenJsSubject(subject: string | null | undefined): boolean;
export function checkNodeRuntime(nodeExe: string, opts?: { platform?: NodeJS.Platform }): { version: string; major: number; signature: { status: string; subject: string | null } | null };
export function copyRuntime(runtimeDir: string, nodeExe: string): void;
export function fillTemplate(text: string, values: Record<string, string | number>): string;
export function productionPackages(projectRoot?: string): { name: string; version: string; license: string; author: string | null; text: string | null }[];
export function noticesText(projectRoot?: string): string;
export function writeTexts(stageRoot: string, values: Record<string, string | number>, opts?: { templatesDir?: string; log?: (l: string) => void }): string[];
export function sha256Of(file: string): string;
export function writeSums(stageRoot: string): number;
export function checkStageManifest(stageRoot: string): string[];
export function makeZip(stageParent: string, zipFile: string): { hex: string; size: number };
export function buildLan(opts?: BuildOptions): Promise<BuildResult>;
export function devRun(argv: string[], opts?: { projectRoot?: string; out?: string; log?: (l: string) => void; platform?: NodeJS.Platform; gitIgnored?: (projectRoot: string, file: string) => boolean | null }): Promise<number>;
export function parseArgs(argv: string[]): { out?: string; node?: string; keepStage: boolean; zip: boolean; run: boolean; rest: string[] };
