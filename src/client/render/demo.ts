// Render dev harness (RENDER agent) — served at /render-demo.html. Fake world, every effect on a timer.
// Controls: WASD move, mouse aim, LMB primary, RMB secondary, Space mobility, E utility (skills of your class),
// V = cycle your class, P = cycle your path, O = line the showcase up, Shift afterburner, M big map,
// v0.3: L = cycle loadouts (starter / Salvage / Rift / Gladiator / Swarm / mixed), K = next death preset at the
// cursor, C = spawn one cache of each rarity at the cursor, J = spill your carried caches, B = 32-ship bench.
// v0.3 M3: G = cycle objective modes (off / CTF / Zones / Zones Warzone / Hot Point / Hot Point FFA, see
// demoObjectives.ts), H = drop the flag you carry, N = overtime / sudden-death telegraph.
// v0.3 M4: R = cycle rift floors (off / F1 hive / F3 hive boss / F4 prism / F6 prism final, see demoRift.ts; each goes
// through renderer.setMap like a floorStart), T = descend now, Y = boss telegraph, U = spawn cracks at the cursor,
// I = instability pulse.
// v0.5: capital ships (demoCapital.ts): a Dreadnought, a Spire and a Foundry cycle 0 → 5 turrets (hardpoint re-flow,
// the transform and back) with every turret fire preset; Z = park the capital row beside you, X = fire every capital
// skill (Broadside / Overcharge / Repair Bay), 0 = capital bench (32 ships: 8 capitals × 3 domes vs 32 free ships).
// Click once to unlock audio.
import { GameRenderer } from './GameRenderer';
import { AudioFx } from '../audio/AudioFx';
import { ObjectiveDemo, type DemoWorld } from './demoObjectives';
import { RiftDemo, type RiftDemoWorld } from './demoRift';
import { CapitalDemo, type CapitalDemoWorld } from './demoCapital';
import type { RenderFrame } from '../contracts';
import type { PlayerInfo } from '../../shared/protocol';
import {
  LOOT_SETS, type CarryView, type CosmeticLoadout, type LootSet, type LootView, type Rarity,
} from '../../shared/types';
import { COSMETIC_LIST, COSMETICS } from '../../shared/data/cosmetics';
import { LOOT_PICKUP_PAD, MAX_CARRIED } from '../../shared/constants';
import {
  BEAM_LASER, BEAM_NONE, BEAM_WELD, SHIPFLAG_AFTERBURNER, SHIPFLAG_CHARGING, SHIPFLAG_INVULN, SHIPFLAG_SHIELD,
  SHIPFLAG_THRUSTING, TILE_BASE, TILE_EMPTY, TILE_ROCK, TILE_WALL,
  type DeployableKind, type DeployableView, type EnemyKind, type EnemyView, type GameEvent, type GameMap, type GemView,
  type ProjectileKind, type ProjectileView, type ShipClassId, type ShipView, type SkillId,
} from '../../shared/types';
import { ENEMY_TEAM, MAP_SIZE, MAP_TILE, TICK_RATE } from '../../shared/constants';
import { SHIP_CLASSES } from '../../shared/data/ships';
import { capitalScale, turretOffset } from '../../shared/sim/world';

// ---------- fake map
function fakeMap(): GameMap {
  const ts = MAP_TILE, cols = MAP_SIZE / ts, rows = MAP_SIZE / ts;
  const tiles = new Uint8Array(cols * rows);
  let seed = 1234;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const set = (c: number, r: number, v: number) => { if (c >= 0 && r >= 0 && c < cols && r < rows) tiles[r * cols + c] = v; };
  for (let c = 0; c < cols; c++) for (let k = 0; k < 2; k++) { set(c, k, TILE_WALL); set(c, rows - 1 - k, TILE_WALL); set(k, c, TILE_WALL); set(cols - 1 - k, c, TILE_WALL); }
  for (let i = 0; i < 70; i++) {
    const w = 2 + Math.floor(rnd() * 8), h = 2 + Math.floor(rnd() * 8);
    const c0 = 6 + Math.floor(rnd() * (cols - 20)), r0 = 6 + Math.floor(rnd() * (rows - 20));
    if (Math.abs(c0 - cols / 2) < 16 && Math.abs(r0 - rows / 2) < 16) continue;
    const kind = rnd() < 0.3 ? TILE_ROCK : TILE_WALL;
    for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) set(c, r, kind);
  }
  for (let c = 84; c < 96; c++) set(c, 84, TILE_WALL);
  for (let r = 84; r < 92; r++) set(84, r, TILE_WALL);
  for (let c = 112; c < 116; c++) for (let r = 108; r < 116; r++) set(c, r, TILE_ROCK);
  const spawns = [
    { team: 0, x: 12 * ts, y: 12 * ts }, { team: 1, x: (cols - 12) * ts, y: 12 * ts },
    { team: 2, x: 12 * ts, y: (rows - 12) * ts }, { team: 3, x: (cols - 12) * ts, y: (rows - 12) * ts },
  ];
  for (const s of spawns) {
    const cc = Math.floor(s.x / ts), rr = Math.floor(s.y / ts);
    for (let r = rr - 4; r <= rr + 4; r++) for (let c = cc - 4; c <= cc + 4; c++) if (tiles[r * cols + c] === TILE_EMPTY) set(c, r, TILE_BASE);
  }
  return { seed: 1, teamCount: 4, width: MAP_SIZE, height: MAP_SIZE, tileSize: ts, cols, rows, tiles, spawns };
}

// ---------- fake world
const CX = 3200, CY = 3200;
const CLASSES: ShipClassId[] = ['brute', 'tech', 'engineer'];
const PRIMARY: Record<ShipClassId, { kind: ProjectileKind; skill: SkillId; speed: number; cd: number }> = {
  brute: { kind: 'bullet', skill: 'autocannon', speed: 850, cd: 0.18 },
  tech: { kind: 'plasma', skill: 'plasma', speed: 1000, cd: 0.15 },
  engineer: { kind: 'bullet', skill: 'rivet', speed: 1100, cd: 0.09 },
};
const ships: ShipView[] = [];
const shipMap = new Map<number, ShipView>();
let players = new Map<number, PlayerInfo>();
const names = ['Nova', 'Vex', 'Kestrel', 'Ion', 'Halcyon', 'Rook', 'Juno', 'Blitz', 'Sable', 'Onyx', 'Tern', 'Mako'];
function addShip(id: number, cls: ShipClassId, team: number, x: number, y: number, pathIdx = -1): ShipView {
  const s: ShipView = {
    id, playerId: id, team, shipClass: cls, x, y, vx: 0, vy: 0, angle: 0, energyFrac: 1, alive: true,
    attachedTo: 0, turretSlot: -1, turretCount: 0, flags: 0, level: 1 + (id % 12), orbitals: 0,
    pathIdx, beamLen: 0, beamKind: BEAM_NONE, resonance: 1,
  };
  ships.push(s); shipMap.set(id, s);
  players.set(id, { playerId: id, name: names[id % names.length], team, shipClass: cls, isBot: id !== 1, isHost: id === 1, ready: true, ping: 0, inMatch: true });
  return s;
}
function attach(t: ShipView, host: ShipView, slot: number, count: number): void {
  t.attachedTo = host.id; t.turretSlot = slot; t.turretCount = count; host.turretCount = count;
}

