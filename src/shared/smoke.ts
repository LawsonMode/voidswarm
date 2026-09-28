// OWNER: ROOM agent. Headless smoke test (`npm run smoke`): Zone + 16 bots in a Warzone Classic teams match for
// 60 s of sim ticks. v0.3: a second pilot drops in through Quick Play, the room list carries the live block,
// and a mid-match class change is checked to happen in place (no free respawn).
// v0.3 M2: in-world loot is on (two humans fly from the start, so lootMult is 1 for the whole match), the Zone runs
// on a MemoryProfileStore, SmokeA is an account pilot (profile after welcome), and the /end grant is checked
// end to end (ProfileService → rollGrant → commitGrants → lootGrant).
// v0.3 M3: `npm run smoke -- --mode ctf|zones|hotpoint|all` is the objective AI-parity gate (docs/v0.3-proposal.md
// §5.7 "Ready gate"): 16 bots play the sub-mode for 5 sim-minutes, watched by one spectator through the real
// Zone → Room → SnapshotBuilder → codec path, and must produce ≥ 1 flagCaptured (CTF), ≥ 2 zoneCaptured (Control
// Zones) or ≥ 1 hot capture + ≥ 2 hotMoved (Hot Point). It prints the objective stats and PvP kills and exits 1 when
// the gate fails. Options: --type arena|warzone (zones only), --ffa (hot point), --teams N, --sec N (window, 300),
// --minutes N (match length, 10), --limit N (target, 0 = default), --seed N|random (1234). A sub-mode that is not
// `ready` yet is opened for the gate room only (the integrator flips `ready` once the gate passes).
// v0.3 M4: `npm run smoke -- --rift [sec]` runs a Dungeon Runner rift (4 normal bots, 180 sim-s by default) on the Room
// path and logs the floor reached; it checks the floorStart-before-snapshot order, the rift tail codec round-trip, a
// pending drop-in added at a floor start, the live block and the /end abandon result. Options: --floors 3|6, --bots 1-4,
// --pve 1-3, --seed N|random, --sec N, --no-dropin.
// Node-only script (lives in shared/ by architecture decision; never imported by the client).
import { COUNTDOWN_SEC, TICK_RATE } from './constants';
import { GAME_TYPES, SUB_MODES, isLegalCombo, subModeLabel } from './data/gameTypes';
import { teamName } from './data/teams';
import { decodeSnapshot, encodeSnapshot } from './net/codec';
import { MemoryProfileStore } from './profile/store';
import { TEAM_UNASSIGNED, type AccountInfo, type ClientMsg, type MatchResult, type RoomSettings, type ServerMsg } from './protocol';
import type { Room } from './room/Room';
import { Zone, type ClientSink, type ZoneConnection } from './room/Zone';
import { carriedOf } from './sim/world';
import {
  SHIPFLAG_CARRIER, SHIPFLAG_INVULN, emptyInput,
  type DeployableKind, type GameType, type ObjectiveEventKind, type ObjectivePlayerStats, type ObjectiveSubMode,
  type PveIntensity, type RiftView, type ShipView, type Snapshot,
} from './types';
import { PROTOCOL_VERSION } from './version';

/** The RiftGameEvent kinds (smoke --rift counts them). */
const RIFT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'roomSeal', 'roomClear', 'roomReset', 'spawnWarn', 'chestOpen', 'bossIntro', 'bossPhase', 'telegraph', 'portalOpen',
  'departing', 'floorStart', 'lifeLost', 'outOfLives', 'extract', 'partyWiped', 'instability', 'riftEnd',
]);

/** Deep equality with a numeric tolerance (the codec rounds tail numbers to 1e-3). */
function approxEqual(a: unknown, b: unknown, eps = 1.5e-3): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= eps;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => approxEqual(v, b[i], eps));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => approxEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], eps));
  }
  return a === b;
}

