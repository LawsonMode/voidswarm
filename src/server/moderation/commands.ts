// OWNER: SERVER MODERATION. Moderator chat commands (the Zone routes MOD_COMMANDS here only after the server-side
// isAdmin check; everyone else gets the ordinary "Unknown command" line). Replies are private system lines.
import type { ModUser } from '../../shared/room/moderation';
import { describeDuration, hhmm, parseDuration, stamp } from './durations';
import { isAddressTarget, type Actor, type BanSpec, type ModerationService, type Result, type Target } from './service';
import type { BanKind, BanRow, ChatLogRow } from './store';

export const MOD_HELP: readonly string[] = [
  'Moderator commands (only moderators see or can use these):',
  '/ban <name> <10m|2h|1d|7d|perm> <reason> — ban their account (disconnects them)',
  '/ipban <name> <dur> <reason> — ban their network address: EVERYONE there (a school shares one address)',
  '/mute <name> <dur> [reason]   /unmute <name>   /unban <name | #id>',
  '/ban, /ipban and /mute also take a network address (from /whois): that means EVERYONE on it, moderators excepted',
  '/kick <name> [reason]   /warn <name> <message>',
  '/log <name> [n]   /whois <name>   /reports [reviewed|dismiss <id>]',
  'Dashboard: open /admin on this server and sign in with your account.',
];

const DURATION_HINT = 'Duration must look like 10m, 2h, 1d, 7d or perm.';

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

function logLine(r: ChatLogRow): string {
  const where = r.channel === 'name' ? 'callsign' : r.channel === 'room' ? 'room name' : r.roomName || 'Zone';
  let tag = '';
  if (r.action === 'mask') tag = ` [masked: "${r.shown}"]`;
  else if (r.action !== 'pass') tag = ` [${r.action}]`;
  return `${hhmm(r.ts)} (${where}${r.channel === 'team' ? ', team' : ''}) ${r.name}: ${r.original}${tag}`;
}

function banLine(b: BanRow, svc: ModerationService): string {
  const who = b.scope === 'account' ? b.username ?? b.accountId : b.scope === 'address' ? `network ${b.address}`
    : b.username ? `guest ${b.username} @ ${b.address}` : `guests @ ${b.address}`;
  return `#${b.id} ${b.kind} ${who} ${svc.untilText(b.expiresAt)} — ${b.reason} (by ${b.by})`;
}