const me = addShip(1, 'brute', 0, CX, CY, 0);
// showcase: 3 classes × 3 paths orbiting the center
const showcase: ShipView[] = [];
for (let c = 0; c < 3; c++) for (let p = 0; p < 3; p++) {
  const s = addShip(2 + c * 3 + p, CLASSES[c], (c + p) % 4, CX, CY, p);
  showcase.push(s);
}
showcase[4].orbitals = 3;
// Bulwark host with 4 tech laser turrets (resonance demo)
const bulwark = addShip(20, 'brute', 1, CX + 380, CY - 250, 2);
const lasers: ShipView[] = [];
for (let k = 0; k < 4; k++) { const t = addShip(21 + k, 'tech', 1, bulwark.x, bulwark.y, k % 3); attach(t, bulwark, k, 4); lasers.push(t); }
// Architect host with a welding engineer turret + a flak brute turret
const architect = addShip(30, 'engineer', 2, CX - 420, CY + 260, 2);
const welder = addShip(31, 'engineer', 2, architect.x, architect.y, 1);
const flak = addShip(32, 'brute', 2, architect.x, architect.y, -1);
attach(welder, architect, 0, 2); attach(flak, architect, 1, 2);
const medic = showcase[7]; // engineer / Medic
const summoner = showcase[6]; // engineer / Summoner
const allyInvuln = addShip(40, 'tech', 0, CX - 150, CY + 140, -1);
allyInvuln.flags = SHIPFLAG_INVULN;
// v0.5 capital showcase (its turrets are placed / fired by demoCapital.ts)
const capWorld: CapitalDemoWorld = {
  me, ships, byId: shipMap, events: [] as GameEvent[], cx: CX, cy: CY,
  addShip: (id, cls, team, x, y, pathIdx) => addShip(id, cls, team, x, y, pathIdx),
  shoot: (s, kind, ang, speed, life, level) => shoot(s, kind, ang, speed, life, level),
  nearestEnemy: (x, y, max) => nearestEnemy(x, y, max),
};
const capDemo = new CapitalDemo(capWorld);

const kinds: EnemyKind[] = ['drone', 'dart', 'weaver', 'splitter', 'splitling', 'spinner', 'brute', 'blackhole', 'hive'];
const radius: Record<EnemyKind, number> = {
  drone: 14, dart: 13, weaver: 15, splitter: 18, splitling: 9, spinner: 16, brute: 30, blackhole: 26, hive: 80,
  matriarch: 88, // v0.3 M4 (proposal §4.5: radius 88)
};
interface FakeEnemy extends EnemyView { vx: number; vy: number; ph: number }
const enemies: FakeEnemy[] = [];
let nextId = 1000;
function spawnEnemy(kind: EnemyKind): FakeEnemy {
  const a = Math.random() * Math.PI * 2, d = 450 + Math.random() * 700;
  const e: FakeEnemy = {
    id: nextId++, kind, x: CX + Math.cos(a) * d, y: CY + Math.sin(a) * d, angle: 0, hpFrac: 1, radius: radius[kind],
    elite: Math.random() < 0.1, vx: 0, vy: 0, ph: Math.random() * 10,
  };
  enemies.push(e);
  return e;
}
for (let i = 0; i < 110; i++) spawnEnemy(kinds[i % 7]);
spawnEnemy('blackhole'); spawnEnemy('hive');

const gems: GemView[] = [];
interface FakeProj extends ProjectileView { life: number }
const projs: FakeProj[] = [];
function shoot(s: { x: number; y: number; vx?: number; vy?: number; team: number; id: number }, kind: ProjectileKind, ang: number, speed: number, life: number, level = 1): void {
  projs.push({ id: nextId++, kind, x: s.x + Math.cos(ang) * 20, y: s.y + Math.sin(ang) * 20, vx: Math.cos(ang) * speed + (s.vx ?? 0) * 0.3, vy: Math.sin(ang) * speed + (s.vy ?? 0) * 0.3,
    team: s.team, ownerId: s.id, level, life });
}

// deployables
interface FakeDeploy extends DeployableView { life: number; max: number; hp: number; follow?: ShipView; ph: number }
const deploys: FakeDeploy[] = [];
function addDeploy(kind: DeployableKind, owner: ShipView, x: number, y: number, o: Partial<FakeDeploy> = {}): FakeDeploy {
  const d: FakeDeploy = {
    id: nextId++, kind, ownerId: owner.id, team: owner.team, x, y, angle: 0, hpFrac: 1, radius: 14, length: 0, lifeFrac: 1,
    life: 12, max: 12, hp: 1, ph: Math.random() * 10, ...o,
  };
  deploys.push(d);
  return d;
}
function seedDeploys(): void {
  const eng = showcase[8];
  addDeploy('sentry', eng, CX + 150, CY + 380, { radius: 14, life: 9, max: 9 });
  addDeploy('sentry', summoner, CX - 250, CY - 330, { radius: 14, life: 14, max: 14 });
  addDeploy('wall', architect, CX - 120, CY + 470, { radius: 8, length: 260, angle: 0.3, life: 10, max: 10 });
  addDeploy('well', showcase[4], CX + 520, CY + 180, { radius: 280, life: 4, max: 4 });
  addDeploy('drone', summoner, 0, 0, { radius: 8, follow: summoner, ph: 0 });
  addDeploy('drone', summoner, 0, 0, { radius: 8, follow: summoner, ph: Math.PI });
  for (let i = 0; i < 3; i++) addDeploy('fire', showcase[1], CX - 520 + i * 70, CY - 60 + i * 30, { radius: 60, life: 3 + i, max: 5 });
  addDeploy('nanite', medic, CX + 60, CY - 480, { radius: 180, life: 6, max: 6 });
}
seedDeploys();

// ---------- input
const keys = new Set<string>();
let mouseX = 0, mouseY = 0, lmb = false, rmb = false;
const renderer = new GameRenderer();
const audio = new AudioFx();
const events: GameEvent[] = [];
let bigMap = false;
let chargeT = 0, hideT = 0, cdSec = 0, cdMob = 0, cdUtil = 0;
const demoState = { lineup: false, /** dev: camera follows this ship id instead of you (0 = you) */ focusId: 0 };
// v0.3 M3 objective views
const baseMap = fakeMap();
const objDemo = new ObjectiveDemo();
const objWorld: DemoWorld = { cx: CX, cy: CY, me, ships, byId: shipMap, events };
function setObjMode(m: number): void {
  if (riftDemo.active) riftDemo.setMode(0, baseMap, riftWorld);
  renderer.setMap(objDemo.setMode(m, baseMap, objWorld));
}
// v0.3 M4 rift floors
const riftDemo = new RiftDemo();
const riftWorld: RiftDemoWorld = { me, ships, byId: shipMap, events, enemies, spawn: (k) => spawnEnemy(k) };
function setRiftMode(m: number): void {
  if (objDemo.mode !== 0) objDemo.setMode(0, baseMap, objWorld);
  renderer.setMap(riftDemo.setMode(m, baseMap, riftWorld));
}

