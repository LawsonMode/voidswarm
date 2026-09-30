// OWNER: SETTINGS. The settings endpoints' bodies (docs/LAN-EDITION-proposal.md §5.15 "Settings, server and
// backups": settings/get, settings/update { rev, patch }, network/approve), as the `[status, body]` pairs the admin
// HTTP handlers return (moderation/http.ts). The admin listener (B6) owns routing, sessions, capabilities and step-up;
// these only turn a SettingsService call into the documented response:
//  - 200 { ok: true, rev, settings, ... }
//  - 409 { error, rev }                      a stale rev (§5.15's settings revision mismatch)
//  - 409 { error, field, needsMailTest }      Required email without a successful test (T-SET-4)
//  - 400 { error, field?, rejected? }         a bad patch (the field is named; rejected = positive lines)
//  - 500 { error }                            the settings could not be saved
import { PRESETS, RESTART_PATHS, type HostSettings, type Preset } from './schema';
import type { SettingsActor, SettingsResult, SettingsService } from './service';

export type SettingsHttpReply = [number, Record<string, unknown>];

/** settings/get: the settings in force (never a secret: the SMTP password is only `mail.passwordSet`). */
export function settingsGetReply(svc: SettingsService): SettingsHttpReply {
  const settings: HostSettings = svc.get();
  return [200, {
    ok: true,
    rev: settings.rev,
    settings,
    mailReady: svc.mailReady(),
    presets: [...PRESETS] as Preset[],
    restartPaths: [...RESTART_PATHS],
  }];
}

/** Any SettingsService write → its reply. */
export function settingsReply(r: SettingsResult): SettingsHttpReply {
  if (r.ok) {
    return [200, { ok: true, rev: r.rev, settings: r.settings, changed: r.changed, warnings: r.warnings, restartNeeded: r.restartNeeded }];
  }
  const body: Record<string, unknown> = { error: r.error };
  if (r.field !== undefined) body.field = r.field;
  if (r.rev !== undefined) body.rev = r.rev;
  if (r.needsMailTest) body.needsMailTest = true;
  if (r.rejected) body.rejected = r.rejected;
  return [r.status, body];
}

/** settings/update { rev, patch }. */
export async function settingsUpdateReply(svc: SettingsService, body: unknown, actor: SettingsActor): Promise<SettingsHttpReply> {
  return settingsReply(await svc.update(body, actor));
}

/** network/approve { networkId, serve } → { ok } (host PC only; the listener checks that). */
export async function networkApproveReply(svc: SettingsService, body: unknown, actor: SettingsActor): Promise<SettingsHttpReply> {
  const b = (body && typeof body === 'object' ? body : {}) as { networkId?: unknown; serve?: unknown };
  const r = await svc.approveNetwork(b.networkId as string, b.serve as boolean, actor);
  return r.ok ? [200, { ok: true }] : settingsReply(r);
}
