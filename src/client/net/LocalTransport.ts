import { SNAPSHOT_EVERY_LOCAL } from '../../shared/constants';
import type { ProfileStore } from '../../shared/profile/store';
import type { ClientMsg, ServerMsg } from '../../shared/protocol';
import { houseRooms } from '../../shared/room/houseRooms';
import { Zone, type ConnectionHandle } from '../../shared/room/Zone';
import type { Snapshot } from '../../shared/types';
import { LocalProfileStore } from '../profile/LocalProfileStore';
import type { Transport } from './transport';

export const OFFLINE_MOTD = 'Offline — pick a game type. Bots fill every seat.';

export interface LocalTransportOptions {
  /** v0.3: the device profile store the in-page Zone's ProfileService uses (key 'local'). */
  profiles?: ProfileStore;
}

/** Offline play: runs a whole Zone in-page. Delivery is async (microtasks) to mimic network ordering. */
export class LocalTransport implements Transport {
  readonly kind = 'offline' as const;
  onMessage: ((msg: ServerMsg) => void) | null = null;
  onSnapshot: ((s: Snapshot) => void) | null = null;
  onClose: ((reason: string, code?: number) => void) | null = null;
  readonly profiles: ProfileStore;
  private zone: Zone | null = null;
  private conn: ConnectionHandle | null = null;
  private open = false;

  constructor(opts: LocalTransportOptions = {}) {
    this.profiles = opts.profiles ?? new LocalProfileStore();
  }

  async connect(): Promise<void> {
    // A plain variable (not an inline literal) so this compiles whether or not ZoneOptions.profiles has
    // landed yet (ROOM M2: `ZoneOptions += profiles?: ProfileStore`, docs/v0.3-proposal.md §8.8).
    const options = {
      snapshotEvery: SNAPSHOT_EVERY_LOCAL,
      local: true,
      // v0.3: one local house room per game type that has a ready sub-mode (§2.6 / §3.3).
      defaultRooms: houseRooms(true),
      motd: OFFLINE_MOTD,
      // v0.3 M2: loot and the Hangar use the device profile (LocalProfileStore, §7.2).
      profiles: this.profiles,
    };
    const zone = new Zone(options);
    this.zone = zone;
    this.open = true;
    this.conn = zone.connect({
      sendMsg: (m) => queueMicrotask(() => { if (this.open) this.onMessage?.(m); }),
      sendSnapshot: (s) => queueMicrotask(() => { if (this.open) this.onSnapshot?.(s); }),
    });
    zone.start();
  }

  send(msg: ClientMsg): void {
    const conn = this.conn;
    if (!conn || !this.open) return;
    queueMicrotask(() => {
      if (!this.open) return;
      try { conn.handle(msg); } catch (e) { console.error('[voidswarm] local zone error', e); }
    });
  }

  close(): void {
    this.open = false;
    try { this.conn?.close(); } catch { /* ignore */ }
    try { this.zone?.stop(); } catch { /* ignore */ }
    this.conn = null;
    this.zone = null;
  }
}