async function main(): Promise<void> {
  const host = document.getElementById('game')!;
  await renderer.init(host);
  (window as unknown as { __renderer: GameRenderer }).__renderer = renderer;
  (window as unknown as { __demo: unknown }).__demo = {
    me, bulwark, architect, showcase, deploys, demoState, loot, bench, startBench,
    setLookMode: (m: number) => { lookMode = ((m % LOOK_MODES.length) + LOOK_MODES.length) % LOOK_MODES.length; applyLooks(); },
    playDeathPreset, spawnCaches, spillMine, audio, objDemo, setObjMode, enemies, projs, advance,
    riftDemo, setRiftMode, capDemo, capWorld, startCapBench,
  };
  renderer.setMap(baseMap);
  applyLooks();
  spawnCaches(CX + 260, CY + 170, 600);
  const cv = host.querySelector('canvas')!;
  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    keys.add(k);
    audio.unlock();
    const w = renderer.screenToWorld(mouseX, mouseY);
    if (k === 'o') demoState.lineup = !demoState.lineup;
    if (k === 'm') { bigMap = !bigMap; renderer.setBigMap(bigMap); }
    if (k === 'k') playDeathPreset(w.x, w.y);
    if (k === 'l') { lookMode = (lookMode + 1) % LOOK_MODES.length; applyLooks(); audio.ui('equip'); }
    if (k === 'c') spawnCaches(w.x, w.y);
    if (k === 'j') spillMine();
    if (k === 'b' && !e.repeat) startBench();
    if (k === 'g' && !e.repeat) setObjMode(objDemo.mode + 1);
    if (k === 'h' && !e.repeat) objDemo.dropCarried(objWorld);
    if (k === 'n' && !e.repeat) objDemo.fireTelegraph(objWorld);
    if (k === 'r' && !e.repeat) setRiftMode(riftDemo.mode + 1);
    if (k === 't' && !e.repeat) { const m = riftDemo.descend(riftWorld); if (m) renderer.setMap(m); }
    if (k === 'y' && !e.repeat) riftDemo.fireTelegraph(riftWorld, w.x, w.y);
    if (k === 'u' && !e.repeat) riftDemo.spawnWarnAt(riftWorld, w.x, w.y);
    if (k === 'i' && !e.repeat) riftDemo.instability(riftWorld);
    if (k === 'z' && !e.repeat) capDemo.near = !capDemo.near;
    if (k === 'x' && !e.repeat) capDemo.fireSkills(capWorld);
    if (k === '0' && !e.repeat) startCapBench();
    if (k === 'v') { me.shipClass = CLASSES[(CLASSES.indexOf(me.shipClass) + 1) % 3]; applyLooks(); events.push({ t: 'shipSpawn', shipId: me.id, playerId: 1, x: me.x, y: me.y }); }
    if (k === 'p') { me.pathIdx = me.pathIdx >= 2 ? -1 : me.pathIdx + 1; if (me.pathIdx >= 0) events.push({ t: 'upgrade', playerId: 1, upgradeId: 'path:' + SHIP_CLASSES[me.shipClass].paths[me.pathIdx].id, level: 1 }); }
    if (k === ' ' && !e.repeat) useMobility(w.x, w.y);
    if (k === 'e' && !e.repeat) useUtility(w.x, w.y);
    if (k === ' ') e.preventDefault();
  });
  addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  cv.addEventListener('mousemove', (e) => { const r = cv.getBoundingClientRect(); mouseX = e.clientX - r.left; mouseY = e.clientY - r.top; });
  cv.addEventListener('mousedown', (e) => { audio.unlock(); if (e.button === 0) lmb = true; if (e.button === 2) rmb = true; });
  addEventListener('mouseup', (e) => { if (e.button === 0) lmb = false; if (e.button === 2) rmb = false; });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  mouseX = host.clientWidth / 2 + 200; mouseY = host.clientHeight / 2;
  requestAnimationFrame(loop);
}

function useMobility(ax: number, ay: number): void {
  if (cdMob > 0) return;
  cdMob = 0.8;
  if (me.shipClass === 'brute') {
    chargeT = 0.35;
    const a = me.angle; me.vx = Math.cos(a) * 1500; me.vy = Math.sin(a) * 1500;
    events.push({ t: 'ability', shipId: me.id, skill: 'ram', x: me.x, y: me.y });
  } else if (me.shipClass === 'tech') {
    const dx = ax - me.x, dy = ay - me.y, d = Math.hypot(dx, dy) || 1, L = Math.min(480, d);
    const fx = me.x, fy = me.y;
    me.x += (dx / d) * L; me.y += (dy / d) * L;
    events.push({ t: 'ability', shipId: me.id, skill: 'blink', x: fx, y: fy });
    events.push({ t: 'blink', shipId: me.id, fromX: fx, fromY: fy, x: me.x, y: me.y });
    if (me.pathIdx === 0) events.push({ t: 'ability', shipId: me.id, skill: 'blink', x: me.x, y: me.y, talent: 'sto_thunder' });
  } else {
    events.push({ t: 'ability', shipId: me.id, skill: 'repair', x: me.x, y: me.y });
    for (const s of ships) if (Math.hypot(s.x - me.x, s.y - me.y) < 380) events.push({ t: 'heal', x: s.x, y: s.y, targetId: s.id, amount: 180 + Math.round(Math.random() * 120) });
  }
}
function useUtility(ax: number, ay: number): void {
  if (cdUtil > 0) return;
  cdUtil = 0.8;
  if (me.shipClass === 'brute') { hideT = 3; events.push({ t: 'ability', shipId: me.id, skill: 'ironhide', x: me.x, y: me.y }); }
  else if (me.shipClass === 'tech') {
    events.push({ t: 'ability', shipId: me.id, skill: 'singularity', x: me.x, y: me.y });
    const a = Math.atan2(ay - me.y, ax - me.x), d = Math.min(600, Math.hypot(ax - me.x, ay - me.y));
    projs.push({ id: nextId++, kind: 'singularity', x: me.x, y: me.y, vx: Math.cos(a) * 700, vy: Math.sin(a) * 700, team: me.team, ownerId: me.id, level: 1, life: d / 700 });
  } else {
    events.push({ t: 'ability', shipId: me.id, skill: 'wall', x: ax, y: ay });
    addDeploy('wall', me, ax, ay, { radius: 8, length: 220, angle: me.angle + Math.PI / 2, life: 6, max: 6 });
  }
}
function useSecondary(ax: number, ay: number): void {
  if (cdSec > 0) return;
  if (me.shipClass === 'brute') {
    cdSec = 1.2;
    events.push({ t: 'ability', shipId: me.id, skill: 'rockets', x: me.x, y: me.y });
    for (let i = -1; i <= 1; i++) shoot(me, 'rocket', me.angle + i * 0.18, 700, 0.9);
  } else if (me.shipClass === 'tech') {
    cdSec = 0.9;
    events.push({ t: 'ability', shipId: me.id, skill: 'arc', x: me.x, y: me.y });
    const near = enemies.filter((e) => Math.hypot(e.x - ax, e.y - ay) < 500).slice(0, 4);
    const pts = [me.x, me.y]; for (const e of near) pts.push(e.x, e.y);
    if (near.length) events.push({ t: 'arc', points: pts, team: me.team });
  } else {
    cdSec = 1.5;
    events.push({ t: 'ability', shipId: me.id, skill: 'sentry', x: ax, y: ay });
    addDeploy('sentry', me, ax, ay, { radius: 14, life: 10, max: 10 });
  }
}

