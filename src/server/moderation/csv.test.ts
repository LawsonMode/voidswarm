// The one shared CSV writer (docs/LAN-EDITION-proposal.md §5.5, T-CSV-1): formula neutralising, quoting, BOM and CRLF,
// the JSON twin, and the Chat log columns (what they typed only when asked; what others saw, labelled by display).
// Every export (chat, conduct, accounts, custom terms) goes through CsvWriter; the conduct, accounts and custom-term
// column sets below stand in for the exporters that land later (B19, B20, B21) and must pass the same check.
import { describe, expect, it } from 'vitest';
import type { ChatLogRow } from '../maint/queries';
import {
  CSV_BOM, CSV_EOL, CsvWriter, chatLogColumns, csvCell, csvRow, exportChannel, exportFileName, exportTeam, exportTime, exportWriter, JsonArrayWriter,
  looksLikeFormula, neutralizeCell, toCsv, type CsvColumn,
} from './csv';

/** Cells an attacker could type into a callsign, a chat line, a custom term or a note. */
const POISON = ['=HYPERLINK("http://x.test","click")', '+1+cmd|/C calc!A0', '-2+3', '@SUM(A1:A9)', '\t=1+1', '\r=1+1', '=cmd|\' /C notepad\'!A0'];

/** Parse one CSV line (RFC 4180, as a spreadsheet would) into its cell texts. */
function parseLine(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  let cell = '';
  let quoted = false;
  while (i < s.length) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === ',') { out.push(cell); cell = ''; i++; continue; }
    cell += ch; i++;
  }
  out.push(cell);
  return out;
}

/** Split a CSV document into lines (CRLF outside quotes). */
function parseDoc(doc: string): string[][] {
  const body = doc.startsWith(CSV_BOM) ? doc.slice(1) : doc;
  const lines: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '\r' && body[i + 1] === '\n') { lines.push(cur); cur = ''; i++; continue; }
    cur += ch;
  }
  if (cur) lines.push(cur);
  return lines.map(parseLine);
}

/** A parsed cell a spreadsheet would evaluate. */
const evaluates = (cell: string): boolean => /^[=+\-@\t\r]/.test(cell);

const row = (over: Partial<ChatLogRow> = {}): ChatLogRow => ({
  id: 7, ts: Date.UTC(2026, 8, 28, 14, 2, 15), roomId: 'r2', roomUid: 'boot1:r2', roomName: 'Flag Run', channel: 'team', team: 0, playerId: 3,
  name: 'NovaPilot', accountId: 'acc-1', address: '10.0.0.5', original: 'what they typed', shown: 'GG, pilots!', action: 'block', hits: ['profanity:x'],
  display: 'substituted', tags: ['PROFANITY'], ...over,
});