class SmokeClient implements ClientSink {
  msgs: ServerMsg[] = [];
  snaps = 0;
  bytes = 0;
  maxBytes = 0;
  maxEnemies = 0;
  maxProjectiles = 0;
  maxDeployables = 0;
  deployKinds = new Map<DeployableKind, number>();
  events = 0;
  healSeen = 0;
  beams = 0;
  attachedSnaps = 0;
  hostingSnaps = 0;
  aliveSnaps = 0;
  energyOkSnaps = 0;
  lastSnap: Snapshot | null = null;
  /** shipSpawn events for this client's own ship: respawns AND v0.3 in-place class swaps (not a respawn count). */
  ownSpawns = 0;
  // v0.3 M2 loot
  maxLoot = 0;
  lootDrops = 0;
  lootPickups = 0;
  lootSpills = 0;
  maxCarried = 0;
  // v0.3 M3 objectives
  objEvents = new Map<ObjectiveEventKind, number>();
  /** Snapshots whose match carried an objective view. */
  objSnaps = 0;
  /** Largest `match.objective` JSON seen (bytes). */
  maxObjBytes = 0;
  /** ShipViews flagged SHIPFLAG_CARRIER (summed over snapshots). */
  carrierViews = 0;
  /** Hot point: times the view's owner (team, or FFA pilot) became someone new. */
  hotOwnerChanges = 0;
  private hotOwnerKey = '';
  // v0.3 M4 rift
  /** The floor this client was last told about (matchStart.floor, then every floorStart). */
  riftFloor = 0;
  floorStarts: { floor: number; tick: number }[] = [];
  /** Snapshots whose match carried a rift view. */
  riftSnaps = 0;
  /** Deepest match.dungeon.floor seen. */
  maxRiftFloor = 0;
  riftEvents = new Map<string, number>();
  /** Largest `match.dungeon` JSON seen (bytes). */
  maxRiftBytes = 0;
  lastRift: RiftView | null = null;
  conn!: ZoneConnection;
  constructor(readonly label: string) {}
  get pid(): number { return this.last('welcome')?.playerId ?? 0; }
  /** Class of this client's ship in the latest snapshot. */
  ownClass(): string | undefined {
    return this.ownView()?.shipClass;
  }
  /** This client's own ShipView in the latest snapshot. */
  ownView(): ShipView | undefined {
    const s = this.lastSnap;
    return s?.you ? s.ships.find((v) => v.id === s.you!.shipId) : undefined;
  }
  /** matchEnd messages received (cheap per-tick check for the gate loop). */
  matchEnds = 0;
  sendMsg(m: ServerMsg): void {
    this.msgs.push(m);
    if (m.type === 'matchEnd') this.matchEnds++;
    if (m.type === 'matchStart') this.riftFloor = m.floor;
    if (m.type === 'floorStart') { this.riftFloor = m.floor; this.floorStarts.push({ floor: m.floor, tick: m.tick }); }
    if (m.type === 'error') throw new Error(`${this.label} got error: ${m.message}`);
  }
  sendSnapshot(s: Snapshot): void {
    const buf = encodeSnapshot(s);
    const d = decodeSnapshot(buf);
    if (d.tick !== s.tick || d.ships.length !== s.ships.length || d.deployables.length !== s.deployables.length
      || (d.loot?.length ?? 0) !== (s.loot?.length ?? 0) || (d.carry?.length ?? 0) !== (s.carry?.length ?? 0)) {
      throw new Error('codec mismatch');
    }
    // v0.3 M3: every ship flag bit (incl. SHIPFLAG_CARRIER 128) and the objective tail survive the codec.
    for (let i = 0; i < s.ships.length; i++) {
      if (d.ships[i].flags !== (s.ships[i].flags & 255)) throw new Error(`codec mismatch: ship flags ${s.ships[i].flags} -> ${d.ships[i].flags}`);
      if (s.ships[i].flags & SHIPFLAG_CARRIER) this.carrierViews++;
    }
    const ov = s.match.objective;
    if (ov || d.match.objective) {
      if (!approxEqual(d.match.objective, ov)) throw new Error('codec mismatch: match.objective');
      this.objSnaps++;
      this.maxObjBytes = Math.max(this.maxObjBytes, JSON.stringify(ov ?? null).length);
      const z = ov?.mode === 'hotpoint' ? ov.zones?.[0] : undefined;
      if (z) {
        const key = z.owner >= 0 ? `t${z.owner}` : z.ownerPid ? `p${z.ownerPid}` : '';
        if (key && key !== this.hotOwnerKey) this.hotOwnerChanges++;
        this.hotOwnerKey = key;
      }
    }
    // v0.3 M4: the rift tail survives the codec, and no snapshot of a floor arrives before that floor's floorStart
    // (§4.8: the Room sends {type:'floorStart'} first) — nor a stale one after it.
    const rv = s.match.dungeon;
    if (rv || d.match.dungeon) {
      if (!approxEqual(d.match.dungeon, rv)) throw new Error('codec mismatch: match.dungeon');
      if (rv!.floor !== this.riftFloor) {
        throw new Error(`${this.label}: snapshot of floor ${rv!.floor} while the last matchStart / floorStart said floor ${this.riftFloor}`);
      }
      this.riftSnaps++;
      this.maxRiftFloor = Math.max(this.maxRiftFloor, rv!.floor);
      this.maxRiftBytes = Math.max(this.maxRiftBytes, JSON.stringify(rv).length);
      this.lastRift = rv!;
      if (s.you?.rift && !approxEqual(d.you?.rift, s.you.rift)) throw new Error('codec mismatch: you.rift');
    }
    for (const e of s.events) if (RIFT_EVENT_TYPES.has(e.t)) this.riftEvents.set(e.t, (this.riftEvents.get(e.t) ?? 0) + 1);
    this.maxLoot = Math.max(this.maxLoot, s.loot?.length ?? 0);
    this.maxCarried = Math.max(this.maxCarried, s.you?.carried?.length ?? 0);
    if ((s.you?.carried?.length ?? 0) > (s.you?.carryCap ?? Infinity)) throw new Error('carrying more than carryCap');
    this.snaps++;
    this.bytes += buf.byteLength;
    this.maxBytes = Math.max(this.maxBytes, buf.byteLength);
    this.maxEnemies = Math.max(this.maxEnemies, s.enemies.length);
    this.maxProjectiles = Math.max(this.maxProjectiles, s.projectiles.length);
    this.maxDeployables = Math.max(this.maxDeployables, s.deployables.length);
    for (const dep of s.deployables) this.deployKinds.set(dep.kind, Math.max(this.deployKinds.get(dep.kind) ?? 0, 1));
    this.events += s.events.length;
    for (const e of s.events) {
      if (e.t === 'heal') this.healSeen += e.amount;
      else if (e.t === 'beam') this.beams++;
      else if (e.t === 'shipSpawn' && e.playerId === this.pid) this.ownSpawns++;
      else if (e.t === 'lootDrop') this.lootDrops++;
      else if (e.t === 'lootPickup') this.lootPickups++;
      else if (e.t === 'lootSpill') this.lootSpills++;
      else if (e.t === 'objective') this.objEvents.set(e.kind, (this.objEvents.get(e.kind) ?? 0) + 1);
    }
    if (s.you && s.you.attachedTo) this.attachedSnaps++;
    if (s.you && s.you.turrets.length) this.hostingSnaps++;
    if (s.you && s.you.alive) this.aliveSnaps++;
    if (s.you && s.you.energy >= s.you.stats.maxEnergy * 0.6) this.energyOkSnaps++;
    this.lastSnap = d;
  }
  send(m: ClientMsg): void { this.conn.handle(m); }
  last<T extends ServerMsg['type']>(t: T): Extract<ServerMsg, { type: T }> | undefined {
    for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].type === t) return this.msgs[i] as Extract<ServerMsg, { type: T }>;
    return undefined;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

