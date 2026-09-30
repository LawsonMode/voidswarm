// OWNER: SERVER MODERATION. Custom terms (docs/LAN-EDITION-proposal.md §5.12), the part the M1 gate needs: the
// host's own words in the `custom_terms` table (schema v4), installed process-wide in the word filter
// (shared/moderation/custom.ts setCustomTerms) at start and on every change, and the admin endpoints
// customTerms/list, customTerms/add, customTerms/remove and customTerms/test (★, host admin only: cap `terms`).
// update, import, export and confirm are M4 (B21) and still answer 501.
//
// Rules kept from §5.12:
//  - A typed entry is confirmed by the host who typed it (its action applies at once). An entry without a
//    confirmation (M4 imports) is installed with action 'flag' (review only).
//  - Every change is compiled first; a change that doesn't compile is not saved (the installed set stays).
//  - The terms are the host's data: never logged, never in the audit reason (the category only), never shown to
//    moderators (the route's cap), and the test box never names a built-in term (tags and custom hits only).
import type { DatabaseSync } from 'node:sqlite';
import { clearCustomTerms, compileCustomTerms, filterChat, setCustomTerms } from '../../shared/moderation/filter';
import type { CustomAction, CustomMatch, CustomScope, CustomTermInput } from '../../shared/moderation/custom';
import { hitLabel, tagsOf } from '../../shared/room/moderation';
import { openProtectedDb } from '../db/guard';
import type { AdminReply, AdminRouteHandler } from './http';

export interface CustomTermRow {
  id: number;
  term: string;
  category: string;
  action: CustomAction;
  scope: CustomScope;
  match: CustomMatch;
  anchors: string[];
  note: string;
  enabled: boolean;
  source: 'typed' | 'import';
  confirmedAt: number | null;
  confirmedBy: string | null;
  createdAt: number;
  createdBy: string;
}

type Row = Record<string, unknown>;
const ACTIONS: readonly CustomAction[] = ['block', 'mask', 'flag'];
const SCOPES: readonly CustomScope[] = ['chat', 'names', 'both'];
const MATCHES: readonly CustomMatch[] = ['word', 'phrase', 'strong'];

class BadRequest extends Error {}

const rowOf = (r: Row): CustomTermRow => {
  let anchors: string[] = [];
  try { const a = JSON.parse(String(r.context_json ?? '[]')); if (Array.isArray(a)) anchors = a.filter((x): x is string => typeof x === 'string'); } catch { /* none */ }
  return {
    id: Number(r.id), term: String(r.term), category: String(r.category ?? ''), action: r.action as CustomAction, scope: r.scope as CustomScope,
    match: r.match as CustomMatch, anchors, note: String(r.note ?? ''), enabled: Number(r.enabled) === 1,
    source: r.source === 'import' ? 'import' : 'typed', confirmedAt: r.confirmed_at == null ? null : Number(r.confirmed_at),
    confirmedBy: r.confirmed_by == null ? null : String(r.confirmed_by), createdAt: Number(r.created_at), createdBy: String(r.created_by),
  };
};

/** What the filter gets for a row: unconfirmed entries only flag (§5.12). */
const inputOf = (r: CustomTermRow): CustomTermInput => ({
  id: String(r.id), term: r.term, category: r.category || 'custom', action: r.confirmedAt === null ? 'flag' : r.action,
  scope: r.scope, match: r.match, ...(r.anchors.length ? { anchors: r.anchors } : {}),
});

const termKey = (t: string): string => t.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

export interface CustomTermsOptions {
  dbPath: string;
  log?: (line: string) => void;
  now?: () => number;
  /** The audit row of a change (ModerationService.audit(actor, 'terms', null, reason)); the reason never has the term. */
  audit?: (actor: { accountId: string; name: string }, reason: string) => void;
}

export class CustomTerms {
  private readonly db: DatabaseSync;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private closed = false;
  /** This instance installed a set (close() then clears it: one server per process, but tests run several). */
  private installed = false;

  constructor(private readonly opts: CustomTermsOptions) {
    this.log = opts.log ?? (() => undefined);
    this.now = opts.now ?? Date.now;
    this.db = openProtectedDb(opts.dbPath, { busyTimeoutMs: 2000 });
  }

  list(): CustomTermRow[] {
    return (this.db.prepare('SELECT * FROM custom_terms ORDER BY category, term_key, id').all() as Row[]).map(rowOf);
  }

  /** Compile the enabled rows and install them (at start and after each change). False = refused (logged). */
  install(rows: CustomTermRow[] = this.list()): { ok: boolean; errors: string[] } {
    const entries = rows.filter((r) => r.enabled).map(inputOf);
    if (!entries.length) { if (this.installed) clearCustomTerms(); this.installed = false; return { ok: true, errors: [] }; }
    const r = setCustomTerms(entries);
    if (!r.ok) {
      const errors = r.errors.slice(0, 10).map((e) => `${e.field}: ${e.message}`);
      this.log(`[mod] the custom terms were not installed (${r.errors.length} error(s)); the built-in filter still runs`);
      return { ok: false, errors };
    }
    this.installed = true;
    this.log(`[mod] ${r.accepted} custom term(s) active`);
    return { ok: true, errors: [] };
  }

