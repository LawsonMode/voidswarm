// OWNER: SERVER MODERATION. The moderation CLI (`npm run mod -- <command>`; entry point ./cli.ts). It opens the game
// DB directly (WAL, so it works while the server runs); a running server notices ban / mute / moderator changes
// within a few seconds (mod_meta.rev) and disconnects newly banned pilots itself.
import { existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { AuthStore } from '../auth/store';
import { describeDuration, parseDuration, parseSince, stamp } from './durations';
import { CLI_ACTOR, ModerationService, isAddressTarget, looksLikeAddress, type BanSpec } from './service';
import { MOD_SCHEMA_MIN, type BanRow, type ChatLogRow, type LogQuery, type ReportRow, type ReportStatus } from './store';

export interface CliIO {
  out(s: string): void;
  err(s: string): void;
  env: NodeJS.ProcessEnv;
  now?: () => number;
}

export const CLI_USAGE = `Voidswarm moderation — npm run mod -- <command> [args]   (DB: $DB_PATH, default data/voidswarm.db)

Moderators
  promote <username>                 make an account a moderator (chat commands + the /admin dashboard)
  demote <username>                  remove a moderator
  admins                             list moderators

Bans and mutes (durations: 10m 2h 1d 7d perm)
  ban <name> <dur> <reason...>       ban an account (disconnected within seconds if online)
  ipban <name|address> <dur> <reason...> [--guests-only]
                                     ban a network address: EVERYONE there (a school usually shares one address);
                                     --guests-only blocks only guests (no account) from it
  mute <name> <dur> [reason...]      mute an account (or a guest callsign on its network)
  unban <name|#id|address>           lift bans            unmute <name|#id>   lift mutes
  bans [--all] [--mutes|--bans]      list active bans / mutes (--all: include lifted and expired)

Chat log and reports
  log [--player X] [--since 2h] [--grep text] [--flagged|--review] [--limit n]
                                     --flagged: every line the filter acted on (masked, blocked, spam, muted);
                                     --review: lines a review-only custom term flagged (shown, never a strike)
  export-log [--since 7d] [--player X] [--flagged|--review] [--out file.csv]
                                     CSV to stdout (use "npm run -s mod -- export-log ... > file.csv") or --out
  reports [--open]                   list reports (newest first)
  review <id> [reviewed|dismiss|open] [note...]

Retention and privacy
  prune                              apply the retention rules now (CHAT_LOG_RETENTION_DAYS, default 90)
  purge-log --before <30d|12h|...>   delete chat-log lines older than that, now (--player X: only theirs)
  purge-log --all --yes              delete the WHOLE chat log (reports keep their own saved lines)
`;

interface Flags { pos: string[]; opt: Map<string, string | true> }

const VALUE_FLAGS = new Set(['player', 'since', 'grep', 'limit', 'out', 'until', 'before']);

function parseFlags(args: string[]): Flags {
  const pos: string[] = [];
  const opt = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = (eq > 0 ? a.slice(2, eq) : a.slice(2)).toLowerCase();
      if (eq > 0) opt.set(k, a.slice(eq + 1));
      else if (VALUE_FLAGS.has(k) && i + 1 < args.length) opt.set(k, args[++i]!);
      else opt.set(k, true);
    } else pos.push(a);
  }
  return { pos, opt };
}

const flagStr = (f: Flags, k: string): string | undefined => {
  const v = f.opt.get(k);
  return typeof v === 'string' && v ? v : undefined;
};

/** Open (creating / migrating if needed) the DB and the moderation service on it, without timers. */
function openService(dbPath: string, now: () => number, err: (s: string) => void): ModerationService {
  let version = -1;
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath);
    try { version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version); } finally { db.close(); }
  }
  // A missing or older file is created / migrated by the AuthStore (the same migrations the server runs).
  if (version < MOD_SCHEMA_MIN) new AuthStore(dbPath).close();
  return new ModerationService({
    dbPath, now, timers: false, busyTimeoutMs: 5000,
    log: (line) => { if (!line.startsWith('[mod] ready')) err(line); },
  });
}

/** " [for review: ...]" for a masked line that also carries review-only hits ("flag:..." labels). */
const reviewHits = (r: ChatLogRow): string => {
  const flags = r.hits.filter((h) => h.startsWith('flag:'));
  return flags.length ? `  [for review: ${flags.join(', ')}]` : '';
};

