// OWNER: SERVER MODERATION (LAN task B8b). The one CSV writer every export goes through (docs/LAN-EDITION-proposal.md
// §5.5 "one shared CSV writer for every export", §13 P-m5, T-CSV-1): the Chat log export, and the conduct, accounts and
// custom-term exports as they land (B19, B20, B21 pass their own columns to CsvWriter).
//  - UTF-8 with a byte-order mark (spreadsheets then read it as UTF-8), CRLF line ends, RFC 4180 quoting.
//  - Formula injection: any TEXT cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return is neutralised
//    with a leading apostrophe (and then quoted), so a spreadsheet shows it as text and never evaluates it. A finite
//    number is written as it is (it can't be a formula); the columns here never write a negative number.
// The JSON export writes the same records as a JSON array (nothing to neutralise: no spreadsheet evaluates it).
// Pure: no I/O. The service streams pages of rows through a writer (head, rows, end) into a file or a download.
import { teamName } from '../../shared/data/teams';
import type { ChatLogRow } from '../maint/queries';

export const CSV_BOM = '﻿';
export const CSV_EOL = '\r\n';

export type ExportFormat = 'csv' | 'json';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['csv', 'json'];

export const EXPORT_CONTENT_TYPES: Readonly<Record<ExportFormat, string>> = Object.freeze({
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
});

/** A cell a spreadsheet would read as a formula (or a formula hidden behind a tab / carriage return). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** True when a text cell needs neutralising. */
export const looksLikeFormula = (s: string): boolean => FORMULA_START.test(s);

/** A text cell made safe for a spreadsheet: a leading apostrophe when it starts like a formula. */
export function neutralizeCell(s: string): string {
  return looksLikeFormula(s) ? `'${s}` : s;
}

/** The text of one value (null / undefined → '', a list → its items joined with a space, a Date → ISO). */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : '';
  if (Array.isArray(v)) return v.map((x) => cellText(x)).join(' ');
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return ''; } }
  return String(v);
}

/**
 * One CSV cell. Finite numbers (and bigints) are written as they are; everything else is text: neutralised when it
 * starts like a formula (T-CSV-1), then quoted when it holds a quote, a comma or a line break (or was neutralised).
 */
export function csvCell(v: unknown): string {
  if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'bigint') return String(v);
  const raw = typeof v === 'number' ? '' : cellText(v); // NaN / Infinity: empty
  const s = neutralizeCell(raw);
  return s !== raw || /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One CSV line (without its line end). */
export function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(',');
}

/** One column of an export: its header and how a row gives its value. */
export interface CsvColumn<T> {
  header: string;
  value(row: T): unknown;
}

/**
 * A streaming CSV writer: head() (BOM + header line), then rows(page) for each page, then end() (nothing: a CSV has
 * no trailer; kept so every writer has the same shape).
 */
export class CsvWriter<T> {
  readonly format: ExportFormat = 'csv';
  constructor(readonly columns: readonly CsvColumn<T>[]) {}
  head(): string { return `${CSV_BOM}${csvRow(this.columns.map((c) => c.header))}${CSV_EOL}`; }
  rows(rows: readonly T[]): string {
    let out = '';
    for (const r of rows) out += `${csvRow(this.columns.map((c) => c.value(r)))}${CSV_EOL}`;
    return out;
  }
  end(): string { return ''; }
}

/** The same records as a JSON array: `[`, one object per line, `]`. Keys are the column headers. */
export class JsonArrayWriter<T> {
  readonly format: ExportFormat = 'json';
  private first = true;
  constructor(readonly columns: readonly CsvColumn<T>[]) {}
  head(): string { this.first = true; return '['; }
  rows(rows: readonly T[]): string {
    let out = '';
    for (const r of rows) {
      const o: Record<string, unknown> = {};
      for (const c of this.columns) {
        const v = c.value(r);
        o[c.header] = v === undefined ? null : v;
      }
      out += `${this.first ? '\n' : ',\n'}${JSON.stringify(o)}`;
      this.first = false;
    }
    return out;
  }
  end(): string { return this.first ? ']\n' : '\n]\n'; }
}

export type ExportWriter<T> = CsvWriter<T> | JsonArrayWriter<T>;

/** A writer of `format` for `columns`. */
export function exportWriter<T>(format: ExportFormat, columns: readonly CsvColumn<T>[]): ExportWriter<T> {
  return format === 'json' ? new JsonArrayWriter(columns) : new CsvWriter(columns);
}

/** A whole CSV document at once (small exports; the big ones stream through CsvWriter). */
export function toCsv<T>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string {
  const w = new CsvWriter(columns);
  return w.head() + w.rows(rows) + w.end();
}

// ------------------------------------------------------------------------------------------
// The Chat log export (§5.5): time, room, team, channel, player, account, what they typed (only when ticked), what
// others saw, action, display, tags
// ------------------------------------------------------------------------------------------

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/**
 * "2026-09-28 10:02:15" in the host's local time (what the panel shows), or in UTC with `utc` (then with a trailing
 * " UTC"). Never starts with a formula character.
 */
export function exportTime(ts: number, utc = false): string {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  if (utc) {
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The team a line was sent in, by name ('' outside a team: the lobby, free-for-all). */
export const exportTeam = (team: number): string => (Number.isInteger(team) && team >= 0 ? teamName(team) : '');

/** The channel as the panel names it: lobby, all, team, names, room names, announcements. */
export function exportChannel(r: Pick<ChatLogRow, 'channel' | 'roomId' | 'roomUid'>): string {
  switch (r.channel) {
    case 'team': return 'team';
    case 'name': return 'names';
    case 'room': return 'room names';
    case 'announce': return 'announcements';
    default: return r.roomId === null && r.channel === 'all' && (r.roomUid === null || /:zone$/.test(r.roomUid)) ? 'lobby' : 'all';
  }
}

export interface ChatExportOptions {
  /** the "what they typed" column ("include unfiltered text" ticked, by a principal with `reveal`) */
  includeOriginal: boolean;
  /** times in UTC instead of the host's local time */
  utc?: boolean;
}

/**
 * The Chat log columns. "what others saw" is the SHOWN text and "display" says how it reached the others
 * (substituted = a positive line under the student's name, never the student's words: §5.8 attribution).
 */
export function chatLogColumns(o: ChatExportOptions): CsvColumn<ChatLogRow>[] {
  const cols: CsvColumn<ChatLogRow>[] = [
    { header: 'id', value: (r) => r.id },
    { header: 'time', value: (r) => exportTime(r.ts, o.utc === true) },
    { header: 'room', value: (r) => r.roomName },
    { header: 'team', value: (r) => exportTeam(r.team) },
    { header: 'channel', value: (r) => exportChannel(r) },
    { header: 'player', value: (r) => r.name },
    { header: 'account', value: (r) => r.accountId ?? '' },
  ];
  if (o.includeOriginal) cols.push({ header: 'what they typed', value: (r) => r.original });
  cols.push(
    { header: 'what others saw', value: (r) => r.shown },
    { header: 'action', value: (r) => r.action },
    { header: 'display', value: (r) => r.display },
    { header: 'tags', value: (r) => r.tags.join(' ') },
  );
  return cols;
}

/** A download / file name: `voidswarm-<what>-2026-09-28_1402.<ext>` (local time; safe characters only). */
export function exportFileName(what: string, format: ExportFormat, at: number): string {
  const d = new Date(at);
  const stamp = Number.isFinite(d.getTime())
    ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    : 'export';
  const safe = String(what).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'export';
  return `voidswarm-${safe}-${stamp}.${format}`;
}
