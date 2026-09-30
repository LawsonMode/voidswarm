// OWNER: SETTINGS. The host settings service (docs/LAN-EDITION-proposal.md §5.13, §11.4): import from here.
//   schema.ts   HostSettings, the defaults and presets (Home / School), validate(), the per-leaf diff
//   store.ts    data\voidswarm.config.json: atomic writes, rev, env seeding, configVersion migration
//   service.ts  SettingsService: get, check, update ({ rev, patch }), apply, applyPreset, restore, subscribe, audit
//   bindings.ts live apply to the Zone, moderation, the connection gate and auth; the audit sink to mod_actions
//   api.ts      the settings endpoints' [status, body] replies (§5.15), for the admin listener
// Secrets (data\secrets\) are ../secrets.ts.
export * from './schema';
export * from './store';
export * from './service';
export * from './bindings';
export * from './api';