let last = performance.now(), time = 0, tick = 0, gunCd = 0, evTimer = 0, evIdx = 0;
let fpsAcc = 0, fpsN = 0;

function nearestEnemy(x: number, y: number, max = 900): FakeEnemy | null {
  let best: FakeEnemy | null = null, bd = max * max;
  for (const e of enemies) { const d = (e.x - x) ** 2 + (e.y - y) ** 2; if (d < bd) { bd = d; best = e; } }
  return best;
}

function loop(now: number): void {
  step(now);
  requestAnimationFrame(loop);
}

/** Dev hook (background tabs throttle rAF): run `sec` of demo frames at 60 fps with synthetic timestamps. */
function advance(sec: number): void {
  for (let i = 0, n = Math.round(sec * 60); i < n; i++) step(last + 1000 / 60);
}

function step(now: number): void {
  const dt = Math.max(0, Math.min(0.05, (now - last) / 1000)); // ≥ 0: a real rAF after synthetic frames must not rewind
  last = Math.max(last, now); time += dt; tick += dt * TICK_RATE;
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) {
    const phase = 1 + (Math.floor(time / 2.5) % 4);
    document.getElementById('fps')!.textContent =
      `${Math.round(fpsN / fpsAcc)} fps · q${renderer.qualityLevel} · you: ${SHIP_CLASSES[me.shipClass].name}${me.pathIdx >= 0 ? ' / ' + SHIP_CLASSES[me.shipClass].paths[me.pathIdx].name : ''} · laser resonance ${phase} · ${enemies.length} enemies · ${projs.length} proj · ${deploys.length} deployables`
      + ` · look: ${LOOK_MODES[lookMode]} · death: ${COSMETICS[DEATH_ITEMS[deathIdx]].name} · caches ${loot.length} · carrying ${myCarried.length}/${MAX_CARRIED}${benchText}`;
    const objEl = document.getElementById('obj');
    if (objEl) {
      objEl.textContent = riftDemo.active
        ? `${riftDemo.status()} · layer ${renderer.riftMs.toFixed(3)} ms` + (riftDemo.log.length ? `\n${riftDemo.log.join('\n')}` : '')
        : `${objDemo.status()} · layer ${renderer.objectiveMs.toFixed(3)} ms` + (objDemo.log.length ? `\n${objDemo.log.join('\n')}` : '');
      objEl.textContent += `\n${capDemo.status()}`;
    }
    fpsAcc = 0; fpsN = 0;
  }

  // local ship
  const aim = renderer.screenToWorld(mouseX, mouseY);
  let mx = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0), my = (keys.has('s') ? 1 : 0) - (keys.has('w') ? 1 : 0);
  const ml = Math.hypot(mx, my); if (ml) { mx /= ml; my /= ml; }
  const ab = keys.has('shift');
  cdSec -= dt; cdMob -= dt; cdUtil -= dt; chargeT -= dt; hideT -= dt;
  if (chargeT <= 0) {
    const maxSp = ab ? 700 : 470;
    me.vx += mx * 1100 * dt; me.vy += my * 1100 * dt;
    const sp = Math.hypot(me.vx, me.vy); if (sp > maxSp) { me.vx *= maxSp / sp; me.vy *= maxSp / sp; }
  }
  me.x += me.vx * dt; me.y += me.vy * dt;
  me.angle = Math.atan2(aim.y - me.y, aim.x - me.x);
  me.flags = (ml ? SHIPFLAG_THRUSTING : 0) | (ab && ml ? SHIPFLAG_AFTERBURNER : 0) | (chargeT > 0 ? SHIPFLAG_CHARGING : 0) | (hideT > 0 ? SHIPFLAG_SHIELD : 0);
  if (chargeT > 0 && chargeT - dt <= 0 && me.pathIdx === 0) events.push({ t: 'ability', shipId: me.id, skill: 'ram', x: me.x, y: me.y, talent: 'ram_quake' });
  me.energyFrac = 0.5 + 0.5 * Math.sin(time * 0.4);
  gunCd -= dt;
  const pr = PRIMARY[me.shipClass];
  if (lmb && gunCd <= 0) { gunCd = pr.cd; shoot(me, pr.kind, me.angle, pr.speed, 1.0, 2); events.push({ t: 'fire', shipId: me.id, skill: pr.skill, x: me.x, y: me.y }); }
  if (rmb) useSecondary(aim.x, aim.y);

  // showcase ships orbit the center and fire their primaries (L = line them up next to you)
  for (const s of [...showcase, bulwark, architect, allyInvuln]) {
    const i = s.id;
    const li = showcase.indexOf(s);
    if (demoState.lineup && li >= 0) {
      s.x = me.x + ((li % 3) - 1) * 110; s.y = me.y - 140 - Math.floor(li / 3) * 100; s.vx = s.vy = 0;
      s.angle = -Math.PI / 2 + Math.sin(time * 0.5) * 0.6; s.flags = SHIPFLAG_THRUSTING;
      continue;
    }
    const r = s === bulwark ? 420 : s === architect ? 480 : 260 + (i % 5) * 90, w = s === bulwark || s === architect ? 0.12 : 0.22 + (i % 3) * 0.07;
    const a = time * w + i * 0.7;
    const tx = CX + Math.cos(a) * r, ty = CY + Math.sin(a) * r * 0.7;
    s.vx = (tx - s.x) / Math.max(dt, 1e-3); s.vy = (ty - s.y) / Math.max(dt, 1e-3);
    s.x = tx; s.y = ty;
    const tgt = nearestEnemy(s.x, s.y, 700);
    s.angle = tgt ? Math.atan2(tgt.y - s.y, tgt.x - s.x) : Math.atan2(s.vy, s.vx);
    s.flags = (s.flags & SHIPFLAG_INVULN) | SHIPFLAG_THRUSTING | (i % 4 === 0 ? SHIPFLAG_AFTERBURNER : 0);
    s.energyFrac = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(time * 0.7 + i));
    const p = PRIMARY[s.shipClass];
    if (tgt && Math.random() < dt / (p.cd * 2.5)) { shoot(s, p.kind, s.angle, p.speed, 0.9); events.push({ t: 'fire', shipId: s.id, skill: p.skill, x: s.x, y: s.y }); }
  }
  // Iron Hide on the Bulwark every few seconds
  if (Math.floor(time / 3) % 2 === 0) bulwark.flags |= SHIPFLAG_SHIELD;
  // v0.5 capitals (their turrets, skills and events)
  capWorld.events = events;
  capDemo.step(dt, time, capWorld);

  // turrets
  const phase = 1 + (Math.floor(time / 2.5) % 4);
  for (const t of ships) {
    if (!t.attachedTo || capDemo.owns(t.id)) continue;
    const host = shipMap.get(t.attachedTo)!;
    // v0.5: hardpoints sit on the capital-scaled hull (the sim's ship.stats.radius)
    const o = turretOffset(host.angle, t.turretSlot, t.turretCount, SHIP_CLASSES[host.shipClass].base.radius * capitalScale(t.turretCount));
    t.x = host.x + o.dx; t.y = host.y + o.dy; t.vx = host.vx; t.vy = host.vy;
    t.energyFrac = 0.8;
    t.beamLen = 0; t.beamKind = BEAM_NONE; t.resonance = 1;
    if (capBenchState) { t.angle = host.angle + t.turretSlot; continue; } // capital bench: docking cost only, no fire
    if (t.shipClass === 'tech') {
      const tgt = nearestEnemy(t.x, t.y, 620);
      t.angle = tgt ? Math.atan2(tgt.y - t.y, tgt.x - t.x) : host.angle + (t.turretSlot - 1.5) * 0.3;
      if (t.turretSlot < phase) { t.beamKind = BEAM_LASER; t.resonance = phase; t.beamLen = tgt ? Math.hypot(tgt.x - t.x, tgt.y - t.y) : 620; }
    } else if (t === welder) {
      t.angle = Math.atan2(host.y - t.y, host.x - t.x);
      if (Math.floor(time / 2) % 2 === 0) { t.beamKind = BEAM_WELD; t.beamLen = Math.hypot(host.x - t.x, host.y - t.y); if (Math.random() < 0.08) events.push({ t: 'heal', x: host.x, y: host.y, targetId: host.id, amount: 22 }); }
    } else {
      const tgt = nearestEnemy(t.x, t.y, 500);
      t.angle = tgt ? Math.atan2(tgt.y - t.y, tgt.x - t.x) : time;
      if (tgt && Math.random() < 0.05) for (let k = 0; k < 5; k++) shoot(t, 'shrapnel', t.angle + (k - 2) * 0.12, 900, 0.35);
    }
  }
  // medic repair beam → lowest ally (the Bulwark here)
  events.push({ t: 'beam', fromId: medic.id, toId: showcase[5].id, kind: 'heal' });
  if (Math.random() < 0.05) events.push({ t: 'heal', x: showcase[5].x, y: showcase[5].y, targetId: showcase[5].id, amount: 12 });

  // deployables
  for (let i = deploys.length - 1; i >= 0; i--) {
    const d = deploys[i];
    d.life -= dt;
    d.lifeFrac = Math.max(0, d.life / d.max);
    if (d.kind === 'drone' && d.follow) {
      const a = time * 2 + d.ph;
      d.x = d.follow.x + Math.cos(a) * 45; d.y = d.follow.y + Math.sin(a) * 45; d.angle = a + Math.PI / 2;
      d.life = d.max;
      if (Math.random() < 0.02) shoot(d, 'bullet', d.angle, 900, 0.6);
    }
    if (d.kind === 'sentry') {
      const tgt = nearestEnemy(d.x, d.y, 550);
      if (tgt) d.angle = Math.atan2(tgt.y - d.y, tgt.x - d.x);
      if (tgt && Math.random() < 0.02) shoot(d, 'seeker', d.angle, 520, 1.2);
      if (Math.random() < 0.01) d.hpFrac = Math.max(0.1, d.hpFrac - 0.15);
    }
    if (d.kind === 'wall' && Math.random() < 0.03) d.hpFrac = Math.max(0.05, d.hpFrac - 0.08);
    if (d.life <= 0) {
      events.push({ t: 'deployDeath', id: d.id, kind: d.kind, x: d.x, y: d.y });
      if (d.kind === 'sentry' && d.ownerId === summoner.id) events.push({ t: 'ability', shipId: summoner.id, skill: 'sentry', x: d.x, y: d.y, talent: 'sum_salvage' });
      if (d.kind === 'well') events.push({ t: 'ability', shipId: d.ownerId, skill: 'singularity', x: d.x, y: d.y, talent: 'voi_collapse' });
      deploys.splice(i, 1);
      const owner = shipMap.get(d.ownerId)!;
      if (owner !== me) addDeploy(d.kind, owner, d.x + (Math.random() - 0.5) * 80, d.y + (Math.random() - 0.5) * 80, { radius: d.radius, length: d.length, angle: d.angle + 0.4, life: d.max, max: d.max });
      if (d.kind === 'sentry' || d.kind === 'wall') events.push({ t: 'ability', shipId: d.ownerId, skill: d.kind === 'wall' ? 'wall' : 'sentry', x: d.x, y: d.y });
    }
  }

  // enemies wander toward me-ish
  for (const e of enemies) {
    const dx = me.x - e.x, dy = me.y - e.y, d = Math.hypot(dx, dy) || 1;
    const speed = e.kind === 'hive' || e.kind === 'blackhole' ? 20 : e.kind === 'brute' ? 60 : e.kind === 'dart' ? (Math.sin(time * 1.5 + e.ph) > 0.3 ? 420 : 0) : 110;
    const wob = e.kind === 'weaver' ? Math.sin(time * 4 + e.ph) * 0.9 : Math.sin(time + e.ph) * 0.4;
    const ang = Math.atan2(dy, dx) + wob;
    if (d < 220) { e.vx = -dx / d * speed; e.vy = -dy / d * speed; } else { e.vx = Math.cos(ang) * speed; e.vy = Math.sin(ang) * speed; }
    // wells pull
    for (const w of deploys) if (w.kind === 'well') { const wx = w.x - e.x, wy = w.y - e.y, wd = Math.hypot(wx, wy); if (wd < w.radius && wd > 1) { e.vx += wx / wd * 300; e.vy += wy / wd * 300; } }
    e.x += e.vx * dt; e.y += e.vy * dt; e.angle = Math.atan2(e.vy, e.vx) || e.angle;
    if (e.kind === 'spinner' && Math.random() < 0.02) projs.push({ id: nextId++, kind: 'enemyShot', x: e.x, y: e.y, vx: Math.cos(time * 3) * 260, vy: Math.sin(time * 3) * 260, team: ENEMY_TEAM, ownerId: e.id, level: 1, life: 2.5 });
  }
  // laser beam damage
  for (const t of lasers) if (t.beamLen > 0) {
    const e = nearestEnemy(t.x, t.y, 640);
    if (e && Math.random() < 0.05 * t.resonance) { e.hpFrac -= 0.25 * Math.pow(1.5, t.resonance - 1); events.push({ t: 'hit', x: e.x, y: e.y, targetKind: 'enemy', targetId: e.id, amount: 50 }); }
  }
  // projectiles
  for (let i = projs.length - 1; i >= 0; i--) {
    const p = projs[i];
    p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
    if (p.kind === 'seeker' || p.kind === 'rocket') {
      const tgt = nearestEnemy(p.x, p.y, 400);
      if (tgt) {
        const want = Math.atan2(tgt.y - p.y, tgt.x - p.x), cur = Math.atan2(p.vy, p.vx), sp = Math.hypot(p.vx, p.vy);
        let da = want - cur; while (da > Math.PI) da -= Math.PI * 2; while (da < -Math.PI) da += Math.PI * 2;
        const na = cur + Math.max(-3 * dt, Math.min(3 * dt, da));
        p.vx = Math.cos(na) * sp; p.vy = Math.sin(na) * sp;
      }
    }
    let hit: FakeEnemy | null = null;
    if (p.team !== ENEMY_TEAM && p.kind !== 'mine' && p.kind !== 'singularity') {
      for (const e of enemies) { if ((e.x - p.x) ** 2 + (e.y - p.y) ** 2 < (e.radius + 6) ** 2) { hit = e; break; } }
    }
    if (hit || p.life <= 0) {
      if (p.kind === 'rocket' || p.kind === 'seeker') events.push({ t: 'explode', x: p.x, y: p.y, radius: p.kind === 'rocket' ? 70 : 45, kind: p.kind, team: p.team });
      if (p.kind === 'singularity') addDeploy('well', me, p.x, p.y, { radius: 280, life: 3, max: 3 });
      if (hit) {
        events.push({ t: 'hit', x: p.x, y: p.y, targetKind: 'enemy', targetId: hit.id, amount: 100 });
        hit.hpFrac -= hit.kind === 'hive' || hit.kind === 'matriarch' ? 0.02 : 0.4;
      }
      projs.splice(i, 1);
    }
  }
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (e.hpFrac > 0 || e.kind === 'matriarch') continue; // the rift demo scripts the Matriarch's HP and death
    events.push({ t: 'enemyDeath', id: e.id, kind: e.kind, x: e.x, y: e.y, elite: e.elite });
    enemies.splice(i, 1);
    spawnEnemy(e.kind);
    gems.push({ id: nextId++, x: e.x, y: e.y, value: 1 + Math.floor(Math.random() * 12) });
  }
  // gem pickup
  for (let i = gems.length - 1; i >= 0; i--) {
    const g = gems[i];
    const dx = me.x - g.x, dy = me.y - g.y, d = Math.hypot(dx, dy);
    if (d < 120) { g.x += dx / d * 500 * dt; g.y += dy / d * 500 * dt; }
    if (d < 18) { events.push({ t: 'gem', x: g.x, y: g.y, playerId: 1, value: g.value }); gems.splice(i, 1); }
  }
  while (gems.length < 50) gems.push({ id: nextId++, x: CX + (Math.random() - 0.5) * 1600, y: CY + (Math.random() - 0.5) * 1000, value: [1, 2, 5, 12, 30][nextId % 5] });

  // scripted event carousel (other ships' skills)
  evTimer -= dt;
  if (evTimer <= 0) {
    evTimer = 0.9;
    const tech = showcase[3 + (evIdx % 3)];
    const brute = showcase[evIdx % 3];
    const eng = showcase[6 + (evIdx % 3)];
    switch (evIdx % 8) {
      case 0: events.push({ t: 'ability', shipId: brute.id, skill: 'rockets', x: brute.x, y: brute.y });
        for (let i = -2; i <= 2; i++) shoot(brute, 'rocket', brute.angle + i * 0.15, 700, 0.8);
        break;
      case 1: {
        const fx = tech.x, fy = tech.y, a = Math.random() * Math.PI * 2;
        const tx = fx + Math.cos(a) * 300, ty = fy + Math.sin(a) * 300;
        events.push({ t: 'blink', shipId: tech.id, fromX: fx, fromY: fy, x: tx, y: ty });
        if (tech.pathIdx === 0) events.push({ t: 'ability', shipId: tech.id, skill: 'blink', x: tx, y: ty, talent: 'sto_thunder' });
        break;
      }
      case 2: events.push({ t: 'ability', shipId: eng.id, skill: 'repair', x: eng.x, y: eng.y });
        for (const s of ships) if (Math.hypot(s.x - eng.x, s.y - eng.y) < 380) events.push({ t: 'heal', x: s.x, y: s.y, targetId: s.id, amount: 150 + Math.round(Math.random() * 150) });
        break;
      case 3: {
        events.push({ t: 'ability', shipId: tech.id, skill: 'arc', x: tech.x, y: tech.y });
        const near = enemies.filter((e) => Math.hypot(e.x - tech.x, e.y - tech.y) < 600).slice(0, 5);
        if (near.length) events.push({ t: 'arc', points: [tech.x, tech.y, ...near.flatMap((e) => [e.x, e.y])], team: tech.team });
        break;
      }
      case 4: events.push({ t: 'ability', shipId: brute.id, skill: 'ironhide', x: brute.x, y: brute.y }); break;
      case 5: events.push({ t: 'ability', shipId: showcase[0].id, skill: 'ram', x: showcase[0].x, y: showcase[0].y, talent: 'ram_quake' }); break;
      case 6: events.push({ t: 'waveStart', wave: evIdx, boss: evIdx % 16 === 6 }); break;
      case 7: events.push({ t: 'levelUp', playerId: evIdx % 2 ? 1 : eng.playerId, level: 6 }); break;
    }
    evIdx++;
  }

  stepLoot(dt);
  objDemo.step(dt, objWorld); // after every ship's flags are set: ORs SHIPFLAG_CARRIER onto carriers
  riftDemo.step(dt, riftWorld); // after the enemy moves: keeps them in their rooms, scripts the boss
  if (riftDemo.pendingDescend) { riftDemo.pendingDescend = false; const m = riftDemo.descend(riftWorld); if (m) renderer.setMap(m); }
  const frame: RenderFrame = {
    time, dt, renderTick: tick, localPlayerId: 1, localShipId: me.id,
    focusX: shipMap.get(demoState.focusId)?.x ?? me.x, focusY: shipMap.get(demoState.focusId)?.y ?? me.y,
    ships, enemies, projectiles: projs, gems, deployables: deploys, events: events.splice(0), you: null,
    match: riftDemo.active ? riftDemo.match(riftWorld) : objDemo.match(Math.max(0, 600 - time)), players,
    aimX: aim.x, aimY: aim.y, attachCandidateId: allyInvuln.id, loot, carry: carryViews(),
  };
  const r0 = performance.now();
  renderer.render(frame);
  benchSample(performance.now() - r0);
  capBenchSample(performance.now() - r0);
  audio.playEvents(frame.events, me.x, me.y, me.id);
}