  /** Add one typed term (confirmed by the host who typed it). Compiled first: a term that doesn't compile is not saved. */
  add(b: Record<string, unknown>, actor: { accountId: string; name: string }): { ok: true; term: CustomTermRow } {
    const term = typeof b.term === 'string' ? b.term.trim() : '';
    if (term.length < 2 || term.length > 64) throw new BadRequest('term must be 2 to 64 characters');
    const category = (typeof b.category === 'string' ? b.category : 'custom').toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim().slice(0, 24) || 'custom';
    const action = (b.action === undefined ? 'flag' : b.action) as CustomAction;
    if (!ACTIONS.includes(action)) throw new BadRequest('action must be block, mask or flag');
    const scope = (b.scope === undefined ? 'both' : b.scope) as CustomScope;
    if (!SCOPES.includes(scope)) throw new BadRequest('scope must be chat, names or both');
    const match = (b.match === undefined ? (/\s/.test(term) ? 'phrase' : 'word') : b.match) as CustomMatch;
    if (!MATCHES.includes(match)) throw new BadRequest('match must be word, phrase or strong');
    const anchors = Array.isArray(b.context) ? b.context.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 8) : [];
    const note = typeof b.note === 'string' ? b.note.slice(0, 200) : '';
    const now = this.now();
    const probe: CustomTermRow = {
      id: 0, term, category, action, scope, match, anchors, note, enabled: true, source: 'typed', confirmedAt: now, confirmedBy: actor.name, createdAt: now, createdBy: actor.name,
    };
    const check = compileCustomTerms([inputOf(probe)]);
    if (!check.ok) throw new BadRequest(check.errors[0]?.message ?? 'That term can\'t be used.');
    const key = termKey(term);
    if (this.db.prepare('SELECT 1 FROM custom_terms WHERE term_key = ? AND scope = ?').get(key, scope)) throw new BadRequest('That term is already on the list.');
    this.db.exec('BEGIN IMMEDIATE');
    let id: number;
    try {
      const r = this.db.prepare(`INSERT INTO custom_terms (term, term_key, category, action, scope, match, context_json, note, enabled, source,
          confirmed_at, confirmed_by, created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'typed', ?, ?, ?, ?, ?, ?)`)
        .run(term, key, category, action, scope, match, JSON.stringify(anchors), note, now, actor.name, now, actor.name, now, actor.name);
      id = Number(r.lastInsertRowid);
      const all = this.list();
      const compiled = compileCustomTerms(all.filter((x) => x.enabled).map(inputOf));
      if (!compiled.ok) throw new BadRequest(compiled.errors[0]?.message ?? 'The list would not compile with that term.');
      this.db.exec('COMMIT');
      this.install(all);
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
      throw e;
    }
    this.opts.audit?.(actor, `added a custom term (${category}, ${action}, ${scope})`);
    return { ok: true, term: this.list().find((x) => x.id === id)! };
  }

  remove(id: number, actor: { accountId: string; name: string }): { ok: boolean; removed: number } {
    const row = this.list().find((x) => x.id === id);
    if (!row) return { ok: false, removed: 0 };
    this.db.prepare('DELETE FROM custom_terms WHERE id = ?').run(id);
    this.install();
    this.opts.audit?.(actor, `removed a custom term (${row.category}, ${row.action})`);
    return { ok: true, removed: 1 };
  }

  /** "Try a line": the verdict, the tags and the custom hits (never a built-in term). */
  test(line: string): { action: string; tags: string[]; customHits: string[] } {
    const r = filterChat(line.slice(0, 400));
    const custom = r.hits.filter((h) => (h as { source?: unknown }).source === 'custom' || (h as { tier?: unknown }).tier === 'flag').map(hitLabel);
    return { action: r.action, tags: tagsOf(r.hits), customHits: custom };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.installed) clearCustomTerms();
    this.installed = false;
    try { this.db.close(); } catch { /* closed */ }
  }
}

const reply = (fn: () => AdminReply): AdminReply => {
  try { return fn(); } catch (e) {
    if (e instanceof BadRequest) return [400, { error: e.message }];
    throw e;
  }
};

/** The M1 custom-term endpoints (AdminHttpOptions.handlers). The route table gives them cap `terms` (host only). */
export function customTermsAdminHandlers(t: CustomTerms): Record<string, AdminRouteHandler> {
  return {
    'customTerms/list': () => [200, { ok: true, terms: t.list() }],
    'customTerms/add': (b, c) => reply(() => [200, t.add(b, c.actor)]),
    'customTerms/remove': (b, c) => reply(() => {
      const id = b.id;
      if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) throw new BadRequest('id is required');
      const r = t.remove(id, c.actor);
      return r.ok ? [200, r] : [404, { error: 'No such term.' }];
    }),
    'customTerms/test': (b) => reply(() => {
      if (typeof b.text !== 'string' || !b.text.trim()) throw new BadRequest('text is required');
      return [200, { ok: true, ...t.test(b.text) }];
    }),
  };
}