describe('T-CSV-1 the shared writer neutralises formula cells', () => {
  it('a text cell starting with = + - @, a tab or a carriage return gets a leading apostrophe and is quoted', () => {
    for (const p of POISON) {
      expect(looksLikeFormula(p)).toBe(true);
      const cell = csvCell(p);
      const parsed = parseLine(cell);
      expect(parsed).toEqual([`'${p}`]);
      expect(evaluates(parsed[0]!)).toBe(false);
    }
    expect(neutralizeCell('hello')).toBe('hello');
    expect(csvCell('a, "b"')).toBe('"a, ""b"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(['PROFANITY', 'HATE'])).toBe('PROFANITY HATE');
    expect(csvCell(true)).toBe('true');
  });

  it('numbers are written as numbers; anything else that starts like a formula is text', () => {
    expect(csvCell(42)).toBe('42');
    expect(csvCell(-1)).toBe('-1');
    expect(csvCell(10n)).toBe('10');
    expect(csvCell(Number.NaN)).toBe('');
    expect(csvCell('-1')).toBe('"\'-1"'); // the text "-1" (a callsign, a note) is neutralised
    expect(csvCell({ toString: () => '=1' })).toBe('{}');
  });

  it('every export column set is safe: chat, conduct, accounts, custom terms', () => {
    const conduct: CsvColumn<{ user: string; tag: string; n: number; note: string }>[] = [
      { header: 'student', value: (r) => r.user }, { header: 'tag', value: (r) => r.tag }, { header: 'count', value: (r) => r.n }, { header: 'note', value: (r) => r.note },
    ];
    const accounts: CsvColumn<{ username: string; email: string; status: string }>[] = [
      { header: 'username', value: (r) => r.username }, { header: 'email', value: (r) => r.email }, { header: 'status', value: (r) => r.status },
    ];
    const terms: CsvColumn<{ term: string; category: string; context: string[]; note: string }>[] = [
      { header: 'term', value: (r) => r.term }, { header: 'category', value: (r) => r.category }, { header: 'context', value: (r) => r.context.join('|') }, { header: 'note', value: (r) => r.note },
    ];
    const docs = [
      toCsv(conduct, POISON.map((p, i) => ({ user: p, tag: p, n: i, note: p }))),
      toCsv(accounts, POISON.map((p) => ({ username: p, email: `${p}@caldwellschools.org`, status: p }))),
      toCsv(terms, POISON.map((p) => ({ term: p, category: p, context: [p, 'b'], note: p }))),
      toCsv(chatLogColumns({ includeOriginal: true }), POISON.map((p) => row({ name: p, roomName: p, original: p, shown: p, accountId: p, tags: [p] }))),
    ];
    for (const doc of docs) {
      expect(doc.startsWith(CSV_BOM)).toBe(true);
      const lines = parseDoc(doc);
      expect(lines.length).toBe(POISON.length + 1);
      for (const cells of lines) for (const c of cells) expect(evaluates(c), `cell ${JSON.stringify(c)}`).toBe(false);
    }
  });
});

describe('the CSV and JSON writers', () => {
  it('CSV: BOM, header, CRLF rows; streaming in pages equals one document', () => {
    const cols: CsvColumn<{ a: string; b: number }>[] = [{ header: 'a', value: (r) => r.a }, { header: 'b', value: (r) => r.b }];
    const w = new CsvWriter(cols);
    const doc = w.head() + w.rows([{ a: 'x', b: 1 }]) + w.rows([{ a: 'y', b: 2 }]) + w.end();
    expect(doc).toBe(`${CSV_BOM}a,b${CSV_EOL}x,1${CSV_EOL}y,2${CSV_EOL}`);
    expect(toCsv(cols, [{ a: 'x', b: 1 }, { a: 'y', b: 2 }])).toBe(doc);
    expect(csvRow(['a', 1, null])).toBe('a,1,');
  });

  it('JSON: an array of objects keyed by the headers (empty → [])', () => {
    const cols: CsvColumn<{ a: string }>[] = [{ header: 'a', value: (r) => r.a }, { header: 'missing', value: () => undefined }];
    const w = new JsonArrayWriter(cols);
    const doc = w.head() + w.rows([{ a: '=x' }]) + w.rows([{ a: 'y' }]) + w.end();
    expect(JSON.parse(doc)).toEqual([{ a: '=x', missing: null }, { a: 'y', missing: null }]);
    const empty = new JsonArrayWriter(cols);
    expect(JSON.parse(empty.head() + empty.end())).toEqual([]);
    expect(exportWriter('json', cols)).toBeInstanceOf(JsonArrayWriter);
    expect(exportWriter('csv', cols)).toBeInstanceOf(CsvWriter);
  });
});

describe('the Chat log columns (§5.5)', () => {
  it('what they typed only when asked; what others saw with its display; tags; team and channel by name', () => {
    const shown = chatLogColumns({ includeOriginal: false });
    expect(shown.map((c) => c.header)).toEqual(['id', 'time', 'room', 'team', 'channel', 'player', 'account', 'what others saw', 'action', 'display', 'tags']);
    const all = chatLogColumns({ includeOriginal: true });
    expect(all.map((c) => c.header)).toEqual(['id', 'time', 'room', 'team', 'channel', 'player', 'account', 'what they typed', 'what others saw', 'action', 'display', 'tags']);
    const [head, line] = parseDoc(toCsv(shown, [row()]));
    const rec = Object.fromEntries(head!.map((h, i) => [h, line![i]]));
    expect(rec).toMatchObject({ id: '7', room: 'Flag Run', team: 'Crimson', channel: 'team', player: 'NovaPilot', account: 'acc-1', 'what others saw': 'GG, pilots!', action: 'block', display: 'substituted', tags: 'PROFANITY' });
    expect(toCsv(shown, [row()])).not.toContain('what they typed');
    expect(rec.time).toBe(exportTime(row().ts));
    expect(exportTime(Date.UTC(2026, 8, 28, 14, 2, 15), true)).toBe('2026-09-28 14:02:15 UTC');
    expect(exportTime(Number.NaN)).toBe('');
  });

  it('channel and team names; file names', () => {
    expect(exportChannel({ channel: 'all', roomId: null, roomUid: 'b:zone' })).toBe('lobby');
    expect(exportChannel({ channel: 'all', roomId: 'r1', roomUid: 'b:r1' })).toBe('all');
    expect(exportChannel({ channel: 'announce', roomId: null, roomUid: null })).toBe('announcements');
    expect(exportChannel({ channel: 'name', roomId: null, roomUid: null })).toBe('names');
    expect(exportChannel({ channel: 'room', roomId: 'r1', roomUid: null })).toBe('room names');
    expect(exportTeam(-1)).toBe('');
    expect(exportTeam(1)).toBe('Azure');
    const name = exportFileName('Chat Log!', 'csv', new Date(2026, 8, 28, 14, 2, 15).getTime());
    expect(name).toBe('voidswarm-chat-log-2026-09-28_140215.csv');
  });
});