// =============================================================================================
// v0.3 M2 demo: cosmetic loadouts (L), death presets (K), caches (C), spill (J), bench (B)
// =============================================================================================

const LOOK_MODES = ['starter', 'Salvage Line', 'Rift Set', 'Gladiator Set', 'Swarm Set', 'mixed sets'] as const;
const MODE_SETS: (LootSet | 'starter')[] = ['starter', 'common', 'rift', 'gladiator', 'swarm'];
let lookMode = 5;

/** Every item of one set that fits a ship of `cls` (class slots follow the class / kit). */
function setLoadout(set: LootSet | 'starter', cls: ShipClassId): CosmeticLoadout {
  const lo: CosmeticLoadout = {};
  if (set === 'starter') return lo;
  for (const d of COSMETIC_LIST) {
    if (d.set !== set) continue;
    if (d.slot === 'hull' || d.slot === 'weapon') { if (d.shipClass === cls) lo[d.slot] = d.id; }
    else if (d.slot === 'turret') { if (d.kit === SHIP_CLASSES[cls].turret.id) lo.turret = d.id; }
    else lo[d.slot] = d.id;
  }
  return lo;
}

const DEATH_ITEMS = ['std.death', 'com.death.glass', 'rift.death.collapse', 'glad.death.triumph', 'swarm.death.hatch'];
let deathIdx = 0;
const VICTIM = 999;