export function runAdminCommand(svc: ModerationService, admin: ModUser, cmd: string, args: string[]): string[] {
  if (!admin.accountId) return [`Unknown command /${cmd} — try /help`]; // (never reached: isAdmin needs an account)
  const actor: Actor = { accountId: admin.accountId, name: admin.username ?? admin.name };
  const find = (name: string | undefined): Target | string => {
    if (!name) return 'Say who.';
    const t = svc.resolveTarget(name);
    return t ?? `No pilot or account called "${name.slice(0, 20)}".`;
  };
  switch (cmd) {
    case 'modhelp': return [...MOD_HELP];
    case 'ban': return ban(svc, actor, 'ban', undefined, args, 'Usage: /ban <name> <10m|2h|1d|7d|perm> <reason>');
    case 'ipban': return ban(svc, actor, 'ban', 'address', args, 'Usage: /ipban <name> <10m|2h|1d|7d|perm> <reason>');
    case 'mute': return ban(svc, actor, 'mute', undefined, args, 'Usage: /mute <name> <10m|2h|1d|7d|perm> [reason]');
    case 'unban': case 'unmute': {
      const kind: BanKind = cmd === 'unban' ? 'ban' : 'mute';
      const q = args[0];
      if (!q) return [`Usage: /${cmd} <name | #id>`];
      const idm = /^#?(\d+)$/.exec(q);
      let res: Result<{ revoked: number; bans: BanRow[] }>;
      let label = q;
      if (idm && q.startsWith('#')) {
        res = svc.revoke(actor, { id: Number(idm[1]) });
      } else {
        const t = find(q);
        if (typeof t === 'string') return [t];
        label = t.name;
        res = svc.revoke(actor, { target: t, kind });
      }
      if (!res.ok) return [res.error];
      return [res.revoked ? `Lifted ${plural(res.revoked, kind)} for ${label} (${res.bans.map((b) => `#${b.id}`).join(', ')}).` : `${label} has no active ${kind}.`];
    }
    case 'kick': {
      const t = find(args[0]);
      if (typeof t === 'string') return [args[0] ? t : 'Usage: /kick <name> [reason]'];
      const res = svc.kick(actor, t, args.slice(1).join(' '));
      return [res.ok ? `Kicked ${t.name}.` : res.error];
    }
    case 'warn': {
      if (args.length < 2) return ['Usage: /warn <name> <message>'];
      const t = find(args[0]);
      if (typeof t === 'string') return [t];
      const res = svc.warnPilot(actor, t, args.slice(1).join(' '));
      return [res.ok ? `Warned ${t.name}.` : res.error];
    }
    case 'log': {
      const t = find(args[0]);
      if (typeof t === 'string') return [args[0] ? t : 'Usage: /log <name> [lines]'];
      const n = Math.max(1, Math.min(50, parseInt(args[1] ?? '10', 10) || 10));
      const rows = svc.chatOf(t, n);
      svc.auditRead(actor, `chat log ${t.name}`);
      if (!rows.length) return [`${t.name} has no chat on record.`];
      return [`Last ${plural(rows.length, 'line')} of ${t.name}:`, ...rows.map(logLine)];
    }
    case 'reports': {
      const sub = (args[0] ?? '').toLowerCase();
      if (sub === 'reviewed' || sub === 'dismiss' || sub === 'dismissed' || sub === 'open') {
        const id = parseInt((args[1] ?? '').replace('#', ''), 10);
        if (!Number.isFinite(id)) return ['Usage: /reports reviewed <id>  or  /reports dismiss <id>'];
        const status = sub === 'reviewed' ? 'reviewed' : sub === 'open' ? 'open' : 'dismissed';
        const res = svc.reviewReport(actor, id, status, null);
        return [res.ok ? `Report #${id} marked ${status}.` : res.error];
      }
      const { reports } = svc.listReports('open', 10);
      svc.auditRead(actor, 'reports open');
      if (!reports.length) return ['No open reports.'];
      return [
        `${plural(reports.length, 'open report')} (newest first):`,
        ...reports.map((r) => `#${r.id} ${stamp(r.ts)} ${r.reporter.name} → ${r.target.name}: ${r.reason} (${r.room})`),
        'Details on /admin, or /log <name>. Close one: /reports reviewed <id> (or dismiss <id>).',
      ];
    }
    case 'whois': {
      const t = find(args[0]);
      if (typeof t === 'string') return [args[0] ? t : 'Usage: /whois <name>'];
      const w = svc.whois(t);
      svc.auditRead(actor, `whois ${t.name}`);
      const out: string[] = [];
      const acct = w.account ? `account ${w.account.username} (since ${stamp(w.account.createdAt).slice(0, 10)})${w.account.admin ? ', moderator' : ''}` : 'guest (no account)';
      const where = w.online.length ? `online in ${w.online.map((p) => p.roomName ?? 'the zone lobby').join(', ')}` : 'offline';
      out.push(`${t.name}: ${acct}, ${where}.`);
      if (w.addresses.length) {
        const addr = w.addresses[0]!;
        const sharing = svc.online().filter((p) => p.address === addr && !w.online.some((o) => o.playerId === p.playerId)).length;
        out.push(`Address: ${addr}${sharing ? ` (${plural(sharing, 'other pilot')} online share it)` : ''}${w.addresses.length > 1 ? ` · also seen: ${w.addresses.slice(1, 4).join(', ')}` : ''}`);
      }
      out.push(w.activeBans.length ? `Active: ${w.activeBans.map((b) => banLine(b, svc)).join(' · ')}` : 'No active bans or mutes.');
      out.push(`Strikes (last ${Math.round(svc.config.strikeWindowMs / 60000)} min): ${w.strikes} · flagged lines (24 h): ${w.flagged24h}`);
      if (w.recentActions.length) {
        out.push(`Recent: ${w.recentActions.slice(0, 3).map((a) => `${a.action} by ${a.actor} ${stamp(a.ts)}${a.reason ? ` — ${a.reason}` : ''}`).join(' · ')}`);
      }
      return out;
    }
    case 'confirm': {
      const run = svc.takePending(actor.accountId);
      return run ? run() : ['Nothing to confirm.'];
    }
    default: return [`Unknown command /${cmd} — try /help`];
  }
}

function ban(svc: ModerationService, actor: Actor, kind: BanKind, scope: BanSpec['scope'], args: string[], usage: string): string[] {
  const [name, dur, ...rest] = args;
  if (!name || !dur) return [usage];
  const sec = parseDuration(dur);
  if (sec === undefined) return [DURATION_HINT];
  const t = svc.resolveTarget(name);
  if (!t) return [`No pilot or account called "${name.slice(0, 20)}".`];
  const network = isAddressTarget(t);
  if (kind === 'ban' && !scope && !t.accountId && !network) {
    return [
      `${t.name} is a guest (no account), so there is no account to ban.`,
      `/kick ${t.name} removes them now, /mute ${t.name} <dur> silences them, and /ipban ${t.name} <dur> <reason> blocks their whole network (everyone there — a school usually shares one address).`,
    ];
  }
  const spec: BanSpec = { kind, target: t, scope, durationSec: sec, reason: rest.join(' ') };
  const done = (res: ReturnType<ModerationService['createBan']>): string[] => {
    if (!res.ok) return [res.error];
    const b = res.ban;
    const who = network ? `network ${t.name}` : b.scope === 'address' ? `the network of ${t.name}` : t.name;
    const verb = kind === 'ban' ? 'Banned' : 'Muted';
    const len = sec === null ? '' : `${describeDuration(sec)}, `;
    return [`${verb} ${who} ${svc.untilText(b.expiresAt)} (${len}#${b.id})${res.kicked ? ` — disconnected ${plural(res.kicked, 'connection')}` : ''}.`];
  };
  const res = svc.createBan(actor, spec);
  if (!res.ok && res.needsConfirm) {
    svc.setPending(actor.accountId, () => done(svc.createBan(actor, { ...spec, confirm: true })));
    return [res.error, `Type /confirm within 60 s to go ahead, or use /ban (account only) or /mute instead.`];
  }
  return done(res);
}