function logRow(r: ChatLogRow): string {
  const who = `${r.name}${r.accountId ? '' : ' (guest)'}`;
  const where = r.channel === 'name' ? 'callsign attempt' : r.channel === 'room' ? 'room name attempt' : `${r.roomName}${r.channel === 'team' ? ' / team' : ''}`;
  let tag = '';
  if (r.action === 'mask') tag = `  [masked → "${r.shown}"]${reviewHits(r)}`;
  else if (r.action === 'flag') tag = `  [for review: ${r.hits.join(', ')}]`;
  else if (r.action !== 'pass') tag = `  [${r.action}${r.hits.length ? `: ${r.hits.join(', ')}` : ''}]`;
  return `${stamp(r.ts)}  ${where}  ${who}${r.address ? ` @${r.address}` : ''}: ${r.original}${tag}`;
}

function banRow(b: BanRow, svc: ModerationService): string {
  const who = b.scope === 'account' ? `account ${b.username ?? b.accountId}` : b.scope === 'address' ? `network ${b.address}`
    : b.username ? `guest "${b.username}" @ ${b.address}` : `guests @ ${b.address}`;
  const state = b.active ? svc.untilText(b.expiresAt) : b.revokedAt !== null ? `lifted ${stamp(b.revokedAt)}` : `expired ${stamp(b.expiresAt ?? 0)}`;
  return `#${b.id}  ${b.kind.padEnd(4)}  ${who}  ${state}  — ${b.reason}  (by ${b.by}, ${stamp(b.createdAt)})`;
}

function reportRow(r: ReportRow): string[] {
  const out = [`#${r.id}  ${stamp(r.ts)}  [${r.status}]  ${r.reporter.name} → ${r.target.name}${r.target.accountId ? '' : ' (guest)'}  in ${r.room}: ${r.reason}`];
  for (const l of r.recentChat.slice(-5)) out.push(`      ${logRow(l)}`);
  if (r.reviewedBy) out.push(`      reviewed by ${r.reviewedBy}${r.reviewedAt ? ` ${stamp(r.reviewedAt)}` : ''}${r.note ? `: ${r.note}` : ''}`);
  return out;
}

/**
 * One CSV cell: quoted when needed; a TEXT cell starting with = + - @ (a spreadsheet formula) is neutralized with a
 * quote mark. Numbers (team -1, ids) are written as they are.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADER = ['id', 'time', 'room', 'channel', 'team', 'player_id', 'name', 'account_id', 'address', 'action', 'original', 'shown', 'hits'];

export function csvLine(r: ChatLogRow): string {
  return [r.id, new Date(r.ts).toISOString(), r.roomName, r.channel, r.team, r.playerId, r.name, r.accountId, r.address, r.action,
    r.original, r.shown, r.hits.join(' ')].map(csvCell).join(',');
}

/** Run one CLI command. Returns the process exit code. */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const [cmdRaw, ...rest] = argv;
  const cmd = (cmdRaw ?? '').toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { io.out(CLI_USAGE); return cmd ? 0 : 1; }
  const known = ['promote', 'demote', 'admins', 'ban', 'ipban', 'mute', 'unban', 'unmute', 'bans', 'log', 'export-log', 'reports', 'review', 'prune', 'purge-log'];
  if (!known.includes(cmd)) { io.err(`Unknown command "${cmd}".\n\n${CLI_USAGE}`); return 1; }
  const now = io.now ?? Date.now;
  const dbPath = io.env.DB_PATH || 'data/voidswarm.db';
  let svc: ModerationService;
  try { svc = openService(dbPath, now, io.err); } catch (e) { io.err(`Can't open ${dbPath}: ${(e as Error)?.message ?? e}`); return 1; }
  try {
    return await run(svc, cmd, parseFlags(rest), io, now);
  } catch (e) {
    io.err(`Failed: ${(e as Error)?.message ?? e}`);
    return 1;
  } finally {
    svc.close();
  }
}