/** Rebuild `players` (new Map identity → the renderer re-resolves every look). */
function applyLooks(): void {
  const m = new Map<number, PlayerInfo>();
  let i = 0;
  for (const [pid, info] of players) {
    if (pid === VICTIM) continue;
    const cls = shipMap.get(pid)?.shipClass ?? info.shipClass;
    const set = lookMode < MODE_SETS.length ? MODE_SETS[lookMode] : MODE_SETS[1 + (i++ % 4)];
    const lo = setLoadout(set, cls);
    const fixed = capDemo.loadouts.get(pid); // v0.5 showcase turrets keep their fire preset in every look mode
    m.set(pid, { ...info, shipClass: cls, cosmetics: fixed ? { ...lo, ...fixed } : lo });
  }
  m.set(VICTIM, {
    playerId: VICTIM, name: 'Target', team: 2, shipClass: 'brute', isBot: true, isHost: false, ready: true, ping: 0, inMatch: true,
    cosmetics: { death: DEATH_ITEMS[deathIdx] },
  });
  players = m;
}

function playDeathPreset(x: number, y: number): void {
  deathIdx = (deathIdx + 1) % DEATH_ITEMS.length;
  applyLooks();
  events.push({ t: 'shipDeath', shipId: 99_999, playerId: VICTIM, killerPlayerId: 1, cause: 'player', x, y, bounty: 20 });
}