/** The v0.2 / M1 / M2 smoke: 60 s of Warzone Classic with humans, Quick Play drop-in, class swap and loot. */
function classicMain(): void {
  const store = new MemoryProfileStore();
  const zone = new Zone({
    snapshotEvery: 3, local: false, motd: 'smoke',
    defaultRooms: [{ name: 'Main Arena', gameType: 'warzone', subMode: 'deathmatch', mode: 'teams', teamCount: 2, botFill: 16 }],
    profiles: store,
  });
  const connect = (name: string, account: AccountInfo | null = null): SmokeClient => {
    const c = new SmokeClient(name);
    c.conn = zone.connect(c);
    c.conn.setAccount(account);
    c.send({ type: 'hello', name, protocol: PROTOCOL_VERSION, version: 'smoke' });
    assert(c.last('welcome'), `${name} welcomed`);
    return c;
  };

  const accountA: AccountInfo = { accountId: 'smoke-acc-a', username: 'SmokeA', emailMasked: 's***@smoke.test', createdAt: 0 };
  const a = connect('SmokeA', accountA);
  // §7.3.1: an account pilot gets its profile right after welcome.
  assert(a.msgs[1]?.type === 'profile', `account pilot gets its profile after welcome (got ${a.msgs[1]?.type})`);
  const roomId = a.last('roomList')!.rooms.find((r) => r.name === 'Main Arena')!.id;
  const roomOf = (): Room => (zone as unknown as { rooms: Map<string, Room> }).rooms.get(roomId)!;
  a.send({ type: 'joinRoom', roomId });
  a.send({ type: 'setTeam', team: 0 });
  a.send({ type: 'setShip', shipClass: 'tech' }); // tech turrets = Laser Lance
  // A second (guest) human flies from the start: ≥ 2 humans means lootMult 1 for the whole match (§6.4.6).
  const c = connect('SmokeC');
  assert(!c.last('profile'), 'online guests never get a profile message');
  c.send({ type: 'joinRoom', roomId });
  c.send({ type: 'setTeam', team: 1 });
  a.send({ type: 'startMatch' });

  const classes = new Map<string, number>();
  for (const p of a.last('roomState')!.players) classes.set(p.shipClass, (classes.get(p.shipClass) ?? 0) + 1);

  const totalTicks = COUNTDOWN_SEC * TICK_RATE + 60 * TICK_RATE;
  const midTick = COUNTDOWN_SEC * TICK_RATE + 30 * TICK_RATE;
  let b: SmokeClient | null = null;
  const classSwapTick = midTick + 120;
  /** Own ship just before / a few ticks after the mid-match class change. */
  let preSwap: { alive: boolean; energyFrac: number; invuln: boolean } | null = null;
  let postSwap: { alive: boolean; energyFrac: number; invuln: boolean; shipClass: string } | null = null;
  let liveListSeen = false;
  let seq = 0, seqC = 0;
  let lootMultSeen = -1;
  let sum = 0, max = 0, n = 0;
  for (let i = 0; i < totalTicks; i++) {
    if (c.last('matchStart')) {
      // SmokeC roams and shoots so it can meet (and pick up / spill) caches.
      const ic = emptyInput();
      ic.seq = ++seqC;
      ic.moveX = Math.sin(i / 110); ic.moveY = Math.cos(i / 95);
      ic.aim = -i / 40;
      ic.primary = i % 30 < 12;
      c.send({ type: 'input', input: ic });
    }
    if (i === midTick - 1) lootMultSeen = roomOf().sim?.world.config.lootMult ?? -1;
    if (a.last('matchStart')) {
      const inp = emptyInput();
      inp.seq = ++seq;
      const attached = !!a.lastSnap?.you?.attachedTo;
      if (!attached) { inp.moveX = Math.cos(i / 90); inp.moveY = Math.sin(i / 70); }
      inp.aim = i / 30;
      // first half: fly + fight with class skills; second half: bank energy and warp onto a teammate as a turret
      const turretPhase = i >= midTick;
      const you = a.lastSnap?.you;
      const energyOk = !!you && you.energy >= you.stats.maxEnergy * 0.6;
      inp.primary = attached || (!turretPhase && i % 20 < 10);
      inp.secondary = attached ? i % 240 < 60 : (!turretPhase && i % 120 === 0);
      inp.mobility = !attached && !turretPhase && i % 400 === 0;
      inp.utility = !attached && !turretPhase && i % 500 === 0;
      // a host can't attach: shake off riders first (rising edge), then attach two ticks later (rising edge)
      inp.detach = !attached && turretPhase && !!you?.turrets.length && i % 60 === 0;
      inp.attach = !attached && turretPhase && energyOk && i % 60 === 2;
      a.send({ type: 'input', input: inp });
    }
    if (i === midTick) {
      // v0.3 Quick Play: the running Warzone match is the best eligible room -> auto drop-in, class remembered.
      b = connect('SmokeB');
      const list = b.last('roomList')!;
      assert(list.online >= 2, `roomList.online counts pilots (${list.online})`);
      const live = list.rooms.find((r) => r.id === roomId);
      assert(live && live.phase === 'playing' && live.live && live.live.timeLeftSec > 0 && live.joinable,
        'the playing room is listed live and joinable');
      liveListSeen = true;
      b.send({ type: 'quickPlay', gameType: 'warzone' });
      assert(b.last('roomState')?.roomId === roomId, 'Quick Play picked the running Warzone match');
      b.send({ type: 'setShip', shipClass: 'engineer' });
    }
    // v0.3 #6 / SEC-2: a class change while alive happens in place — never a free full-energy protected respawn
    if (i === classSwapTick) {
      const v = a.ownView();
      const you = a.lastSnap?.you;
      preSwap = { alive: !!you?.alive, energyFrac: v ? v.energyFrac : 0, invuln: !!v && (v.flags & SHIPFLAG_INVULN) !== 0 };
      a.send({ type: 'setShip', shipClass: 'brute' });
    }
    if (i === classSwapTick + 6) {
      const v = a.ownView();
      postSwap = {
        alive: !!a.lastSnap?.you?.alive, energyFrac: v ? v.energyFrac : 0,
        invuln: !!v && (v.flags & SHIPFLAG_INVULN) !== 0, shipClass: v?.shipClass ?? '?',
      };
    }
    const t0 = performance.now();
    zone.tick();
    const dt = performance.now() - t0;
    if (i >= COUNTDOWN_SEC * TICK_RATE) { sum += dt; n++; if (dt > max) max = dt; }
  }

  assert(a.last('matchStart'), 'A got matchStart');
  assert(a.snaps > 1000, `A got snapshots (${a.snaps})`);
  assert(b && b.last('matchStart'), 'B got matchStart');
  assert(b!.snaps > 100, `B got snapshots (${b!.snaps})`);
  const scores = a.last('scores')?.scores ?? [];
  assert(scores.length >= 16, `scores for all players (${scores.length})`);
  const kills = scores.reduce((s, p) => s + p.kills, 0);
  const enemyKills = scores.reduce((s, p) => s + p.enemyKills, 0);
  const chat = a.msgs.filter((m) => m.type === 'chat').map((m) => (m as Extract<ServerMsg, { type: 'chat' }>).line.text);
  assert(liveListSeen, 'room list checked');
  assert(preSwap && postSwap, 'class swap sampled');
  let swapNote: string;
  if (preSwap.alive && postSwap.alive) {
    assert(postSwap.shipClass === 'brute', `a live ship swaps class in place (class ${postSwap.shipClass})`);
    assert(!postSwap.invuln || preSwap.invuln, 'an in-place class swap grants no spawn protection');
    assert(postSwap.energyFrac <= preSwap.energyFrac + 0.25,
      `an in-place class swap keeps the energy fraction (${preSwap.energyFrac.toFixed(2)} -> ${postSwap.energyFrac.toFixed(2)})`);
    swapNote = `in place (energy ${preSwap.energyFrac.toFixed(2)} -> ${postSwap.energyFrac.toFixed(2)})`;
  } else {
    assert(!preSwap.alive ? chat.some((t) => t.startsWith('Class change queued')) : true, 'a dead ship queues the class change');
    swapNote = preSwap.alive ? 'died right after the swap' : 'queued (ship was down)';
  }


  assert(lootMultSeen === 1, `two humans flying: lootMult 1 (got ${lootMultSeen})`);
  // A 60 s match is below the crate / shard time gates (§6.6), so only carried caches are granted. Make sure A
  // carries one (bots never pick up, and random flying may not have met a cache) so the full grant path runs.
  const world = roomOf().sim!.world;
  const shipA = world.ships.get(world.shipsByPlayer.get(a.pid) ?? 0);
  assert(shipA, 'A has a ship at the end');
  let planted = false;
  if (!shipA.alive || !(shipA.carried?.length)) {
    shipA.alive = true;
    carriedOf(shipA).push({ rarity: 1, set: 'swarm', source: 'elite' });
    planted = true;
  }
  const carriedAtEnd = shipA.carried!.length;

  // force results to exercise matchEnd + awards + the loot grant
  a.send({ type: 'chat', channel: 'all', text: '/end' });
  const result = a.last('matchEnd')?.result;
  assert(result, 'matchEnd after /end');
  const grant = a.last('lootGrant');
  assert(grant && grant.persisted, 'A (account) got a persisted lootGrant after matchEnd');
  assert(a.msgs.lastIndexOf(a.last('matchEnd')!) < a.msgs.lastIndexOf(grant), 'lootGrant arrives after matchEnd');
  assert(grant.grant.cachesSecured === carriedAtEnd, `A's carried caches were secured (${grant.grant.cachesSecured}/${carriedAtEnd})`);
  assert(grant.grant.items.length === carriedAtEnd, `one item per secured cache (${grant.grant.items.length})`);
  assert(store.hasGrant(accountA.accountId, grant.grant.grantKey), 'the grant is in the ledger');
  const stored = store.load(accountA.accountId) as { owned?: Record<string, unknown> } | null;
  assert(stored && grant.grant.items.every((it) => it.dupe || stored.owned?.[it.itemId]), 'the stored profile owns the new items');

  const fmtMap = (m: Map<string, number>): string => [...m].map(([k, v]) => `${k}:${v}`).join(' ') || 'none';
  console.log('--- Voidswarm smoke ---');
  console.log(`roster classes: ${fmtMap(classes)}   class swap: ${swapNote}   B via Quick Play (${b!.ownClass() ?? '?'})`);
  console.log(`ticks: ${n} playing  avg ${(sum / n).toFixed(3)} ms  max ${max.toFixed(2)} ms`);
  console.log(`snapshots A: ${a.snaps} (avg ${(a.bytes / a.snaps).toFixed(0)} B, max ${a.maxBytes} B)  B: ${b!.snaps} (avg ${(b!.bytes / Math.max(1, b!.snaps)).toFixed(0)} B)`);
  console.log(`max in view: enemies ${a.maxEnemies}, projectiles ${a.maxProjectiles}, deployables ${Math.max(a.maxDeployables, b!.maxDeployables)} (kinds seen: ${[...new Set([...a.deployKinds.keys(), ...b!.deployKinds.keys()])].join(', ') || 'none'})`);
  console.log(`heal seen: ${Math.round(a.healSeen + b!.healSeen)} (beams ${a.beams + b!.beams})   A attached as turret in ${a.attachedSnaps} snapshots (hosting ${a.hostingSnaps}, alive ${a.aliveSnaps}, energy>=60% ${a.energyOkSnaps})`);
  console.log(`kills: ${kills} pvp, ${enemyKills} swarm   events seen by A: ${a.events}`);
  console.log(`last snapshot: ships ${a.lastSnap?.ships.length} wave ${a.lastSnap?.match.wave} timeLeft ${a.lastSnap?.match.timeLeftSec.toFixed(0)} s`);
  console.log(`awards: ${result.awards.map((w) => `${w.title} (${w.value})`).join('; ') || 'none'}`);
  const lootSeen = (k: 'lootDrops' | 'lootPickups' | 'lootSpills'): number => Math.max(a[k], b![k], c[k]);
  console.log(`loot: lootMult ${lootMultSeen}  drops seen ${lootSeen('lootDrops')}  pickups ${lootSeen('lootPickups')}  spills ${lootSeen('lootSpills')}  max caches in view ${Math.max(a.maxLoot, b!.maxLoot, c.maxLoot)}  max carried ${Math.max(a.maxCarried, c.maxCarried)}`);
  console.log(`grant A: ${grant.grant.grantKey}  ${grant.grant.items.map((it) => `${it.itemId}${it.dupe ? ' (dupe)' : ''}`).join(', ') || 'no items'}  shards ${grant.grant.shards}  secured ${grant.grant.cachesSecured}${planted ? ' (planted 1)' : ''}  lost ${grant.grant.cachesLost}  persisted ${grant.persisted}`);
  console.log('SMOKE OK');
}

