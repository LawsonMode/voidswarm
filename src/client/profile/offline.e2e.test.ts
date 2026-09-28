// M2 integration (end to end, offline): the in-page Zone's ProfileService writes match grants into the device
// LocalProfileStore (key 'local'), the same store the Hangar and the Command screen read. Real Zone, Room and Sim.
import { describe, expect, it } from 'vitest';
import { COUNTDOWN_SEC, TICK_RATE } from '../../shared/constants';
import type { ServerMsg } from '../../shared/protocol';
import type { Room } from '../../shared/room/Room';
import { houseRooms } from '../../shared/room/houseRooms';
import { Zone } from '../../shared/room/Zone';
import { PROTOCOL_VERSION } from '../../shared/version';
import { DEVICE_PROFILE_KEY, LocalProfileStore, type StorageLike } from './LocalProfileStore';

class MemStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string): string | null { return this.data.get(k) ?? null; }
  setItem(k: string, v: string): void { this.data.set(k, v); }
}

describe('offline end to end', () => {
  it('Quick Play → match → /end: the secured caches land in the device profile, and a second tab never wipes them', () => {
    const st = new MemStorage();
    const zone = new Zone({ snapshotEvery: 1, local: true, motd: '', defaultRooms: houseRooms(true), profiles: new LocalProfileStore(() => st) });
    const msgs: ServerMsg[] = [];
    const conn = zone.connect({ sendMsg: (m) => { msgs.push(m); }, sendSnapshot: () => {} });
    conn.handle({ type: 'hello', name: 'Solo', protocol: PROTOCOL_VERSION, version: 'e2e' });
    const welcome = msgs.find((m): m is Extract<ServerMsg, { type: 'welcome' }> => m.type === 'welcome')!;
    expect(msgs.find((m) => m.type === 'profile')).toMatchObject({ persisted: true });

    conn.handle({ type: 'quickPlay', gameType: 'warzone' });
    for (let i = 0; i < (COUNTDOWN_SEC + 1) * TICK_RATE; i++) zone.tick();
    const room = [...(zone as unknown as { rooms: Map<string, Room> }).rooms.values()].find((r) => r.phase === 'playing')!;
    expect(room).toBeTruthy();
    const w = room.world!;
    expect(w.config.lootMult).toBe(1); // offline is always 1.0
    const ship = w.ships.get(w.shipsByPlayer.get(welcome.playerId)!)!;
    ship.carried = [{ rarity: 4, set: 'swarm', source: 'boss' }, { rarity: 0, set: 'common', source: 'elite' }];
    conn.handle({ type: 'chat', channel: 'all', text: '/end' });

    const lg = msgs.filter((m): m is Extract<ServerMsg, { type: 'lootGrant' }> => m.type === 'lootGrant').pop()!;
    expect(lg).toMatchObject({ persisted: true, grant: { cachesSecured: 2 } });
    const blob = JSON.parse(st.data.get(DEVICE_PROFILE_KEY)!);
    expect(blob.ledger).toContain(lg.grant.grantKey);
    expect(blob.profiles.local.owned['swarm.turret.laser']).toBeTruthy(); // the Swarm set's only legendary
    const last = msgs.filter((m): m is Extract<ServerMsg, { type: 'profile' }> => m.type === 'profile').pop()!;
    expect(last.profile.owned['swarm.turret.laser']).toBeTruthy();

    // a second offline tab opened before this grant can't overwrite it with its older copy
    const other = new LocalProfileStore(() => st);
    const stale = other.load('local') as { owned: Record<string, unknown> };
    delete stale.owned['swarm.turret.laser'];
    st.data.set(DEVICE_PROFILE_KEY, JSON.stringify({ ...blob, profiles: { local: { ...blob.profiles.local, shards: blob.profiles.local.shards + 1 } } }));
    expect(() => other.save('local', stale as never)).toThrow();
    expect(JSON.parse(st.data.get(DEVICE_PROFILE_KEY)!).profiles.local.owned['swarm.turret.laser']).toBeTruthy();
    zone.stop();
  });
});