// ---- caches
interface FakeLoot extends LootView { vx: number; vy: number; life: number; max: number }
const loot: FakeLoot[] = [];
let myCarried: Rarity[] = [];
let cacheSeq = 0;

function spawnCaches(x: number, y: number, life = 30): void {
  for (let r = 0 as Rarity; r <= 4; r = (r + 1) as Rarity) {
    const a = (r / 5) * Math.PI * 2 + cacheSeq * 0.4, sp = 90 + r * 20;
    const set = LOOT_SETS[(r + cacheSeq) % LOOT_SETS.length];
    const lv: FakeLoot = {
      id: nextId++, x: x + Math.cos(a) * 30, y: y + Math.sin(a) * 30, rarity: r, set,
      // one reserved for you (dashed ring in your colour), one for someone else (drawn at 50%)
      reservedFor: r === 1 ? 1 : r === 2 ? 5 : 0, lifeFrac: 1, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: life,
    };
    loot.push(lv);
    events.push({ t: 'lootDrop', id: lv.id, x: lv.x, y: lv.y, rarity: r, set, source: 'elite' });
  }
  cacheSeq++;
}

function spillMine(): void {
  if (!myCarried.length) return;
  const best = Math.max(...myCarried) as Rarity;
  events.push({ t: 'lootSpill', playerId: 1, x: me.x, y: me.y, count: myCarried.length, best });
  for (const r of [...myCarried].sort((a, b) => b - a)) {
    const a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 120;
    loot.push({ id: nextId++, x: me.x, y: me.y, rarity: r, set: 'common', reservedFor: 0, lifeFrac: 1, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 45, max: 45 });
  }
  myCarried = [];
}

function carryViews(): CarryView[] {
  const out: CarryView[] = [
    { shipId: showcase[0].id, n: 5, best: 1 }, // beacon by count
    { shipId: bulwark.id, n: 1, best: 4 }, // beacon by rarity (legendary)
    { shipId: showcase[4].id, n: 2, best: 2 },
  ];
  if (myCarried.length) out.push({ shipId: me.id, n: myCarried.length, best: Math.max(...myCarried) as Rarity });
  return out;
}

const wingmen: ShipView[] = [];

function stepLoot(dt: number): void {
  const k = Math.pow(0.08, dt);
  const reach = SHIP_CLASSES[me.shipClass].base.radius + LOOT_PICKUP_PAD;
  for (let i = loot.length - 1; i >= 0; i--) {
    const lv = loot[i];
    lv.x += lv.vx * dt; lv.y += lv.vy * dt; lv.vx *= k; lv.vy *= k;
    lv.life -= dt;
    lv.lifeFrac = Math.max(0, lv.life / lv.max);
    if (lv.life <= 0) { loot.splice(i, 1); continue; }
    if ((lv.reservedFor === 0 || lv.reservedFor === 1) && myCarried.length < MAX_CARRIED && Math.hypot(lv.x - me.x, lv.y - me.y) < reach) {
      myCarried.push(lv.rarity);
      events.push({ t: 'lootPickup', playerId: 1, shipId: me.id, x: lv.x, y: lv.y, rarity: lv.rarity, set: lv.set, carried: myCarried.length });
      loot.splice(i, 1);
    }
  }
  // bench wingmen fly a loose formation around you and fire their (cosmetic) primaries
  for (let i = 0; i < wingmen.length; i++) {
    const s = wingmen[i];
    if (s.attachedTo) continue; // v0.5 capital bench: docked wingmen ride their host
    const a = time * 0.5 + (i * Math.PI * 2) / wingmen.length, R = 230 + (i % 3) * 60;
    const tx = me.x + Math.cos(a) * R, ty = me.y + Math.sin(a) * R * 0.6;
    s.vx = (tx - s.x) / Math.max(dt, 1e-3); s.vy = (ty - s.y) / Math.max(dt, 1e-3);
    s.x = tx; s.y = ty; s.angle = a + Math.PI / 2;
    s.flags = SHIPFLAG_THRUSTING | (i % 3 === 0 ? SHIPFLAG_AFTERBURNER : 0);
    const p = PRIMARY[s.shipClass];
    if (!capBenchState && Math.random() < dt / (p.cd * 3)) { shoot(s, p.kind, s.angle, p.speed, 0.8); events.push({ t: 'fire', shipId: s.id, skill: p.skill, x: s.x, y: s.y }); }
  }
}