// ---------------------------------------------------------------------------------------------
// v0.3 M3: the objective AI-parity gate (§5.7 "Ready gate", §9 ROOM / AI acceptance)
// ---------------------------------------------------------------------------------------------

interface GateOpts {
  mode: ObjectiveSubMode;
  type: GameType;
  ffa: boolean;
  teams: number;
  /** Gate window in sim seconds of play. */
  sec: number;
  /** Match length (minutes). */
  minutes: number;
  /** Objective target (0 = the sub-mode default). */
  limit: number;
  seed: number;
  bots: number;
}

interface GateReport {
  label: string;
  pass: boolean;
  why: string;
}

/** mulberry32: the Room's own Math.random draws (map seed, bot seeds / names / classes) become reproducible. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STAT_FIELDS: readonly (keyof ObjectivePlayerStats)[] = ['caps', 'steals', 'returns', 'carrierKills', 'zoneCaps', 'neutralizes', 'objTicks', 'hotHoldTicks'];
const EVENT_KINDS: readonly ObjectiveEventKind[] = [
  'flagTaken', 'flagDropped', 'flagReturned', 'flagCaptured', 'zoneCaptured', 'zoneNeutralized', 'hotWarn', 'hotMoved', 'overtime', 'suddenDeath',
];

/** One gate run: 16 bots, one spectator (the host), `sec` sim-seconds of play (or until the match ends). */
function objectiveGate(o: GateOpts): GateReport {
  Math.random = seededRandom(o.seed); // Room-side randomness only: the sim never calls Math.random (determinism rule)
  const D = SUB_MODES[o.mode];
  const mode = o.ffa ? 'ffa' : 'teams';
  const label = `${GAME_TYPES[o.type].name} ${subModeLabel(o.type, o.mode)} (${o.ffa ? 'FFA' : `${o.teams} teams`}, ${o.bots} bots, seed ${o.seed})`;
  const gate: Partial<RoomSettings> = {
    name: 'Gate', gameType: o.type, subMode: o.mode, mode, teamCount: o.teams, maxPlayers: Math.max(o.bots, 2), botFill: o.bots,
    matchMinutes: o.minutes, objectiveLimit: o.limit, botSkill: 'normal',
  };
  // A not-ready sub-mode is opened for this one room only: every normal path (Create, Quick Play, house rooms) still
  // refuses it. Nothing on the match path re-checks `ready`, so the room keeps it for the whole run.
  const wasReady = D.ready;
  D.ready = true;
  let zone: Zone;
  try {
    zone = new Zone({ snapshotEvery: 3, local: false, motd: 'smoke gate', defaultRooms: [gate], profiles: new MemoryProfileStore() });
  } finally {
    D.ready = wasReady;
  }
  const obs = new SmokeClient('Observer');
  obs.conn = zone.connect(obs);
  obs.conn.setAccount(null);
  obs.send({ type: 'hello', name: 'Observer', protocol: PROTOCOL_VERSION, version: 'smoke' });
  const roomId = obs.last('roomList')!.rooms[0].id;
  const room = (zone as unknown as { rooms: Map<string, Room> }).rooms.get(roomId)!;
  assert(room.settings.subMode === o.mode && room.settings.mode === mode, `gate room plays ${o.mode}/${mode} (got ${room.settings.subMode}/${room.settings.mode})`);
  obs.send({ type: 'joinRoom', roomId });
  obs.send({ type: 'setTeam', team: TEAM_UNASSIGNED }); // spectate: 16 bots fly, the observer keeps the room alive
  obs.send({ type: 'startMatch' });

  const windowTicks = Math.round(o.sec * TICK_RATE);
  const maxTicks = COUNTDOWN_SEC * TICK_RATE + windowTicks + TICK_RATE;
  let played = 0, sum = 0, max = 0;
  let endedBy = '/end';
  for (let i = 0; i < maxTicks; i++) {
    const t0 = performance.now();
    zone.tick();
    const dt = performance.now() - t0;
    if (room.phase === 'playing' || obs.matchEnds) { played++; sum += dt; if (dt > max) max = dt; }
    if (obs.matchEnds) { endedBy = 'the sim (target / time-out)'; break; }
    if (played >= windowTicks) break;
  }
  assert(obs.last('matchStart'), 'the observer got matchStart');
  const world = room.sim?.world;
  assert(world, 'the gate match is running (or just ended)');
  const obj = world.objective;
  assert(obj, 'objectivesInit set world.objective');
  assert(obj.mode === o.mode, `world.objective.mode ${obj.mode} = ${o.mode}`);
  assert(obs.objSnaps > 0, 'snapshots carried match.objective');
  const teamPoints = obj.teamPoints.slice();
  const statTotals = new Map<keyof ObjectivePlayerStats, number>();
  for (const st of obj.stats.values()) for (const k of STAT_FIELDS) statTotals.set(k, (statTotals.get(k) ?? 0) + (st[k] ?? 0));
  if (!obs.last('matchEnd')) obs.send({ type: 'chat', channel: 'all', text: '/end' });
  const result: MatchResult | undefined = obs.last('matchEnd')?.result;
  assert(result, 'matchEnd');
  assert(result.objective && result.objective.mode === o.mode, 'result.objective is set');
  if (mode === 'teams') {
    assert(approxEqual(result.teamScores, teamPoints, 0), `result.teamScores = the objective points (${result.teamScores.join('/')} vs ${teamPoints.join('/')})`);
  }
  // PlayerScore.obj mirrors world.objective.stats
  for (const row of result.scores) {
    const st = obj.stats.get(row.playerId);
    for (const k of STAT_FIELDS) assert((row.obj?.[k] ?? 0) === (st?.[k] ?? 0), `PlayerScore.obj.${k} of #${row.playerId}`);
  }

  const ev = (k: ObjectiveEventKind): number => obs.objEvents.get(k) ?? 0;
  let pass: boolean, why: string;
  if (o.mode === 'ctf') {
    pass = ev('flagCaptured') >= 1;
    why = `flagCaptured ${ev('flagCaptured')} ≥ 1`;
  } else if (o.mode === 'zones') {
    pass = ev('zoneCaptured') >= 2;
    why = `zoneCaptured ${ev('zoneCaptured')} ≥ 2`;
  } else {
    pass = ev('zoneCaptured') >= 1 && ev('hotMoved') >= 2;
    why = `hot captures ${ev('zoneCaptured')} ≥ 1 (view owner changes ${obs.hotOwnerChanges}) and hotMoved ${ev('hotMoved')} ≥ 2`;
    if (!ev('zoneCaptured') && obs.hotOwnerChanges) why += ' — the view shows captures but no zoneCaptured events were emitted';
  }
  const kills = result.scores.reduce((a, s) => a + s.kills, 0);
  const swarm = result.scores.reduce((a, s) => a + s.enemyKills, 0);
  const roster = obs.last('roomState')?.players ?? [];
  const nameOf = (pid: number): string => roster.find((p) => p.playerId === pid)?.name ?? `#${pid}`;
  const system = obs.msgs.filter((m): m is Extract<ServerMsg, { type: 'chat' }> => m.type === 'chat' && m.line.channel === 'system').map((m) => m.line.text);
  const objLines = system.filter((t) => /flag|Zone|Core|Hot Point|Overtime|Sudden death/.test(t));
  const pts = mode === 'teams'
    ? teamPoints.map((v, t) => `${teamName(t)} ${Math.round(v)}`).join(' · ')
    : (result.objective.playerPoints ?? []).slice(0, 5).map(([pid, v]) => `${nameOf(pid)} ${Math.round(v)}`).join(' · ') || 'none';

  console.log(`--- Voidswarm objective gate: ${label} ---`);
  if (!wasReady) console.log(`(${o.mode} is not \`ready\` yet: opened for the gate room only)`);
  console.log(`ticks: ${played} playing (${(played / TICK_RATE).toFixed(0)} sim-s, ended by ${endedBy})  avg ${(sum / Math.max(1, played)).toFixed(3)} ms  max ${max.toFixed(2)} ms`);
  console.log(`spectator snapshots: ${obs.snaps} (avg ${(obs.bytes / Math.max(1, obs.snaps)).toFixed(0)} B, max ${obs.maxBytes} B)  objective view max ${obs.maxObjBytes} B  carrier ship views ${obs.carrierViews}`);
  console.log(`events: ${EVENT_KINDS.map((k) => `${k} ${ev(k)}`).join(', ')}`);
  console.log(`points: ${pts}   target ${obj.limit}${obj.overtime ? '   overtime' : ''}${obj.suddenDeath ? '   sudden death' : ''}${obj.extensions ? `   extensions ${obj.extensions}` : ''}`);
  console.log(`player stats: ${STAT_FIELDS.map((k) => `${k} ${statTotals.get(k) ?? 0}`).join(', ')}`);
  console.log(`kills: ${kills} pvp${o.type === 'warzone' ? `, ${swarm} swarm` : ''}`);
  console.log(`result: ${result.objective.summary}   winner ${result.winnerTeam >= 0 ? teamName(result.winnerTeam) : result.winnerPlayerId ? nameOf(result.winnerPlayerId) : 'draw'}`);
  console.log(`awards: ${result.awards.map((w) => `${w.title} (${w.value})`).join('; ') || 'none'}`);
  console.log(`objective chat lines: ${objLines.length}${objLines.length ? ` — last: "${objLines.slice(-3).join('" / "')}"` : ''}`);
  console.log(`GATE ${o.mode}: ${why} → ${pass ? 'PASS' : 'FAIL'}`);
  zone.stop();
  return { label, pass, why };
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function gateOptsFrom(argv: readonly string[], mode: ObjectiveSubMode): GateOpts {
  const num = (name: string, dflt: number): number => {
    const v = argValue(argv, name);
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name} expects a number (got "${v}")`);
    return n;
  };
  const rawType = argValue(argv, '--type');
  const type: GameType = rawType === 'warzone' ? 'warzone' : rawType === undefined || rawType === 'arena' ? 'arena' : (() => { throw new Error(`--type arena|warzone (got "${rawType}")`); })();
  const seedArg = argValue(argv, '--seed');
  const seed = seedArg === 'random' ? (Date.now() ^ (process.pid << 8)) >>> 0 : num('--seed', 1234) >>> 0;
  const o: GateOpts = {
    mode, type, ffa: argv.includes('--ffa'), teams: Math.round(num('--teams', 2)), sec: num('--sec', 300),
    minutes: Math.round(num('--minutes', 10)), limit: Math.round(num('--limit', 0)), seed, bots: Math.round(num('--bots', 16)),
  };
  const T = GAME_TYPES[o.type];
  if (!T.subModes.includes(o.mode)) throw new Error(`${T.name} has no ${o.mode}`);
  if (!isLegalCombo(o.type, o.mode, o.ffa ? 'ffa' : 'teams', o.teams)) {
    throw new Error(`illegal combo: ${o.type} ${o.mode} ${o.ffa ? 'FFA' : `${o.teams} teams`}`);
  }
  if (!(o.minutes >= T.minutesMin && o.minutes <= T.minutesMax)) throw new Error(`--minutes ${T.minutesMin}-${T.minutesMax} for ${T.name}`);
  if (!(o.sec > 0) || !(o.bots >= 2 && o.bots <= 32)) throw new Error('--sec > 0, --bots 2-32');
  return o;
}

/** `--mode ctf|zones|hotpoint` runs one gate; `--mode all` runs Arena CTF, Arena Zones, Arena Hot Point and Warzone Zones. */
function gateMain(argv: readonly string[]): boolean {
  const m = argValue(argv, '--mode');
  const runs: GateOpts[] = [];
  if (m === 'all') {
    const base = argv.filter((a, i) => a !== '--type' && argv[i - 1] !== '--type' && a !== '--ffa');
    runs.push(gateOptsFrom(base, 'ctf'), gateOptsFrom(base, 'zones'), gateOptsFrom(base, 'hotpoint'),
      gateOptsFrom([...base, '--type', 'warzone'], 'zones'));
  } else if (m === 'ctf' || m === 'zones' || m === 'hotpoint') {
    runs.push(gateOptsFrom(argv, m));
  } else {
    throw new Error(`--mode ctf|zones|hotpoint|all (got "${m}")`);
  }
  const reports = runs.map((o) => objectiveGate(o));
  if (reports.length > 1) {
    console.log('--- gate summary ---');
    for (const r of reports) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}: ${r.why}`);
  }
  return reports.every((r) => r.pass);
}