async function run(svc: ModerationService, cmd: string, f: Flags, io: CliIO, now: () => number): Promise<number> {
  const store = svc.store;
  const out = (s: string): void => io.out(`${s}\n`);
  const usage = (s: string): number => { io.err(`Usage: npm run mod -- ${s}\n`); return 1; };
  switch (cmd) {
    case 'promote': case 'demote': {
      const name = f.pos[0];
      if (!name) return usage(`${cmd} <username>`);
      const acc = store.accountByUsername(name);
      if (!acc) { io.err(`No account called "${name}". They need to create one in the game first.\n`); return 1; }
      if (cmd === 'promote') {
        const added = store.addAdmin(acc.id, CLI_ACTOR.name, now());
        if (added) svc.audit(CLI_ACTOR, 'promote', { accountId: acc.id, name: acc.username }, 'moderator');
        out(added ? `${acc.username} is now a moderator (a running server picks it up within seconds).` : `${acc.username} is already a moderator.`);
      } else {
        const removed = store.removeAdmin(acc.id);
        if (removed) svc.audit(CLI_ACTOR, 'demote', { accountId: acc.id, name: acc.username }, 'moderator removed');
        out(removed ? `${acc.username} is no longer a moderator.` : `${acc.username} was not a moderator.`);
      }
      return 0;
    }
    case 'admins': {
      const list = store.listAdmins();
      if (!list.length) out('No moderators yet. Add one: npm run mod -- promote <username>');
      for (const a of list) out(`${a.username ?? a.accountId}  (since ${stamp(a.addedAt)}, by ${a.addedBy})`);
      return 0;
    }
    case 'ban': case 'ipban': case 'mute': {
      const [name, dur, ...why] = f.pos;
      if (!name || !dur) return usage(`${cmd} <name${cmd === 'ipban' ? '|address' : ''}> <10m|2h|1d|7d|perm> ${cmd === 'mute' ? '[reason]' : '<reason>'}`);
      const sec = parseDuration(dur);
      if (sec === undefined) { io.err('Duration must look like 10m, 2h, 1d, 7d or perm.\n'); return 1; }
      const t = svc.resolveTarget(name);
      if (!t) { io.err(`No account, callsign or address "${name}" on record.\n`); return 1; }
      const spec: BanSpec = { kind: cmd === 'mute' ? 'mute' : 'ban', target: t, durationSec: sec, reason: why.join(' '), confirm: true };
      if (cmd === 'ipban') spec.scope = f.opt.has('guests-only') ? 'guest' : 'address';
      if (cmd === 'ipban' && spec.scope === 'guest') spec.target = { ...t, accountId: null, username: null, online: [] }; // all guests there
      if (cmd === 'ban' && !t.accountId) {
        io.err(isAddressTarget(t)
          ? `${t.name} is a network address. Use: npm run mod -- ipban ${t.name} ${dur} <reason> [--guests-only]\n`
          : `${t.name} is a guest (no account). Use: npm run mod -- ipban ${t.address ?? t.name} ${dur} <reason> [--guests-only]\n`);
        return 1;
      }
      const res = svc.createBan(CLI_ACTOR, spec);
      if (!res.ok) { io.err(`${res.error}\n`); return 1; }
      out(`${res.ban.kind === 'ban' ? 'Banned' : 'Muted'} ${res.ban.scope === 'address' ? `network ${res.ban.address}` : res.ban.scope === 'guest' ? `guests @ ${res.ban.address}${res.ban.username ? ` named ${res.ban.username}` : ''}` : t.name} `
        + `${svc.untilText(res.ban.expiresAt)} (${describeDuration(sec)}; #${res.ban.id}).`);
      if (res.ban.scope === 'address') out('Note: an address ban blocks EVERYONE on that network (accounts and guests).');
      if (res.ban.kind === 'ban') out('A running server disconnects them within a few seconds.');
      return 0;
    }
    case 'unban': case 'unmute': {
      const q = f.pos[0];
      if (!q) return usage(`${cmd} <name|#id${cmd === 'unban' ? '|address' : ''}>`);
      const kind = cmd === 'unban' ? 'ban' : 'mute';
      let res;
      if (/^#\d+$/.test(q)) res = svc.revoke(CLI_ACTOR, { id: Number(q.slice(1)) });
      else {
        const t = svc.resolveTarget(q) ?? (looksLikeAddress(q.toLowerCase())
          ? { query: q, name: q, online: [], accountId: null, username: null, address: q.toLowerCase(), playerId: null } : null);
        if (!t) { io.err(`No account, callsign or address "${q}" on record.\n`); return 1; }
        res = svc.revoke(CLI_ACTOR, { target: t, kind });
      }
      if (!res.ok) { io.err(`${res.error}\n`); return 1; }
      out(res.revoked ? `Lifted ${res.revoked} (${res.bans.map((b) => `#${b.id}`).join(', ')}).` : `Nothing active to lift for ${q}.`);
      return 0;
    }
    case 'bans': {
      const kind = f.opt.has('mutes') ? 'mute' : f.opt.has('bans') ? 'ban' : 'all';
      const list = store.listBans({ kind, includeInactive: f.opt.has('all'), limit: 1000 }, now());
      if (!list.length) out(f.opt.has('all') ? 'No bans or mutes on record.' : 'No active bans or mutes.');
      for (const b of list) out(banRow(b, svc));
      return 0;
    }
    case 'log': case 'export-log': {
      const q: LogQuery = { player: flagStr(f, 'player'), grep: flagStr(f, 'grep') };
      if (f.opt.has('review')) q.action = 'flag';
      else if (f.opt.has('flagged')) q.action = 'flagged';
      const since = flagStr(f, 'since');
      if (since !== undefined) {
        q.since = parseSince(since, now());
        if (q.since === undefined) { io.err('--since must be a duration like 2h or 7d.\n'); return 1; }
      }
      if (cmd === 'log') {
        q.limit = Math.max(1, Math.min(1000, parseInt(flagStr(f, 'limit') ?? '50', 10) || 50));
        const { lines } = store.searchLog(q);
        if (!lines.length) out('No chat lines match.');
        for (const r of lines.reverse()) out(logRow(r));
        return 0;
      }
      const chunks: string[] = [CSV_HEADER.join(',')];
      const outFile = flagStr(f, 'out');
      const emit = (s: string): void => { if (outFile) chunks.push(s); else io.out(`${s}\n`); };
      if (!outFile) io.out(`${chunks[0]}\n`);
      const n = store.exportLog(q, (rows) => { for (const r of rows) emit(csvLine(r)); });
      if (outFile) {
        writeFileSync(outFile, `﻿${chunks.join('\r\n')}\r\n`, 'utf8'); // BOM: spreadsheets read it as UTF-8
        io.err(`Wrote ${n} line(s) to ${outFile}\n`);
      }
      return 0;
    }
    case 'reports': {
      const status: ReportStatus | 'all' = f.opt.has('open') ? 'open' : 'all';
      const { reports } = store.listReports({ status, limit: 200 });
      if (!reports.length) out(status === 'open' ? 'No open reports.' : 'No reports.');
      for (const r of reports) for (const l of reportRow(r)) out(l);
      return 0;
    }
    case 'review': {
      const id = parseInt((f.pos[0] ?? '').replace('#', ''), 10);
      if (!Number.isFinite(id)) return usage('review <id> [reviewed|dismiss|open] [note...]');
      const s = (f.pos[1] ?? 'reviewed').toLowerCase();
      const status: ReportStatus = s.startsWith('dismiss') ? 'dismissed' : s === 'open' ? 'open' : 'reviewed';
      const note = f.pos.slice(2).join(' ') || null;
      const res = svc.reviewReport(CLI_ACTOR, id, status, note);
      if (!res.ok) { io.err(`${res.error}\n`); return 1; }
      out(`Report #${id} is now ${status}.`);
      return 0;
    }
    case 'prune': {
      const n = await svc.pruneNow(PRUNE_CLI_CHUNK);
      out(`Pruned ${n} old row(s).`);
      return 0;
    }
    case 'purge-log': {
      const all = f.opt.has('all');
      const before = flagStr(f, 'before');
      if (all === (before !== undefined)) return usage('purge-log --before <30d|12h|...> [--player X]   or   purge-log --all --yes');
      if (all && !f.opt.has('yes')) { io.err('This deletes the whole chat log. Add --yes to go ahead.\n'); return 1; }
      let cutoff = Number.MAX_SAFE_INTEGER;
      if (before !== undefined) {
        const since = parseSince(before, now());
        if (since === undefined) { io.err('--before must be a duration like 30d, 12h or 90m (lines older than that are deleted).\n'); return 1; }
        cutoff = since;
      }
      const player = flagStr(f, 'player');
      const n = store.purgeChat({ before: cutoff, player });
      svc.audit(CLI_ACTOR, 'note', player ? { name: player } : null,
        `purged ${n} chat-log line(s)${all ? ' (all)' : ` older than ${before}`}${player ? ` for ${player}` : ''}`);
      out(`Deleted ${n} chat-log line(s)${all ? '' : ` older than ${before}`}${player ? ` for ${player}` : ''}.`);
      return 0;
    }
  }
  return 1;
}

const PRUNE_CLI_CHUNK = 5000;