// ---- bench: alternate starter looks vs mixed cosmetics at 32 ships, report the added ms per frame
interface BenchState { mode: 0 | 1; seen: number; acc: [number, number]; n: [number, number]; halves: number; prevLook: number }
let benchState: BenchState | null = null;
let benchText = '';
const bench: { done: boolean; ships: number; starterMs: number; cosmeticMs: number; addedMs: number; samples: number } =
  { done: false, ships: 0, starterMs: 0, cosmeticMs: 0, addedMs: 0, samples: 0 };
const BENCH_WARMUP = 20, BENCH_SAMPLES = 150, BENCH_HALVES = 8;

function startBench(): void {
  if (benchState) return;
  while (ships.length < 32) {
    const i = ships.length;
    wingmen.push(addShip(300 + i, CLASSES[i % 3], i % 4, me.x, me.y, i % 3));
  }
  bench.done = false;
  benchState = { mode: 0, seen: 0, acc: [0, 0], n: [0, 0], halves: 0, prevLook: lookMode };
  lookMode = 0; applyLooks();
}

function benchSample(ms: number): void {
  const b = benchState;
  if (!b) return;
  b.seen++;
  if (b.seen > BENCH_WARMUP) { b.acc[b.mode] += ms; b.n[b.mode]++; }
  if (b.seen < BENCH_WARMUP + BENCH_SAMPLES) { benchText = ` · bench ${b.halves + 1}/${BENCH_HALVES}`; return; }
  b.halves++; b.seen = 0;
  if (b.halves < BENCH_HALVES) {
    b.mode = b.mode === 0 ? 1 : 0;
    lookMode = b.mode === 0 ? 0 : LOOK_MODES.length - 1;
    applyLooks();
    return;
  }
  bench.ships = ships.length;
  bench.starterMs = b.acc[0] / Math.max(1, b.n[0]);
  bench.cosmeticMs = b.acc[1] / Math.max(1, b.n[1]);
  bench.addedMs = bench.cosmeticMs - bench.starterMs;
  bench.samples = b.n[0] + b.n[1];
  bench.done = true;
  benchText = ` · bench: +${bench.addedMs.toFixed(3)} ms/frame at ${bench.ships} ships (${bench.starterMs.toFixed(2)} → ${bench.cosmeticMs.toFixed(2)})`;
  console.log('[render bench]', JSON.stringify(bench));
  lookMode = b.prevLook;
  benchState = null;
  for (const s of wingmen) { ships.splice(ships.indexOf(s), 1); shipMap.delete(s.id); players.delete(s.id); }
  wingmen.length = 0;
  applyLooks();
}

// ---- v0.5 capital bench (0): 32 wingmen alternate between all flying free and 8 capitals × 3 bubble domes (no
// turret fire, so only the capital hulls, sockets, domes, hardpoint glows and morphs differ); reports the added ms
// per frame of renderer.render.
interface CapBenchState { mode: 0 | 1; seen: number; acc: [number, number]; n: [number, number]; halves: number }
let capBenchState: CapBenchState | null = null;
const capMen: ShipView[] = [];
const capBench: { done: boolean; ships: number; freeMs: number; capitalMs: number; addedMs: number; samples: number } =
  { done: false, ships: 0, freeMs: 0, capitalMs: 0, addedMs: 0, samples: 0 };

function dockCapMen(docked: boolean): void {
  for (let g = 0; g < 8; g++) {
    const host = capMen[g * 4];
    host.turretCount = docked ? 3 : 0;
    for (let k = 1; k < 4; k++) {
      const t = capMen[g * 4 + k];
      if (docked) attach(t, host, k - 1, 3);
      else { t.attachedTo = 0; t.turretSlot = -1; t.turretCount = 0; t.beamLen = 0; t.beamKind = BEAM_NONE; }
    }
  }
}

function startCapBench(): void {
  if (capBenchState || benchState) return;
  for (let i = 0; i < 32; i++) {
    const g = Math.floor(i / 4);
    const s = addShip(900 + i, CLASSES[(g + (i % 4)) % 3], g % 4, me.x, me.y, i % 3);
    capMen.push(s); wingmen.push(s);
  }
  applyLooks();
  capBench.done = false;
  capBenchState = { mode: 0, seen: 0, acc: [0, 0], n: [0, 0], halves: 0 };
}

function capBenchSample(ms: number): void {
  const b = capBenchState;
  if (!b) return;
  b.seen++;
  if (b.seen > BENCH_WARMUP) { b.acc[b.mode] += ms; b.n[b.mode]++; }
  if (b.seen < BENCH_WARMUP + BENCH_SAMPLES) { benchText = ` · capital bench ${b.halves + 1}/${BENCH_HALVES}`; return; }
  b.halves++; b.seen = 0;
  if (b.halves < BENCH_HALVES) { b.mode = b.mode === 0 ? 1 : 0; dockCapMen(b.mode === 1); return; }
  capBench.ships = capMen.length;
  capBench.freeMs = b.acc[0] / Math.max(1, b.n[0]);
  capBench.capitalMs = b.acc[1] / Math.max(1, b.n[1]);
  capBench.addedMs = capBench.capitalMs - capBench.freeMs;
  capBench.samples = b.n[0] + b.n[1];
  capBench.done = true;
  benchText = ` · capital bench: +${capBench.addedMs.toFixed(3)} ms/frame (${capBench.freeMs.toFixed(2)} free → ${capBench.capitalMs.toFixed(2)} as 8 capitals × 3 domes)`;
  console.log('[capital bench]', JSON.stringify(capBench));
  capBenchState = null;
  dockCapMen(false);
  for (const s of capMen) { ships.splice(ships.indexOf(s), 1); shipMap.delete(s.id); players.delete(s.id); wingmen.splice(wingmen.indexOf(s), 1); }
  capMen.length = 0;
  applyLooks();
}
(window as unknown as { __capBench: typeof capBench }).__capBench = capBench;

void main();