// ---------------------------------------------------------------------------------------------
// v0.3 M4: `--rift` — a Dungeon Runner run on the Room path (§9 ROOM smoke: "--rift 180 s logs the floor reached")
// ---------------------------------------------------------------------------------------------

interface RiftOpts { sec: number; floors: number; seed: number; bots: number; pve: PveIntensity; dropIn: boolean }

/**
 * `--rift`: `bots` (4) normal bots dive a `floors`-floor rift for `sec` (180) sim-seconds, watched by one spectator
 * through the real Zone → Room → SnapshotBuilder → codec path; a second client asks to drop in (pending until the next
 * floor start, then added in place of a bot and leaves again so the bots keep the lead). Checks: matchStart names the
 * floor, every floorStart arrives before that floor's first snapshot (SmokeClient), the rift tail round-trips, the
 * live block, and /end abandons the run with a RiftResult. Logs the floor reached; it is not a progress gate (that is
 * bots.test "4 normal bots clear floor 1 of seed 1234 within 6 sim-minutes"). A not-ready coop is opened for this one
 * room only.
 */
function riftSmoke(o: RiftOpts): void {
  Math.random = seededRandom(o.seed); // Room-side randomness only (map seed, bot seeds / names / classes)
  const D = SUB_MODES.coop;
  const wasReady = D.ready;
  D.ready = true;
  let zone: Zone;
  try {
    zone = new Zone({
      snapshotEvery: 3, local: false, motd: 'smoke rift', profiles: new MemoryProfileStore(),
      defaultRooms: [{
        name: 'Rift Smoke', gameType: 'dungeon', subMode: 'coop', floors: o.floors, botFill: o.bots, pveIntensity: o.pve, botSkill: 'normal',
      }],
    });
  } finally {
    D.ready = wasReady;
  }
  const connect = (name: string): SmokeClient => {
    const c = new SmokeClient(name);
    c.conn = zone.connect(c);
    c.conn.setAccount(null);
    c.send({ type: 'hello', name, protocol: PROTOCOL_VERSION, version: 'smoke' });
    return c;
  };
  const obs = connect('Observer');
  const roomId = obs.last('roomList')!.rooms[0].id;
  const room = (zone as unknown as { rooms: Map<string, Room> }).rooms.get(roomId)!;
  assert(room.settings.gameType === 'dungeon' && room.settings.subMode === 'coop', 'the smoke room is a Dungeon Run');
  obs.send({ type: 'joinRoom', roomId });
  obs.send({ type: 'setTeam', team: TEAM_UNASSIGNED }); // spectate: the bots dive, the observer keeps the room alive
  obs.send({ type: 'startMatch' });

  const windowTicks = Math.round(o.sec * TICK_RATE);
  const maxTicks = COUNTDOWN_SEC * TICK_RATE + windowTicks + TICK_RATE;
  let played = 0, sum = 0, max = 0;
  let diver: SmokeClient | null = null;
  let diverAdded: { floor: number; shipId: number } | null = null;
  let pendingChecked = false;
  let liveSeen = '';
  for (let i = 0; i < maxTicks; i++) {
    const t0 = performance.now();
    zone.tick();
    const dt = performance.now() - t0;
    if (room.phase === 'playing' || obs.matchEnds) { played++; sum += dt; if (dt > max) max = dt; }
    if (obs.matchEnds) break;
    if (played === 1) {
      const w = room.sim?.world;
      assert(w && w.config.gameType === 'dungeon', 'the rift Sim runs gameType dungeon');
      assert(w.dungeon, 'world.dungeon is set at match start (SIM M4: createRiftState in the Sim constructor) — the rift layer cannot run without it');
      assert(w.map.dungeon, 'the match map is a rift floor (SIM M4: buildMatchMap → generateFloor)');
    }
    if (played === 10 * TICK_RATE && o.dropIn) {
      // A pilot asks to join the running rift: it watches until the next floor start adds it.
      diver = connect('Diver');
      diver.send({ type: 'joinRoom', roomId, intent: 'play' });
      const ms = diver.last('matchStart');
      assert(ms && ms.yourShipId === 0 && ms.gameType === 'dungeon', 'a rift drop-in watches first (matchStart without a ship)');
      const w = room.sim!.world;
      assert(!w.shipsByPlayer.has(diver.pid), 'the drop-in gets no ship mid-floor');
      pendingChecked = true;
    }
    if (diver && !diverAdded) {
      const ms = diver.last('matchStart');
      if (ms && ms.yourShipId) {
        diverAdded = { floor: ms.floor, shipId: ms.yourShipId };
        const fs = diver.floorStarts[diver.floorStarts.length - 1];
        assert(fs && fs.floor === ms.floor, `the drop-in got floorStart ${fs?.floor} before its matchStart (floor ${ms.floor})`);
        diver.send({ type: 'leaveRoom' }); // hand the lead back to the bots
      }
    }
    if (played === 30 * TICK_RATE) {
      const L = room.summary().live;
      assert(L && L.floorsTotal === o.floors && L.floor >= 1 && L.timeLeftSec === -1 && L.lives >= 0, 'RoomSummary.live carries floor / floors / lives, untimed');
      liveSeen = L.scoreline;
    }
    if (played >= windowTicks) break;
  }
  const ms = obs.last('matchStart');
  assert(ms && ms.gameType === 'dungeon' && ms.subMode === 'coop' && ms.floor >= 1, `matchStart names the rift floor (got ${ms?.floor})`);
  const world = room.sim?.world;
  assert(world, 'the rift is running (or just ended)');
  const d = world.dungeon;
  assert(d, 'world.dungeon is set (SIM M4 createRiftState)');
  assert(obs.riftSnaps > 0, 'snapshots carried match.dungeon');
  const floorAtEnd = d.floor;
  const lives = d.parties.reduce((a, p) => a + Math.max(0, p.lives), 0);
  const cleared = d.parties.reduce((a, p) => a + p.roomsCleared, 0);
  const endedBy = obs.matchEnds ? `the sim (${d.outcome})` : '/end (abandon)';
  if (!obs.last('matchEnd')) obs.send({ type: 'chat', channel: 'all', text: '/end' });
  const result = obs.last('matchEnd')?.result;
  assert(result && result.gameType === 'dungeon', 'matchEnd');
  assert(result.rift, 'result.rift is set');
  assert(obs.matchEnds || result.rift.outcome === 'abandoned', `/end abandons the run (got ${result.rift.outcome})`);
  assert(result.rift.floorReached >= floorAtEnd, `floorReached ${result.rift.floorReached} ≥ ${floorAtEnd}`);
  assert(result.rift.players.length >= world.ships.size, 'every pilot has a rift status');
  const system = obs.msgs.filter((m): m is Extract<ServerMsg, { type: 'chat' }> => m.type === 'chat' && m.line.channel === 'system').map((m) => m.line.text);
  const riftLines = system.filter((t) => /^Floor \d|Matriarch|extracted|unstable|RIFT CONQUERED|Party wiped|Run abandoned|Everyone extracted|joined the party/.test(t));
  const ev = (k: string): number => obs.riftEvents.get(k) ?? 0;
  const rooms = obs.lastRift ? obs.lastRift.rooms : [];
  const byState = [0, 1, 2, 3].map((s) => rooms.filter((r) => r === s).length);

  console.log(`--- Voidswarm rift smoke: ${o.floors} floors, ${o.bots} bots, difficulty ${o.pve}, seed ${o.seed} ---`);
  if (!wasReady) console.log('(coop is not `ready` yet: opened for the smoke room only)');
  console.log(`ticks: ${played} playing (${(played / TICK_RATE).toFixed(0)} sim-s, ended by ${endedBy})  avg ${(sum / Math.max(1, played)).toFixed(3)} ms  max ${max.toFixed(2)} ms`);
  console.log(`spectator snapshots: ${obs.snaps} (avg ${(obs.bytes / Math.max(1, obs.snaps)).toFixed(0)} B, max ${obs.maxBytes} B)  rift view max ${obs.maxRiftBytes} B`);
  console.log(`floor reached: ${result.rift.floorReached}/${o.floors}  (floorStart messages: ${obs.floorStarts.map((f) => f.floor).join(', ') || 'none'})`);
  console.log(`rooms on the last floor seen: ${rooms.length} (dormant ${byState[0]}, arming ${byState[1]}, sealed ${byState[2]}, cleared ${byState[3]})  rooms cleared in all: ${cleared}  lives left: ${lives}`);
  console.log(`events: ${[...RIFT_EVENT_TYPES].map((k) => `${k} ${ev(k)}`).join(', ')}`);
  console.log(`live: "${liveSeen}"   drop-in: ${!o.dropIn ? 'off' : diverAdded ? `added on floor ${diverAdded.floor} (ship ${diverAdded.shipId})` : pendingChecked ? 'pending (no floor start in the window)' : 'not tried'}`);
  console.log(`result: ${result.rift.outcome}, floor ${result.rift.floorReached}, ${result.rift.roomsCleared} rooms, ${result.rift.bossesKilled} bosses, ${result.rift.timeSec} s; statuses ${result.rift.players.map((p) => p.status).join(' ')}`);
  console.log(`awards: ${result.awards.map((w) => `${w.title} (${w.value})`).join('; ') || 'none'}`);
  console.log(`rift chat lines: ${riftLines.length}${riftLines.length ? ` — "${riftLines.slice(-4).join('" / "')}"` : ''}`);
  console.log(`RIFT: floor ${result.rift.floorReached} reached in ${(played / TICK_RATE).toFixed(0)} sim-s`);
  zone.stop();
}

function riftOptsFrom(argv: readonly string[]): RiftOpts {
  const num = (name: string, dflt: number): number => {
    const v = argValue(argv, name);
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name} expects a number (got "${v}")`);
    return n;
  };
  // `--rift 180` (seconds right after the flag) or `--rift --sec 180`
  const after = argValue(argv, '--rift');
  const sec = after !== undefined && /^\d+(\.\d+)?$/.test(after) ? Number(after) : num('--sec', 180);
  const seedArg = argValue(argv, '--seed');
  const o: RiftOpts = {
    sec, floors: Math.round(num('--floors', 6)), seed: seedArg === 'random' ? (Date.now() ^ (process.pid << 8)) >>> 0 : num('--seed', 1234) >>> 0,
    bots: Math.round(num('--bots', 4)), pve: Math.round(num('--pve', 2)) as PveIntensity, dropIn: !argv.includes('--no-dropin'),
  };
  if (!(o.sec > 0)) throw new Error('--sec > 0');
  if (o.floors !== 3 && o.floors !== 6) throw new Error('--floors 3|6');
  if (!(o.bots >= 1 && o.bots <= 4)) throw new Error('--bots 1-4');
  if (!(o.pve >= 1 && o.pve <= 3)) throw new Error('--pve 1-3');
  return o;
}

/** For harnesses (a vitest run imports this file without running main): the rift run and its option parser. */
export { riftOptsFrom, riftSmoke };

function main(): void {
  try {
    const argv = process.argv.slice(2);
    if (argv.includes('--rift')) {
      riftSmoke(riftOptsFrom(argv));
      console.log('SMOKE RIFT OK');
      process.exit(0);
    }
    if (argv.includes('--mode')) {
      const ok = gateMain(argv);
      console.log(ok ? 'SMOKE GATE OK' : 'SMOKE GATE FAILED');
      process.exit(ok ? 0 : 1);
    }
    classicMain();
    process.exit(0);
  } catch (e) {
    console.error('SMOKE FAILED:', (e as Error)?.stack ?? e);
    process.exit(1);
  }
}

if (!process.env.VITEST) main();
