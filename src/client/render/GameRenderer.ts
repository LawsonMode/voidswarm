// GameRenderer — Pixi v8 neon renderer (RENDER agent). Implements IGameRenderer from ../contracts.
// v0.2: 3 classes with path trim + turret-kit glyphs, deployables, beams (laser resonance / hull weld),
// skill-specific FX.
// v0.3 M2: cosmetics for the 7 slots (looks resolved once per players Map in cosmeticLook.ts; hull shapes /
// patterns / mounts in shapes.ts; engine + death presets in cosmeticFx.ts; titles under nameplates), the
// root-alpha rule, and the in-world loot layer (loot.ts: caches, carrier pips, radar beacons).
// v0.3 M3: the objective layer (objectives.ts: CTF stands / pennants, Control Zone pads, the Hot Point, carrier
// glow, radar icons, off-screen edge pointers, objective event FX), between mapLayer and gems.
// v0.3 M4: the rift layer (rift.ts: door force-fields per room state, chests, anchor beacon, Descend / Extract
// portals with channel arcs, spawnWarn cracks, boss telegraphs, rift event FX), the sealed-room screen vignette,
// biome wall / grid palettes (walls.ts), minimap room fog by party.seen, the Matriarch body + phases, and the open
// portals on beamBus (portal hum). setMap is re-entrant for every floorStart.
import {
  Application, Container, Graphics, type GraphicsContext, Rectangle, Sprite, Text, Texture, TilingSprite,
} from 'pixi.js';
import { AdvancedBloomFilter, ShockwaveFilter } from 'pixi-filters';
import type { IGameRenderer, RenderFrame } from '../contracts';
import {
  ENEMY_TEAM, LASER_RESONANCE, MAX_VIEW_HALF_EXTENT, ORBIT_RADIUS, ORBIT_SPEED, TICK_RATE,
} from '../../shared/constants';
import {
  BEAM_LASER, BEAM_WELD, SHIPFLAG_AFTERBURNER, SHIPFLAG_CHARGING, SHIPFLAG_CLOAKED, SHIPFLAG_INVULN, SHIPFLAG_SHIELD,
  SHIPFLAG_THRUSTING,
  type DeployableKind, type DeployableView, type EnemyView, type EntityId, type GameEvent, type GameMap, type PlayerId,
  type ShipClassId, type ShipView, type SkillId, type TeamId,
} from '../../shared/types';
import { ENEMY_COLOR, colorFor } from '../../shared/data/teams';
import { PATHS, SHIP_CLASSES, TALENTS } from '../../shared/data/ships';
import { turretOffset } from '../../shared/sim/world';
import { buildAtlas, buildStarTile, buildVignette, type Atlas } from './textures';
import { P_ORIENT, P_SPIN, P_STRETCH, Particles, SpriteBatch } from './particles';
import { SpringGrid } from './grid';
import { buildMinimapCanvas, buildWalls, paletteFor, type WallChunk } from './walls';
import {
  EMPTY_CTX, ENEMY_BASE_R, TECH_NODES, deployBody, eliteRing, enemyBody, hiveRing, matriarchPart, shipAux, shipHull,
  sweepShipCaches, wallBody,
} from './shapes';
import {
  BG_COLOR, ENEMY_COLORS, GOLD, MATRIARCH_GOLD, SHIELD_COLOR, brighten, darken, energyColor, gemColor, gemScale, mix,
} from './palette';
import { beamBus, publishBeam } from './beamBus';
import { LookTable, hullFor, turretFor, weaponFor, type TurretLook, type WeaponLook } from './cosmeticLook';
import { emitDeathPreset, emitEngine, engineFlameTint, type DeathHost } from './cosmeticFx';
import { LootLayer, type LootHost, type ShipAnchor } from './loot';
import { ObjectiveLayer, type ObjShip, type ObjectiveHost, type Rect } from './objectives';
import { RiftLayer, vignetteFor, type RiftHost } from './rift';

interface ShipDisp {
  root: Container; glow: Sprite; flame: Sprite; flame2: Sprite; hull: Graphics; aux: Graphics; key: string;
  x: number; y: number; pvx: number; pvy: number; ax: number; ay: number; thrustA: number;
  hostR: number; ghostT: number;
  label: Text | null; labelStr: string; seen: number;
  /** v0.3 cosmetic title under the nameplate (pooled with the display). */
  title: Text | null; titleStr: string;
  /** Root alpha / ally flag from the last drawShips (cosmetic emission gating). */
  alpha: number; ally: boolean;
}
interface EnemyDisp {
  root: Container; body: Graphics; ring: Graphics | null; hive0: Graphics | null; hive1: Graphics | null;
  /** v0.3 M4 Matriarch layers: halo (behind), wings (behind the body), brood (over it); smoothed heading. */
  m0: Graphics | null; m1: Graphics | null; m2: Graphics | null; rot: number;
  key: string; px: number; py: number; speed: number; hitT: number; seen: number;
}
interface DeployDisp {
  root: Container; base: Graphics; head: Graphics; key: string; seen: number;
  born: number; lastHp: number; hitT: number;
  kind: DeployableKind; x: number; y: number; angle: number; length: number; radius: number; color: number;
}
interface Ring {
  x: number; y: number; r0: number; r1: number; t: number; life: number; color: number; width: number;
  follow: EntityId; alpha: number;
}
interface Line { pts: number[]; t: number; life: number; color: number; width: number }
interface Ghost { g: Graphics; life: number; max: number; a0: number }
interface FloatNum { text: Text; life: number; x: number; y: number; target: EntityId; amount: number; active: boolean }
interface Tether { from: EntityId; to: EntityId; t: number; life: number }

const TAU = Math.PI * 2;
/** A minimap texture replaced by setMap is destroyed only after this many rendered frames AND this long (ms). */
const STALE_TEX_FRAMES = 120;
const STALE_TEX_MS = 3000;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
function poseFlame(f: Sprite, x: number, y: number, rot: number, sx: number, sy: number, tint: number): void {
  f.visible = true; f.position.set(x, y); f.rotation = rot; f.scale.set(sx, sy); f.tint = tint; f.alpha = 0.9;
}
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const HEAL_COLOR = 0x5bff8a;
const STEEL = 0xc2d0e6;
const VOID_COLOR = 0xb45bff;
const LASER_COLD = 0x3ce6ff;

export class GameRenderer implements IGameRenderer {
  private app = new Application();
  private ready = false;
  private atlas!: Atlas;

  // --- layers
  private worldRoot = new Container();
  private stars: TilingSprite[] = [];
  private cam = new Container();
  private gridG = new Graphics();
  private mapLayer = new Container();
  private gems!: SpriteBatch;
  private deployGlow!: SpriteBatch;
  private deployLayer = new Container();
  private enemyLayer = new Container();
  private darkG = new Graphics();
  private projs!: SpriteBatch;
  private trails!: Particles;
  private ghostLayer = new Container();
  private shipLayer = new Container();
  private dynG = new Graphics();
  private fx!: Particles;
  private overlay = new Container();
  private overlayG = new Graphics();
  private labelLayer = new Container();
  private screenFx = new Graphics();
  private hud = new Container();
  private radarBg = new Graphics();
  private radarMap = new Sprite();
  private radarDots = new Graphics();
  private bigRoot = new Container();
  private bigBg = new Graphics();
  private bigMap = new Sprite();
  private bigDots = new Graphics();
  private bigOpen = false;

  // --- filters
  private bloom!: AdvancedBloomFilter;
  private shock!: ShockwaveFilter;
  private shockOn = false;

  // --- state
  private map: GameMap | null = null;
  private chunks: WallChunk[] = [];
  private grid: SpringGrid | null = null;
  private miniTex: Texture | null = null;
  /** Minimap textures replaced by setMap / a fog change, destroyed two renders later (the radar sprites' bind groups
   *  still hold them until then; destroying at once makes Pixi warn "textureSource destroyed while still bound"). */
  private staleTex: { tex: Texture; at: number; ms: number }[] = [];
  /** Map the current minimap texture was built for (a fog change on it redraws in place). */
  private miniTexMap: GameMap | null = null;
  private ships = new Map<EntityId, ShipDisp>();
  private shipPool: ShipDisp[] = [];
  private enemies = new Map<EntityId, EnemyDisp>();
  private enemyPool: EnemyDisp[] = [];
  private deploys = new Map<EntityId, DeployDisp>();
  private deployPool: DeployDisp[] = [];
  private shipById = new Map<EntityId, ShipView>();
  private shipByPlayer = new Map<PlayerId, ShipView>();
  private rings: Ring[] = [];
  private lines: Line[] = [];
  private ghosts: Ghost[] = [];
  private ghostFree: Graphics[] = [];
  private nums: FloatNum[] = [];
  private tethers: Tether[] = [];
  private tint = { color: 0, a: 0, decay: 1 };
  private frameNo = 0;
  private now = 0;

  // --- v0.3 cosmetics + loot
  private looks = new LookTable();
  private lootLayer!: LootLayer;
  private lootHost!: LootHost;
  private deathHost!: DeathHost;
  private anchor: ShipAnchor = { x: 0, y: 0, r: 0, alpha: 1, ally: false, cloaked: false };

  // --- v0.3 M3 objectives (world layer under gems; edge pointers + their labels in the HUD)
  private objLayer!: ObjectiveLayer;
  private objHost!: ObjectiveHost;
  private objectiveRoot = new Container();
  private objPadG = new Graphics();
  private objAddG = new Graphics();
  private objLabelLayer = new Container();
  private edgeG = new Graphics();
  private edgeLabels = new Container();
  private objLabelsW = new Map<string, { text: Text; seen: number; str: string }>();
  private objLabelsS = new Map<string, { text: Text; seen: number; str: string }>();
  private objShipOut: ObjShip = { x: 0, y: 0, r: 0, vx: 0, vy: 0, alpha: 1, ally: false, cloaked: false };
  private radarRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private objMs = 0;
  /** Dev harness: EMA of the ms per frame spent in the objective layer (world + carriers + pointers). */
  get objectiveMs(): number { return this.objMs; }

  // --- v0.3 M4 rift (world layer between mapLayer and objectives; vignette in screen space)
  private riftLayer!: RiftLayer;
  private riftHost!: RiftHost;
  private riftRoot = new Container();
  private riftPadG = new Graphics();
  private riftAddG = new Graphics();
  private vignette = new Sprite();
  private vigA = 0;
  private vigColor = 0;
  /** Seen mask the minimap texture was last built with (-1 = no fog / not built). */
  private fogBuilt = -1;
  /** setMap before init resolved: applied at the end of init. */
  private pendingMap: GameMap | null = null;
  private riftMsEma = 0;
  /** Dev harness: EMA of the ms per frame spent in the rift layer. */
  get riftMs(): number { return this.riftMsEma; }
  /** Dev harness / tests: the rift layer. */
  get rift(): RiftLayer { return this.riftLayer; }

  // --- camera
  private camX = 0; private camY = 0; private zoom = 1;
  private camInit = false;
  private trauma = 0; private shakeAmt = 1;
  private shakeX = 0; private shakeY = 0;
  private sw = 0; private sh = 0;
  private view = { x0: 0, y0: 0, x1: 0, y1: 0 };

  // --- quality
  private quality = 2;
  private emaMs = 16;
  private slowFor = 0;
  private lastNow = 0;
  private density = 1;

  async init(parent: HTMLElement): Promise<void> {
    await this.app.init({
      resizeTo: parent,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      background: BG_COLOR,
      autoStart: false,
      sharedTicker: false,
      preference: 'webgl',
      powerPreference: 'high-performance',
    });
    this.app.ticker?.stop();
    const cv = this.app.canvas as HTMLCanvasElement;
    cv.style.display = 'block';
    cv.style.width = '100%';
    cv.style.height = '100%';
    parent.appendChild(cv);

    this.atlas = buildAtlas();
    this.gems = new SpriteBatch(this.atlas.base);
    this.lootLayer = new LootLayer(this.atlas, new SpriteBatch(this.atlas.base));
    this.objLayer = new ObjectiveLayer(this.atlas, new SpriteBatch(this.atlas.base));
    this.riftLayer = new RiftLayer(this.atlas, new SpriteBatch(this.atlas.base));
    this.initCosmeticHosts();
    this.initObjectiveHost();
    this.initRiftHost();
    this.deployGlow = new SpriteBatch(this.atlas.base);
    this.projs = new SpriteBatch(this.atlas.base);
    this.trails = new Particles(this.atlas.base, 1500);
    this.fx = new Particles(this.atlas.base, 3500);

    const tiles: [number, number, number, number, [number, number, number]][] = [
      [512, 260, 1.0, 11, [150, 150, 255]],
      [512, 90, 1.5, 23, [190, 200, 255]],
      [512, 36, 2.1, 37, [255, 220, 255]],
    ];
    for (const [size, count, r, seed, tint] of tiles) {
      const t = new TilingSprite({ texture: buildStarTile(size, count, r, seed, tint), width: 16, height: 16 });
      this.stars.push(t);
      this.worldRoot.addChild(t);
    }
    this.worldRoot.addChild(this.cam);
    this.objectiveRoot.addChild(this.objPadG, this.objLayer.glow.pc, this.objAddG, this.objLabelLayer);
    this.objAddG.blendMode = 'add';
    this.riftRoot.addChild(this.riftPadG, this.riftLayer.glow.pc, this.riftAddG);
    this.riftAddG.blendMode = 'add';
    this.cam.addChild(this.gridG, this.mapLayer, this.riftRoot, this.objectiveRoot, this.gems.pc, this.lootLayer.batch.pc, this.deployGlow.pc, this.deployLayer,
      this.enemyLayer, this.darkG, this.trails.pc, this.projs.pc, this.ghostLayer, this.shipLayer, this.dynG, this.fx.pc);
    this.dynG.blendMode = 'add';
    this.gridG.blendMode = 'add';
    this.ghostLayer.blendMode = 'add';

    this.overlay.addChild(this.overlayG, this.labelLayer);
    this.screenFx.blendMode = 'add';
    this.hud.addChild(this.edgeG, this.edgeLabels, this.radarBg, this.radarMap, this.radarDots, this.bigRoot);
    this.bigRoot.addChild(this.bigBg, this.bigMap, this.bigDots);
    this.bigRoot.visible = false;
    this.vignette.texture = buildVignette();
    this.vignette.visible = false;
    this.app.stage.addChild(this.worldRoot, this.overlay, this.screenFx, this.vignette, this.hud);

    this.bloom = new AdvancedBloomFilter({ threshold: 0.18, bloomScale: 1.2, brightness: 1.0, blur: 7, quality: 5 });
    this.bloom.resolution = 'inherit';
    this.bloom.antialias = 'inherit';
    this.shock = new ShockwaveFilter({ amplitude: 16, wavelength: 110, speed: 900, brightness: 1.15, radius: 700 });
    this.worldRoot.filters = [this.bloom];
    this.ready = true;
    this.layout();
    if (this.pendingMap) { const m = this.pendingMap; this.pendingMap = null; this.setMap(m); }
  }

  /**
   * Re-entrant: every matchStart AND every rift floorStart. Rebuilds walls (biome palette), the spring grid, the
   * minimap (with room fog on rift floors), the objective and rift layers, drops every transient FX, floating number
   * and afterimage, and mark-and-sweeps the ship caches. Before init resolves the map is kept and applied after it.
   */
  setMap(map: GameMap): void {
    if (!this.ready) { this.pendingMap = map; return; }
    this.map = map;
    for (const c of this.chunks) c.g.destroy();
    this.chunks = buildWalls(map, this.mapLayer);
    const pal = paletteFor(map);
    const spacing = this.quality >= 2 ? 64 : this.quality === 1 ? 96 : 128;
    this.grid = new SpringGrid(map.width, map.height, spacing);
    this.grid.colors = { ...pal.grid };
    this.rings.length = 0; this.lines.length = 0; this.tethers.length = 0;
    this.fx.clear(); this.trails.clear();
    for (const n of this.nums) { n.active = false; n.text.visible = false; }
    this.objLayer.setMap(map);
    this.riftLayer.setMap(map, pal.door);
    this.rebuildMinimap();
    this.vigA = 0; this.vignette.visible = false;
    this.sweepShipCaches();
    this.camInit = false;
    this.layoutHud();
  }

  /**
   * (Re)build the radar / big-map texture: at setMap, and on a rift floor whenever the party's seen mask changes. A
   * fog change on the same map redraws into the texture's own canvas and re-uploads it (source.update): no texture is
   * ever destroyed while a sprite's bind group (the hidden big map's, too) may still hold it. Only setMap makes a new
   * texture; the old one is destroyed well after (STALE_TEX_FRAMES / STALE_TEX_MS).
   */
  private rebuildMinimap(): void {
    const map = this.map;
    if (!map) return;
    const canvas = buildMinimapCanvas(map, this.riftLayer.fog());
    const cur = this.miniTex;
    const res = cur ? (cur.source.resource as HTMLCanvasElement | undefined) : undefined;
    if (cur && this.miniTexMap === map && res && typeof res.getContext === 'function' &&
        res.width === canvas.width && res.height === canvas.height) {
      const c = res.getContext('2d');
      if (c) {
        c.clearRect(0, 0, res.width, res.height);
        c.drawImage(canvas, 0, 0);
        cur.source.update();
        this.fogBuilt = this.riftLayer.fogKey;
        return;
      }
    }
    if (cur) this.staleTex.push({ tex: cur, at: this.frameNo, ms: performance.now() });
    this.miniTex = Texture.from(canvas);
    this.miniTex.source.scaleMode = 'nearest';
    this.miniTexMap = map;
    this.radarMap.texture = this.miniTex;
    this.bigMap.texture = this.miniTex;
    this.fogBuilt = this.riftLayer.fogKey;
  }

  /**
   * v0.3 mark-and-sweep of the shared ship GraphicsContexts (re-entrant: every matchStart / floorStart).
   * Pooled displays and afterimages drop their contexts first; contexts on live displays are marked and kept.
   */
  private sweepShipCaches(): void {
    for (const d of this.shipPool) { d.hull.context = EMPTY_CTX; d.aux.context = EMPTY_CTX; d.key = ''; }
    for (const gh of this.ghosts) { this.ghostLayer.removeChild(gh.g); this.ghostFree.push(gh.g); }
    this.ghosts.length = 0;
    for (const g of this.ghostFree) g.context = EMPTY_CTX;
    const keep = new Set<GraphicsContext>();
    for (const d of this.ships.values()) { keep.add(d.hull.context); keep.add(d.aux.context); }
    sweepShipCaches(keep);
  }

  private initCosmeticHosts(): void {
    this.lootHost = {
      inView: (x, y, m) => this.inView(x, y, m),
      playerColor: (frame, pid) => this.playerColor(frame, pid),
      shipAnchor: (id) => {
        const d = this.ships.get(id), s = this.shipById.get(id);
        if (!d || !s || !s.alive) return null;
        const a = this.anchor;
        a.x = d.x; a.y = d.y; a.r = this.shipRadius(s) * (s.attachedTo ? 0.8 : 1);
        a.alpha = d.alpha; a.ally = d.ally; a.cloaked = (s.flags & SHIPFLAG_CLOAKED) !== 0;
        return a;
      },
      shipOfPlayer: (pid) => this.shipByPlayer.get(pid)?.id ?? 0,
      ring: (x, y, r0, r1, life, color, width, follow = 0) => this.ring(x, y, r0, r1, life, color, width, follow),
      burst: (x, y, n, color, spMin, spMax, life, scale, dots) =>
        this.burst(x, y, n, color, spMin, spMax, life, scale, dots ? { tex: this.atlas.dot, flags: 0, drag: 3 } : {}),
      flash: (x, y, size, color, life, alpha) => this.flash(x, y, size, color, life, alpha),
      impulse: (x, y, r, s) => this.grid?.impulse(x, y, r, s),
    };
    this.deathHost = {
      ring: (x, y, r0, r1, life, color, width) => this.ring(x, y, r0, r1, life, color, width),
      flash: (x, y, size, color, life, alpha) => this.flash(x, y, size, color, life, alpha),
    };
  }

  private initObjectiveHost(): void {
    this.objHost = {
      inView: (x, y, m) => this.inView(x, y, m),
      ship: (id) => {
        const d = this.ships.get(id), s = this.shipById.get(id);
        if (!d || !s || !s.alive) return null;
        const o = this.objShipOut;
        o.x = d.x; o.y = d.y; o.r = this.shipRadius(s) * (s.attachedTo ? 0.8 : 1); o.vx = s.vx; o.vy = s.vy;
        o.alpha = d.alpha; o.ally = d.ally; o.cloaked = (s.flags & SHIPFLAG_CLOAKED) !== 0;
        return o;
      },
      toScreen: (x, y, out) => { out.x = x * this.zoom + this.cam.x; out.y = y * this.zoom + this.cam.y; },
      screenW: () => this.sw,
      screenH: () => this.sh,
      avoidRect: () => {
        if (this.bigOpen || !this.map) return null;
        const r = this.radarRect;
        r.x = this.radarX - 6; r.y = this.radarY - 6; r.w = this.radarSize + 12; r.h = this.radarSize + 12;
        return r;
      },
      label: (key, space, text, x, y, color, alpha, size) => this.objLabel(key, space, text, x, y, color, alpha, size),
      ring: (x, y, r0, r1, life, color, width, follow = 0) => this.ring(x, y, r0, r1, life, color, width, follow),
      burst: (x, y, n, color, spMin, spMax, life, scale, dots) =>
        this.burst(x, y, n, color, spMin, spMax, life, scale, dots ? { tex: this.atlas.dot, flags: 0, drag: 3 } : {}),
      flash: (x, y, size, color, life, alpha) => this.flash(x, y, size, color, life, alpha),
      impulse: (x, y, r, s) => this.grid?.impulse(x, y, r, s),
      tint: (color, a, decay) => this.pulseTint(color, a, decay),
    };
  }

  private initRiftHost(): void {
    this.riftHost = {
      inView: (x, y, m) => this.inView(x, y, m),
      ship: (id) => this.objHost.ship(id),
      shipOfPlayer: (pid) => this.shipByPlayer.get(pid)?.id ?? 0,
      label: (key, space, text, x, y, color, alpha, size) => this.objLabel(key, space, text, x, y, color, alpha, size),
      ring: (x, y, r0, r1, life, color, width, follow = 0) => this.ring(x, y, r0, r1, life, color, width, follow),
      burst: (x, y, n, color, spMin, spMax, life, scale, dots) =>
        this.burst(x, y, n, color, spMin, spMax, life, scale, dots ? { tex: this.atlas.dot, flags: 0, drag: 3 } : {}),
      flash: (x, y, size, color, life, alpha) => this.flash(x, y, size, color, life, alpha),
      impulse: (x, y, r, s) => this.grid?.impulse(x, y, r, s),
      tint: (color, a, decay) => this.pulseTint(color, a, decay),
      shake: (amount, x, y) => this.addShake(amount, x, y),
      shock: (x, y) => this.startShock(x, y),
      spark: (x, y, vx, vy, life, color, scale) => {
        if (Math.random() > this.density) return;
        this.fx.spawn({ tex: this.atlas.dot, x, y, vx, vy, life, color, s0: scale, s1: 0, alpha: 0.9, drag: 0.5 });
      },
    };
  }

  /** Pooled objective label (zone letters in world px under the ships; pointer letters in screen px). */
  private objLabel(key: string, space: 'world' | 'screen', str: string, x: number, y: number, color: number, alpha: number, size: number): void {
    const pool = space === 'world' ? this.objLabelsW : this.objLabelsS;
    let L = pool.get(key);
    if (!L) {
      const text = new Text({
        text: str,
        style: { fontFamily: 'Consolas, "Courier New", monospace', fontSize: 32, fill: 0xffffff, fontWeight: '700', letterSpacing: 2 },
        resolution: 2,
      });
      text.anchor.set(0.5);
      (space === 'world' ? this.objLabelLayer : this.edgeLabels).addChild(text);
      L = { text, seen: 0, str };
      pool.set(key, L);
    }
    if (L.str !== str) { L.text.text = str; L.str = str; }
    L.seen = this.frameNo;
    const tx = L.text;
    tx.visible = true;
    tx.position.set(x, y);
    tx.tint = color;
    tx.alpha = alpha;
    tx.scale.set(size / 32);
  }

  private sweepObjLabels(): void {
    for (const L of this.objLabelsW.values()) if (L.seen !== this.frameNo) L.text.visible = false;
    for (const L of this.objLabelsS.values()) if (L.seen !== this.frameNo) L.text.visible = false;
  }

  setBigMap(open: boolean): void {
    this.bigOpen = open;
    this.bigRoot.visible = open;
  }

  setScreenShake(amount: number): void {
    this.shakeAmt = clamp(amount, 0, 1);
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.cam.x) / this.zoom, y: (sy - this.cam.y) / this.zoom };
  }

  destroy(): void {
    if (!this.ready) return;
    this.ready = false;
    beamBus.count = 0;
    for (const q of this.staleTex) q.tex.destroy(true);
    this.staleTex.length = 0;
    this.app.destroy({ removeView: true }, { children: true, texture: true });
  }

  /** Dev-harness only: extra zoom-in factor (≥ 1) for inspecting details. */
  debugZoom = 1;

  /** Current quality tier (2 high, 1 medium, 0 low) — exposed for debug overlays. */
  get qualityLevel(): number { return this.quality; }

  // =============================================================================================
  render(frame: RenderFrame): void {
    if (!this.ready) return;
    this.frameNo++;
    const now = performance.now();
    const realDt = this.lastNow ? Math.min(0.1, (now - this.lastNow) / 1000) : 1 / 60;
    this.lastNow = now;
    this.updateQuality(realDt);
    const dt = clamp(frame.dt || realDt, 0, 0.1);
    const t = frame.time;
    this.now = t;
    this.layout();

    // lookups
    this.shipById.clear(); this.shipByPlayer.clear();
    for (const s of frame.ships) { this.shipById.set(s.id, s); if (s.alive) this.shipByPlayer.set(s.playerId, s); }
    this.looks.update(frame.players);

    this.updateShipPositions(frame, dt);
    this.updateCamera(frame, dt);

    // v0.3 M4 rift: view + room states + transition FX first (the frame's rift events then only add their own FX)
    const rf0 = performance.now();
    this.riftLayer.begin(frame, t, this.riftHost);
    if (this.riftLayer.fogKey !== this.fogBuilt) this.rebuildMinimap();
    let rfMs = performance.now() - rf0;

    for (const ev of frame.events) this.handleEvent(ev, frame);

    const v = this.view;
    // background
    for (let i = 0; i < this.stars.length; i++) {
      const s = this.stars[i];
      const f = [0.04, 0.1, 0.2][i];
      s.tilePosition.set(-this.camX * f * this.zoom + this.shakeX * 0.3, -this.camY * f * this.zoom + this.shakeY * 0.3);
      s.alpha = [0.55, 0.75, 0.9][i];
    }
    this.gridG.clear();
    if (this.grid) {
      for (const s of frame.ships) {
        if (!s.alive || s.x < v.x0 || s.x > v.x1 || s.y < v.y0 || s.y > v.y1) continue;
        const sp = Math.hypot(s.vx, s.vy);
        const charging = (s.flags & SHIPFLAG_CHARGING) !== 0;
        if (sp > 60) this.grid.impulse(s.x, s.y, charging ? 110 : 70, Math.min(sp, charging ? 1600 : 800) * (charging ? 1.1 : 0.9) * dt);
      }
      for (const e of frame.enemies) {
        if (e.kind === 'blackhole') this.grid.impulse(e.x, e.y, e.radius * 6, -e.radius * 5 * dt);
        else if (e.kind === 'hive') this.grid.impulse(e.x, e.y, e.radius * 2, 120 * dt);
      }
      for (const d of frame.deployables) {
        if (d.kind === 'well') this.grid.impulse(d.x, d.y, d.radius * 1.1, -d.radius * 1.4 * dt);
      }
      this.grid.step(dt, v.x0 - 200, v.y0 - 200, v.x1 + 200, v.y1 + 200);
      this.grid.draw(this.gridG, v.x0 - 64, v.y0 - 64, v.x1 + 64, v.y1 + 64);
    }
    for (const c of this.chunks) {
      c.g.visible = c.x < v.x1 && c.x + c.w > v.x0 && c.y < v.y1 && c.y + c.h > v.y0;
    }

    this.dynG.clear();
    this.darkG.clear();
    this.overlayG.clear();
    beamBus.count = 0;
    // v0.3 M3 objective layer: pads / stands / hot point now; carriers after drawShips (fresh root alpha)
    const ob0 = performance.now();
    this.objPadG.clear(); this.objAddG.clear(); this.edgeG.clear();
    this.objLayer.begin(frame);
    beamBus.localTeam = this.objLayer.side.team;
    beamBus.localPid = this.objLayer.side.pid;
    this.objLayer.drawWorld(frame, t, this.objPadG, this.objAddG, this.objHost);
    let obMs = performance.now() - ob0;
    const rf1 = performance.now();
    this.riftPadG.clear(); this.riftAddG.clear();
    this.riftLayer.drawWorld(frame, t, this.riftPadG, this.riftAddG, this.riftHost);
    rfMs += performance.now() - rf1;
    this.drawGems(frame, t);
    this.lootLayer.draw(frame, t, this.dynG, this.lootHost);
    this.drawDeployables(frame, t, dt);
    this.drawEnemies(frame, t, dt);
    this.drawProjectiles(frame, t);
    this.drawShips(frame, t);
    const ob1 = performance.now();
    this.objLayer.drawCarriers(frame, t, this.objAddG, this.objHost);
    this.objLayer.end();
    this.objLayer.drawPointers(frame, t, this.edgeG, this.objHost);
    obMs += performance.now() - ob1;
    this.objMs += (obMs - this.objMs) * 0.05;
    this.lootLayer.drawCarriers(frame, t, this.dynG, this.lootHost);
    const rf2 = performance.now();
    this.riftLayer.drawShipFx(frame, t, this.riftAddG, this.riftHost);
    this.riftLayer.end();
    this.drawVignette(frame, t, dt);
    rfMs += performance.now() - rf2;
    this.riftMsEma += (rfMs - this.riftMsEma) * 0.05;
    this.drawTethers(t, dt);
    this.drawFx(dt);
    this.updateGhosts(dt);
    this.updateNums(dt);
    this.drawReticle(frame, t);
    const ls = this.ships.get(frame.localShipId);
    beamBus.listenerX = ls ? ls.x : frame.focusX;
    beamBus.listenerY = ls ? ls.y : frame.focusY;
    beamBus.stamp = now;

    this.trails.update(dt);
    this.fx.update(dt);

    // screen tint
    this.screenFx.clear();
    if (this.tint.a > 0.003) {
      this.screenFx.rect(0, 0, this.sw, this.sh).fill({ color: this.tint.color, alpha: this.tint.a });
      this.tint.a = Math.max(0, this.tint.a - dt * this.tint.decay);
    }

    // shockwave filter
    if (this.shockOn) {
      this.shock.time += dt;
      if (this.shock.time > 1.1) { this.shockOn = false; this.worldRoot.filters = [this.bloom]; }
    }

    this.drawRadar(frame);
    this.sweepObjLabels();
    this.app.renderer.render(this.app.stage);
    // v0.3 M4: a replaced minimap texture (setMap) is kept a while before it is destroyed: bind groups of sprites
    // that were not re-rendered since (the hidden big map) still reference it
    if (this.staleTex.length) {
      let w = 0;
      const nowMs = performance.now();
      for (const q of this.staleTex) {
        if (this.frameNo - q.at >= STALE_TEX_FRAMES && nowMs - q.ms >= STALE_TEX_MS) q.tex.destroy(true);
        else this.staleTex[w++] = q;
      }
      this.staleTex.length = w;
    }
  }

  /** Sealed-room vignette: eased toward the state of the room holding the viewer's focus (local ship, else camera). */
  private drawVignette(frame: RenderFrame, t: number, dt: number): void {
    let x = frame.focusX, y = frame.focusY;
    const ls = this.shipById.get(frame.localShipId), ld = this.ships.get(frame.localShipId);
    if (ls && ls.alive && ld) { x = ld.x; y = ld.y; }
    const want = this.riftLayer.active ? vignetteFor(this.riftLayer.stateAt(x, y), t) : { color: 0, alpha: 0 };
    if (want.alpha > 0) this.vigColor = want.color;
    this.vigA += (want.alpha - this.vigA) * Math.min(1, dt * 6);
    const v = this.vignette;
    v.visible = this.vigA > 0.01;
    if (!v.visible) return;
    v.position.set(0, 0);
    v.width = this.sw; v.height = this.sh;
    v.tint = this.vigColor;
    v.alpha = this.vigA;
  }

  // =============================================================================================
  // layout / quality

  private layout(): void {
    const w = this.app.screen.width, h = this.app.screen.height;
    if (w === this.sw && h === this.sh) return;
    this.sw = w; this.sh = h;
    for (const s of this.stars) { s.width = w; s.height = h; }
    this.worldRoot.filterArea = new Rectangle(0, 0, w, h);
    this.layoutHud();
  }

  private radarSize = 200; private radarX = 0; private radarY = 0;
  private bigSize = 600; private bigX = 0; private bigY = 0;

  private layoutHud(): void {
    const w = this.sw, h = this.sh;
    if (!w) return;
    this.radarSize = Math.round(clamp(Math.min(w, h) * 0.22, 140, 240));
    this.radarX = w - this.radarSize - 16;
    this.radarY = h - this.radarSize - 16;
    const rs = this.radarSize;
    this.radarBg.clear()
      .roundRect(this.radarX - 6, this.radarY - 6, rs + 12, rs + 12, 8).fill({ color: 0x07041a, alpha: 0.78 })
      .roundRect(this.radarX - 6, this.radarY - 6, rs + 12, rs + 12, 8).stroke({ width: 1.5, color: 0x6a4bff, alpha: 0.8 });
    this.radarMap.position.set(this.radarX, this.radarY);
    this.radarMap.width = rs; this.radarMap.height = rs;

    this.bigSize = Math.round(Math.min(w, h) * 0.82);
    this.bigX = Math.round((w - this.bigSize) / 2);
    this.bigY = Math.round((h - this.bigSize) / 2);
    this.bigBg.clear()
      .rect(0, 0, w, h).fill({ color: 0x000000, alpha: 0.55 })
      .roundRect(this.bigX - 10, this.bigY - 10, this.bigSize + 20, this.bigSize + 20, 12).fill({ color: 0x07041a, alpha: 0.9 })
      .roundRect(this.bigX - 10, this.bigY - 10, this.bigSize + 20, this.bigSize + 20, 12).stroke({ width: 2, color: 0x3bf2ff, alpha: 0.7 });
    this.bigMap.position.set(this.bigX, this.bigY);
    this.bigMap.width = this.bigSize; this.bigMap.height = this.bigSize;
  }

  private updateQuality(realDt: number): void {
    this.emaMs += (realDt * 1000 - this.emaMs) * 0.05;
    if (this.emaMs > 22) this.slowFor += realDt; else this.slowFor = Math.max(0, this.slowFor - realDt * 0.5);
    if (this.slowFor > 2 && this.quality > 0) {
      this.quality--;
      this.slowFor = 0;
      this.emaMs = 16;
      const res = this.app.renderer.resolution;
      if (this.quality === 1) {
        this.bloom.resolution = Math.max(0.5, res * 0.5);
        this.bloom.quality = 3;
        this.bloom.antialias = 'off';
        this.grid?.setSpacing(96);
      } else {
        this.bloom.resolution = Math.max(0.5, res * 0.5);
        this.bloom.quality = 2;
        this.bloom.blur = 5;
        this.grid?.setSpacing(128);
      }
    }
    const base = [0.35, 0.65, 1][this.quality];
    const load = this.fx.count > 2800 ? 0.4 : this.fx.count > 2000 ? 0.7 : 1;
    this.density = base * load;
  }

  // =============================================================================================
  // camera

  private updateCamera(frame: RenderFrame, dt: number): void {
    const w = this.sw || 1, h = this.sh || 1;
    const halfW = clamp(w * 0.55, 640, 1100);
    let zoom = w / 2 / halfW;
    zoom = Math.max(zoom, h / 2 / MAX_VIEW_HALF_EXTENT, w / 2 / MAX_VIEW_HALF_EXTENT) * Math.max(1, this.debugZoom);
    this.zoom = zoom;

    let tx = frame.focusX, ty = frame.focusY;
    if (frame.localShipId) {
      tx += clamp((frame.aimX - frame.focusX) * 0.16, -180, 180);
      ty += clamp((frame.aimY - frame.focusY) * 0.16, -130, 130);
    }
    if (!this.camInit || Math.hypot(tx - this.camX, ty - this.camY) > 900) {
      this.camX = tx; this.camY = ty; this.camInit = true;
    } else {
      const k = 1 - Math.exp(-dt * 7);
      this.camX += (tx - this.camX) * k;
      this.camY += (ty - this.camY) * k;
    }
    this.trauma = Math.max(0, this.trauma - dt * 1.5);
    const mag = this.trauma * this.trauma * 26 * this.shakeAmt;
    this.shakeX = mag ? rand(-mag, mag) : 0;
    this.shakeY = mag ? rand(-mag, mag) : 0;

    this.cam.scale.set(zoom);
    this.cam.position.set(w / 2 - this.camX * zoom + this.shakeX, h / 2 - this.camY * zoom + this.shakeY);
    this.overlay.scale.set(zoom);
    this.overlay.position.copyFrom(this.cam.position);

    const hw = w / 2 / zoom + 40, hh = h / 2 / zoom + 40;
    this.view.x0 = this.camX - hw; this.view.x1 = this.camX + hw;
    this.view.y0 = this.camY - hh; this.view.y1 = this.camY + hh;
  }

  private addShake(amount: number, x: number, y: number): void {
    const d = Math.hypot(x - this.camX, y - this.camY);
    const f = Math.max(0, 1 - d / 1300);
    this.trauma = Math.min(1, this.trauma + amount * f);
  }

  private inView(x: number, y: number, m = 0): boolean {
    const v = this.view;
    return x > v.x0 - m && x < v.x1 + m && y > v.y0 - m && y < v.y1 + m;
  }

  // =============================================================================================
  // ships

  private shipColor(s: ShipView): number { return colorFor(s.team, s.playerId); }

  private accentOf(s: ShipView, fallback: number): number {
    const p = s.pathIdx >= 0 ? SHIP_CLASSES[s.shipClass].paths[s.pathIdx] : undefined;
    return p ? p.accent : fallback;
  }

  private playerColor(frame: RenderFrame, pid: PlayerId): number {
    const s = this.shipByPlayer.get(pid);
    if (s) return this.shipColor(s);
    const p = frame.players.get(pid);
    return p ? colorFor(p.team, pid) : 0xffffff;
  }

  private shipRadius(s: ShipView): number { return SHIP_CLASSES[s.shipClass].base.radius; }

  private getShipDisp(id: EntityId): ShipDisp {
    let d = this.ships.get(id);
    if (d) return d;
    d = this.shipPool.pop();
    if (!d) {
      const root = new Container();
      const glow = new Sprite(this.atlas.soft); glow.anchor.set(0.5); glow.blendMode = 'add';
      const flame = new Sprite(this.atlas.streak); flame.anchor.set(0.95, 0.5); flame.blendMode = 'add';
      const flame2 = new Sprite(this.atlas.streak); flame2.anchor.set(0.95, 0.5); flame2.blendMode = 'add'; flame2.visible = false;
      const hull = new Graphics();
      const aux = new Graphics();
      root.addChild(glow, flame, flame2, hull, aux);
      d = {
        root, glow, flame, flame2, hull, aux, key: '', x: 0, y: 0, pvx: 0, pvy: 0, ax: 0, ay: 0, thrustA: 0, hostR: 0, ghostT: 0,
        label: null, labelStr: '', seen: 0, title: null, titleStr: '', alpha: 1, ally: false,
      };
    }
    d.ax = d.ay = 0; d.pvx = d.pvy = 0; d.key = ''; d.labelStr = ''; d.hostR = 0; d.ghostT = 0; d.alpha = 1; d.ally = false;
    this.shipLayer.addChild(d.root);
    this.ships.set(id, d);
    return d;
  }

  private updateShipPositions(frame: RenderFrame, dt: number): void {
    for (const s of frame.ships) {
      if (!s.alive) continue;
      const d = this.getShipDisp(s.id);
      d.seen = this.frameNo;
      if (s.attachedTo === 0) { d.x = s.x; d.y = s.y; }
      if (dt > 0) {
        const k = 0.18;
        d.ax += ((s.vx - d.pvx) / dt - d.ax) * k;
        d.ay += ((s.vy - d.pvy) / dt - d.ay) * k;
      }
      d.pvx = s.vx; d.pvy = s.vy;
      const am = d.ax * d.ax + d.ay * d.ay;
      if (am > 250 * 250) d.thrustA = Math.atan2(d.ay, d.ax);
      else if (s.vx * s.vx + s.vy * s.vy > 50 * 50) d.thrustA = Math.atan2(s.vy, s.vx);
      else d.thrustA = s.angle;
    }
    // turrets: render at interpolated host position + frozen offset formula (prevents jitter).
    // Host radius can grow with talents (Titan), so estimate it from the snapshot separation.
    for (const s of frame.ships) {
      if (!s.alive || s.attachedTo === 0) continue;
      const d = this.ships.get(s.id)!;
      const host = this.shipById.get(s.attachedTo);
      const hd = this.ships.get(s.attachedTo);
      if (host && hd && host.alive) {
        const base = this.shipRadius(host);
        const est = clamp(Math.hypot(s.x - host.x, s.y - host.y) - 12, base * 0.9, base * 1.6);
        hd.hostR = hd.hostR ? hd.hostR + (est - hd.hostR) * 0.1 : est;
        const o = turretOffset(host.angle, s.turretSlot, s.turretCount, hd.hostR);
        d.x = hd.x + o.dx; d.y = hd.y + o.dy;
      } else { d.x = s.x; d.y = s.y; }
    }
    for (const [id, d] of this.ships) {
      if (d.seen === this.frameNo) continue;
      this.shipLayer.removeChild(d.root);
      if (d.label) d.label.visible = false;
      if (d.title) d.title.visible = false;
      this.ships.delete(id);
      this.shipPool.push(d);
    }
  }

  private drawShips(frame: RenderFrame, t: number): void {
    const local = this.shipById.get(frame.localShipId);
    const localTeam: TeamId = local ? local.team : (frame.players.get(frame.localPlayerId)?.team ?? -99);
    const g = this.dynG, o = this.overlayG;
    for (const s of frame.ships) {
      if (!s.alive) continue;
      const d = this.ships.get(s.id)!;
      const isLocal = s.id === frame.localShipId;
      const ally = isLocal || (s.team >= 0 && s.team === localTeam && s.team !== ENEMY_TEAM);
      let alpha = 1;
      if (s.flags & SHIPFLAG_CLOAKED) alpha = ally ? 0.3 + 0.08 * Math.sin(t * 9 + s.id) : 0.14 + 0.1 * Math.sin(t * 13 + s.id);
      if (s.flags & SHIPFLAG_INVULN) alpha *= Math.floor(t * 10) % 2 ? 0.35 : 1;
      d.alpha = alpha; d.ally = ally;
      // Root-alpha rule (v0.3): cosmetic layers are multiplied by `alpha`, and nothing is emitted for a
      // non-ally below 0.2, so cloak and the invulnerability blink are never weakened.
      const fxOk = ally || alpha >= 0.2;
      const visible = this.inView(d.x, d.y, 80 + Math.max(0, s.beamLen));
      d.root.visible = visible;
      if (d.label) d.label.visible = false;
      if (d.title) d.title.visible = false;
      if (!visible) continue;
      const r = this.shipRadius(s);
      const color = this.shipColor(s);
      const accent = this.accentOf(s, color);
      const turret = s.attachedTo !== 0;
      const sc = turret ? 0.8 : 1;
      const look = this.looks.get(s.playerId);
      const hullLook = hullFor(look, s.shipClass);
      const tLook = turret ? turretFor(look, s.shipClass) : null;
      const key = `${s.shipClass}|${color}|${s.pathIdx}|${turret ? 1 : 0}|${hullLook ? hullLook.id : ''}|${tLook ? tLook.id : ''}`;
      if (d.key !== key) {
        d.hull.context = shipHull(s.shipClass, color, r, s.pathIdx, accent, turret, hullLook, tLook);
        const nodeColor = s.shipClass === 'tech' && s.pathIdx === 0 ? accent : s.shipClass === 'engineer' ? 0xff4040 : color;
        const aux = shipAux(s.shipClass, color, r, nodeColor);
        d.aux.visible = !!aux;
        if (aux) d.aux.context = aux;
        d.key = key;
      }
      d.root.position.set(d.x, d.y);
      d.hull.rotation = s.angle;
      d.hull.scale.set(sc);
      if (d.aux.visible) {
        d.aux.rotation = s.angle;
        if (s.shipClass === 'tech') d.aux.scale.set(sc, sc * (1 + 0.08 * Math.sin(t * 3 + s.id)));
        else { d.aux.scale.set(sc); d.aux.alpha = Math.floor(t * 2 + s.id) % 2 ? 1 : 0.25; }
      }
      const charging = (s.flags & SHIPFLAG_CHARGING) !== 0;
      d.root.alpha = alpha;

      // ambient glow
      d.glow.tint = charging ? mix(accent, 0xffa030, 0.5) : color;
      d.glow.alpha = charging ? 0.6 + 0.2 * Math.sin(t * 30) : 0.22;
      d.glow.scale.set((r / 32) * (charging ? 3.4 : 2.3) * sc);

      // thruster (engine cosmetic: flame tint / twin / wide + particle preset)
      const thr = (s.flags & SHIPFLAG_THRUSTING) !== 0 && !turret;
      const ab = (s.flags & SHIPFLAG_AFTERBURNER) !== 0;
      d.flame.visible = thr;
      d.flame2.visible = false;
      if (thr) {
        const eng = look.engine;
        const fl = (ab ? 1.5 : 0.85) * (0.8 + Math.random() * 0.35);
        const wide = eng.flame === 'wide', twin = eng.flame === 'twin';
        const bx = -Math.cos(d.thrustA) * r * 0.7, by = -Math.sin(d.thrustA) * r * 0.7;
        const fx = fl * (r / 20) * (wide ? 0.9 : 1), fy = (ab ? 0.9 : 0.6) * (r / 20) * (wide ? 1.5 : twin ? 0.62 : 1);
        const ft = engineFlameTint(color, eng, ab);
        if (twin) {
          const px = -Math.sin(d.thrustA) * r * 0.3, py = Math.cos(d.thrustA) * r * 0.3;
          poseFlame(d.flame, bx + px, by + py, d.thrustA, fx, fy, ft);
          poseFlame(d.flame2, bx - px, by - py, d.thrustA, fx, fy, ft);
        } else poseFlame(d.flame, bx, by, d.thrustA, fx, fy, ft);
        if (fxOk) {
          emitEngine(this.trails, this.atlas, eng, look.engineAccent, {
            x: d.x, y: d.y, dir: d.thrustA, vx: s.vx, vy: s.vy, r, ab, team: color, alpha, density: this.density, time: t,
          });
        }
      }

      // path flourishes
      if (fxOk && s.shipClass === 'tech' && s.pathIdx === 0 && Math.random() < 0.25 * this.density) {
        const [nx, ny] = TECH_NODES[(Math.random() * 4) | 0];
        const ca = Math.cos(s.angle), sa = Math.sin(s.angle);
        const px = d.x + (nx * ca - ny * sa) * r * sc, py = d.y + (nx * sa + ny * ca) * r * sc;
        this.fx.spawn({ tex: this.atlas.dot, x: px, y: py, vx: rand(-60, 60), vy: rand(-60, 60), life: 0.12, color: brighten(accent, 0.4), s0: 0.35, s1: 0 });
        if (Math.random() < 0.3) this.lines.push({ pts: [px, py, d.x + rand(-4, 4), d.y + rand(-4, 4)], t: 0, life: 0.06, color: accent, width: 1.2 });
      }
      if (fxOk && s.shipClass === 'tech' && s.pathIdx === 1 && Math.random() < 0.3 * this.density) {
        const a = rand(0, TAU), rr = r * 1.6;
        this.fx.spawn({ tex: this.atlas.dot, x: d.x + Math.cos(a) * rr, y: d.y + Math.sin(a) * rr, vx: -Math.cos(a) * rr * 3, vy: -Math.sin(a) * rr * 3,
          life: 0.3, color: VOID_COLOR, s0: 0.3, s1: 0.05, alpha: 0.8 });
      }

      // Ram Charge: shockwave cone + motion-blur afterimages + streaks
      if (charging) this.drawCharge(s, d, r, accent, t);

      // Iron Hide shell (any absorb shield)
      if (s.flags & SHIPFLAG_SHIELD) this.drawIronHide(d, r * sc, t, alpha);

      // local highlight ring (dashed, rotating)
      if (isLocal) {
        const rr = r * sc + 18;
        for (let i = 0; i < 4; i++) {
          const a0 = t * 0.9 + (i * TAU) / 4;
          g.moveTo(d.x + Math.cos(a0) * rr, d.y + Math.sin(a0) * rr).arc(d.x, d.y, rr, a0, a0 + 0.9);
        }
        g.stroke({ width: 1.3, color: brighten(color, 0.5), alpha: 0.4 });
      }

      // turret tether + docking clamp (turret cosmetic: line / dashed / lightning)
      if (turret) {
        const hd = this.ships.get(s.attachedTo);
        if (hd && fxOk) this.drawTetherLink(hd, d, s, color, r * sc, t, alpha, tLook);
      } else if (s.turretCount > 0) {
        for (let i = 0; i < s.turretCount; i++) {
          o.circle(d.x + r + 10, d.y - r - 8 - i * 5, 3.2).stroke({ width: 1.2, color, alpha: 0.9 });
        }
      }

      // beams
      if (s.beamLen > 0) this.drawBeam(s, d, r * sc, t, tLook, alpha);

      // orbit blades
      if (s.orbitals > 0) {
        const base = (ORBIT_SPEED * frame.renderTick) / TICK_RATE;
        const bc = brighten(color, 0.45);
        for (let i = 0; i < s.orbitals; i++) {
          const a = base + (i * TAU) / s.orbitals;
          const bx = d.x + Math.cos(a) * ORBIT_RADIUS, by = d.y + Math.sin(a) * ORBIT_RADIUS;
          const ta = a + Math.PI / 2;
          const cx = Math.cos(ta), sx = Math.sin(ta), nx = Math.cos(a), ny = Math.sin(a);
          g.poly([bx + cx * 11, by + sx * 11, bx + nx * 4, by + ny * 4, bx - cx * 9, by - sx * 9, bx - nx * 4, by - ny * 4], true)
            .fill({ color: bc, alpha: 0.35 }).stroke({ width: 1.6, color: bc, alpha: 1 });
          if (Math.random() < 0.3 * this.density) {
            this.trails.spawn({ tex: this.atlas.dot, x: bx, y: by, life: 0.25, color, s0: 0.35, s1: 0, alpha: 0.7 });
          }
        }
        g.circle(d.x, d.y, ORBIT_RADIUS).stroke({ width: 1, color, alpha: 0.08 });
      }

      // energy arc (overlay, not bloomed) — skipped on other players' turrets to reduce stack clutter
      const ef = clamp(s.energyFrac, 0, 1);
      if (!turret || isLocal) {
      const er = r * sc + 7;
      const a0 = Math.PI * 0.2, span = Math.PI * 0.6;
      o.moveTo(d.x + Math.cos(a0) * er, d.y + Math.sin(a0) * er).arc(d.x, d.y, er, a0, a0 + span)
        .stroke({ width: 2.4, color: 0x000000, alpha: 0.35 * alpha });
      if (ef > 0.01) {
        const aa = a0 + span * (1 - ef);
        o.moveTo(d.x + Math.cos(aa) * er, d.y + Math.sin(aa) * er).arc(d.x, d.y, er, aa, a0 + span)
          .stroke({ width: 2, color: energyColor(ef), alpha: 0.85 * Math.max(alpha, 0.3) });
      }
      }

      if (s.id === frame.attachCandidateId) {
        const b = r + 14 + Math.sin(t * 8) * 3, L = 7;
        o.moveTo(d.x - b, d.y - b + L).lineTo(d.x - b, d.y - b).lineTo(d.x - b + L, d.y - b)
          .moveTo(d.x + b - L, d.y - b).lineTo(d.x + b, d.y - b).lineTo(d.x + b, d.y - b + L)
          .moveTo(d.x + b, d.y + b - L).lineTo(d.x + b, d.y + b).lineTo(d.x + b - L, d.y + b)
          .moveTo(d.x - b + L, d.y + b).lineTo(d.x - b, d.y + b).lineTo(d.x - b, d.y + b - L)
          .stroke({ width: 2, color: 0x6bff9a, alpha: 0.9 });
      }

      if (!isLocal && alpha > 0.1 && !turret) {
        const info = frame.players.get(s.playerId);
        const str = `${info?.name ?? 'Pilot ' + s.playerId}  ${s.level}`;
        if (!d.label) {
          d.label = new Text({
            text: str,
            style: { fontFamily: 'Consolas, "Courier New", monospace', fontSize: 12, fill: 0xffffff, fontWeight: '600' },
            resolution: 2,
          });
          d.label.anchor.set(0.5, 0);
          this.labelLayer.addChild(d.label);
        }
        if (d.labelStr !== str) { d.label.text = str; d.labelStr = str; }
        d.label.tint = brighten(color, 0.35);
        d.label.visible = true;
        d.label.alpha = Math.min(1, alpha + 0.2) * 0.9;
        d.label.position.set(d.x, d.y + r + 12);
        const ls = 1 / Math.max(0.75, this.zoom);
        d.label.scale.set(ls);
        // v0.3 title (cosmetic): pooled Text under the nameplate, multiplied by the root alpha
        const tt = look.titleText;
        if (tt && look.title && fxOk) {
          if (!d.title) {
            d.title = new Text({
              text: tt,
              style: { fontFamily: 'Consolas, "Courier New", monospace', fontSize: 10, fill: 0xffffff, fontWeight: '600', letterSpacing: 1 },
              resolution: 2,
            });
            d.title.anchor.set(0.5, 0);
            this.labelLayer.addChild(d.title);
          }
          if (d.titleStr !== tt) { d.title.text = tt; d.titleStr = tt; }
          d.title.tint = look.title.color;
          d.title.visible = true;
          d.title.alpha = alpha * 0.85;
          d.title.position.set(d.x, d.y + r + 12 + 14 * ls);
          d.title.scale.set(ls);
        }
      }
    }
  }

  /** Turret → host link. Style from the turret's cosmetic (line / dashed / lightning); team colour, × root alpha. */
  private drawTetherLink(hd: ShipDisp, d: ShipDisp, s: ShipView, color: number, rr: number, t: number, alpha: number, look: TurretLook | null): void {
    const g = this.dynG;
    const pulse = 0.5 + 0.5 * Math.sin(t * 10 + s.turretSlot);
    const style = look ? look.p.tether : 'line';
    const hx = hd.x, hy = hd.y, tx = d.x, ty = d.y;
    const dx = tx - hx, dy = ty - hy, len = Math.hypot(dx, dy) || 1;
    if (style === 'dashed') {
      const ux = dx / len, uy = dy / len, dash = 6, gap = 4, off = (t * 30) % (dash + gap);
      for (let u = -off; u < len; u += dash + gap) {
        const u0 = Math.max(0, u), u1 = Math.min(len, u + dash);
        if (u1 > u0) g.moveTo(hx + ux * u0, hy + uy * u0).lineTo(hx + ux * u1, hy + uy * u1);
      }
      g.stroke({ width: 1.6, color: brighten(color, 0.6), alpha: (0.6 + 0.3 * pulse) * alpha });
    } else if (style === 'lightning') {
      const nx = -dy / len, ny = dx / len, n = Math.max(3, Math.round(len / 9));
      g.moveTo(hx, hy);
      for (let k = 1; k < n; k++) { const f = k / n, j = rand(-3.5, 3.5); g.lineTo(hx + dx * f + nx * j, hy + dy * f + ny * j); }
      g.lineTo(tx, ty);
      g.stroke({ width: 1.3, color: brighten(color, 0.6), alpha: (0.6 + 0.35 * pulse) * alpha });
    } else {
      g.moveTo(hx, hy).lineTo(tx, ty).stroke({ width: 1.2, color: brighten(color, 0.6), alpha: (0.55 + 0.3 * pulse) * alpha });
    }
    g.moveTo(hx, hy).lineTo(tx, ty).stroke({ width: 4, color, alpha: (0.12 + 0.08 * pulse) * alpha });
    g.circle((hx + tx) / 2, (hy + ty) / 2, 2.2).fill({ color: look ? look.p.accent : 0xffffff, alpha: (0.7 + 0.3 * pulse) * alpha });
    g.circle(tx, ty, rr + 4).stroke({ width: 1, color, alpha: 0.35 * alpha });
  }

  private drawCharge(s: ShipView, d: ShipDisp, r: number, accent: number, t: number): void {
    const g = this.dynG;
    const sp = Math.hypot(s.vx, s.vy);
    const a = sp > 50 ? Math.atan2(s.vy, s.vx) : s.angle;
    const ca = Math.cos(a), sa = Math.sin(a);
    const c = mix(accent, 0xffb060, 0.4);
    // shockwave cone ahead of the prow
    const R0 = r * 1.3, R1 = r * 3.1;
    const spread = 0.75;
    const pulse = 0.6 + 0.4 * Math.sin(t * 40);
    for (let k = 0; k < 3; k++) {
      const rr = R0 + (R1 - R0) * ((k / 3 + t * 4) % 1);
      g.moveTo(d.x + Math.cos(a - spread) * rr, d.y + Math.sin(a - spread) * rr).arc(d.x, d.y, rr, a - spread, a + spread)
        .stroke({ width: 3, color: c, alpha: (0.25 + 0.5 * (1 - (rr - R0) / (R1 - R0))) * pulse });
    }
    g.moveTo(d.x + Math.cos(a - spread) * R0, d.y + Math.sin(a - spread) * R0).lineTo(d.x + Math.cos(a - spread) * R1, d.y + Math.sin(a - spread) * R1)
      .moveTo(d.x + Math.cos(a + spread) * R0, d.y + Math.sin(a + spread) * R0).lineTo(d.x + Math.cos(a + spread) * R1, d.y + Math.sin(a + spread) * R1)
      .stroke({ width: 1.5, color: brighten(c, 0.4), alpha: 0.5 });
    // motion-blur afterimages
    d.ghostT -= 1;
    if (d.ghostT <= 0) {
      d.ghostT = 2;
      this.spawnGhost(d.hull.context, d.x, d.y, s.angle, d.hull.scale.x, 0.22, 0.55, c);
    }
    // speed streaks
    const n = Math.ceil(3 * this.density);
    for (let i = 0; i < n; i++) {
      const off = rand(-r, r);
      this.trails.spawn({
        tex: this.atlas.streak, x: d.x - ca * r + -sa * off, y: d.y - sa * r + ca * off,
        vx: -ca * rand(200, 500), vy: -sa * rand(200, 500), life: 0.2, color: c, s0: 0.6, s1: 0.1,
        flags: P_ORIENT | P_STRETCH, sy: 0.3, alpha: 0.8,
      });
    }
  }

  private drawIronHide(d: ShipDisp, r: number, t: number, alpha: number): void {
    const g = this.dynG;
    const rr = r + 9;
    const rot = t * 0.6;
    for (let i = 0; i < 6; i++) {
      const a0 = rot + (i * TAU) / 6 + 0.08, a1 = a0 + TAU / 6 - 0.16;
      g.moveTo(d.x + Math.cos(a0) * rr, d.y + Math.sin(a0) * rr).arc(d.x, d.y, rr, a0, a1);
    }
    g.stroke({ width: 9, color: STEEL, alpha: 0.12 * alpha });
    for (let i = 0; i < 6; i++) {
      const a0 = rot + (i * TAU) / 6 + 0.08, a1 = a0 + TAU / 6 - 0.16;
      g.moveTo(d.x + Math.cos(a0) * rr, d.y + Math.sin(a0) * rr).arc(d.x, d.y, rr, a0, a1);
    }
    g.stroke({ width: 3.5, color: STEEL, alpha: 0.75 * alpha, cap: 'butt' });
    // rivets + moving glint
    for (let i = 0; i < 6; i++) {
      const a = rot + (i * TAU) / 6 + TAU / 12;
      g.circle(d.x + Math.cos(a) * rr, d.y + Math.sin(a) * rr, 1.4);
    }
    g.fill({ color: 0xffffff, alpha: 0.8 * alpha });
    const ga = t * 3;
    g.moveTo(d.x + Math.cos(ga) * rr, d.y + Math.sin(ga) * rr).arc(d.x, d.y, rr, ga, ga + 0.35)
      .stroke({ width: 3.5, color: 0xffffff, alpha: 0.9 * alpha });
    g.circle(d.x, d.y, rr - 4).fill({ color: SHIELD_COLOR, alpha: 0.04 });
  }

  /** Laser Lance (resonance-scaled) or Hull Weld beam. `look` adds the cosmetic fringe (never the core). */
  private drawBeam(s: ShipView, d: ShipDisp, r: number, t: number, look: TurretLook | null = null, alpha = 1): void {
    const g = this.dynG;
    if (s.beamKind === BEAM_WELD) {
      const hd = s.attachedTo ? this.ships.get(s.attachedTo) : undefined;
      const sx = d.x, sy = d.y;
      const ex = hd ? hd.x : d.x + Math.cos(s.angle) * s.beamLen;
      const ey = hd ? hd.y : d.y + Math.sin(s.angle) * s.beamLen;
      const dx = ex - sx, dy = ey - sy, len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const pts = [sx, sy];
      const seg = 5;
      for (let k = 1; k < seg; k++) {
        const f = k / seg, bow = Math.sin(f * Math.PI) * 7 * Math.sin(t * 17 + s.id), j = rand(-3, 3);
        pts.push(sx + dx * f + nx * (bow + j), sy + dy * f + ny * (bow + j));
      }
      pts.push(ex, ey);
      for (let pass = 0; pass < 2; pass++) {
        g.moveTo(pts[0], pts[1]);
        for (let k = 2; k < pts.length; k += 2) g.lineTo(pts[k], pts[k + 1]);
        if (pass === 0) g.stroke({ width: 7, color: 0x7fd8ff, alpha: 0.22 });
        else g.stroke({ width: 1.8, color: 0xeefcff, alpha: 0.95 });
      }
      if (Math.random() < 0.8 * this.density) {
        const a = rand(0, TAU), sp = rand(80, 260);
        this.fx.spawn({ tex: this.atlas.streak, x: ex, y: ey, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 60, life: 0.25,
          color: Math.random() < 0.5 ? 0xffb347 : 0xfff2c0, s0: 0.3, s1: 0, flags: P_ORIENT | P_STRETCH, sy: 0.35, drag: 1.5 });
      }
      this.fx.spawn({ tex: this.atlas.soft, x: ex, y: ey, life: 0.05, color: 0xcff4ff, s0: 0.45, s1: 0.3, alpha: 0.8 });
      publishBeam(s.id, d.x, d.y, 1, BEAM_WELD);
      return;
    }
    if (s.beamKind !== BEAM_LASER) return;
    const res = Math.max(1, s.resonance || 1);
    const p = Math.pow(LASER_RESONANCE, res - 1); // 1, 1.5, 2.25, 3.375 ...
    const heat = clamp((res - 1) / 2.5, 0, 1);
    const a = s.angle, ca = Math.cos(a), sa = Math.sin(a);
    const sx = d.x + ca * r * 1.2, sy = d.y + sa * r * 1.2;
    const ex = d.x + ca * s.beamLen, ey = d.y + sa * s.beamLen;
    const flick = 0.88 + Math.random() * 0.24;
    const outerC = mix(LASER_COLD, 0xe8c8ff, heat * 0.65);
    const midC = mix(0x6ff0ff, 0xffffff, heat * 0.55);
    const outerW = 4 * Math.pow(p, 1.15) * flick; // 4, 6.3, 10.2, 16.2 px …
    g.moveTo(sx, sy).lineTo(ex, ey).stroke({ width: outerW * 1.7, color: outerC, alpha: 0.05 + 0.05 * heat, cap: 'round' });
    g.moveTo(sx, sy).lineTo(ex, ey).stroke({ width: outerW, color: outerC, alpha: 0.16 + 0.1 * heat, cap: 'round' });
    g.moveTo(sx, sy).lineTo(ex, ey).stroke({ width: 1.8 * p * flick, color: midC, alpha: 0.7 + 0.2 * heat, cap: 'round' });
    g.moveTo(sx, sy).lineTo(ex, ey).stroke({ width: Math.max(0.8, 0.7 * Math.pow(p, 0.9)), color: 0xffffff, alpha: 0.95, cap: 'round' });
    // crackle filaments at high resonance
    if (res >= 3) {
      const nx = -sa, ny = ca;
      const len = s.beamLen - r * 1.2;
      const segs = Math.max(4, Math.round(len / 40));
      for (let strand = 0; strand < res - 2; strand++) {
        g.moveTo(sx, sy);
        for (let k = 1; k <= segs; k++) {
          const f = k / segs, j = k === segs ? 0 : rand(-1, 1) * outerW * 0.7;
          g.lineTo(sx + ca * len * f + nx * j, sy + sa * len * f + ny * j);
        }
        g.stroke({ width: 1.1, color: brighten(outerC, 0.5), alpha: 0.7 });
      }
    }
    // v0.3 cosmetic fringe (accent). The core strokes above keep their resonance width/alpha untouched.
    if (look && look.p.beam !== 'std' && (d.ally || alpha >= 0.2)) this.drawBeamFringe(look, sx, sy, ca, sa, s.beamLen - r * 1.2, outerW, res, heat, t, alpha);
    // muzzle + endpoint
    this.fx.spawn({ tex: this.atlas.soft, x: sx, y: sy, life: 0.04, color: midC, s0: 0.2 * Math.pow(p, 0.7), s1: 0.15 * Math.pow(p, 0.7), alpha: 0.7 });
    this.fx.spawn({ tex: this.atlas.soft, x: ex, y: ey, life: 0.05, color: outerC, s0: 0.35 * p, s1: 0.5 * p, alpha: 0.8 });
    const sparks = Math.ceil(res * res * 0.5 * this.density);
    for (let i = 0; i < sparks; i++) {
      const aa = a + Math.PI + rand(-1.3, 1.3), sp = rand(150, 380) * (0.8 + heat * 0.6);
      this.fx.spawn({ tex: this.atlas.streak, x: ex, y: ey, vx: Math.cos(aa) * sp, vy: Math.sin(aa) * sp, life: rand(0.1, 0.25),
        color: Math.random() < heat ? 0xffffff : midC, s0: 0.3 + 0.08 * res, s1: 0, flags: P_ORIENT | P_STRETCH, sy: 0.35, drag: 3 });
    }
    if (res >= 3 && this.grid && Math.random() < 0.2) this.grid.impulse(ex, ey, 40 * p, 16 * p);
    publishBeam(s.id, d.x, d.y, res, BEAM_LASER);
  }

  /** Beam fringe: jagged (zig-zag) / rays (ticks) / split (`resonance` parallel filaments). */
  private drawBeamFringe(look: TurretLook, sx: number, sy: number, ca: number, sa: number, len: number, outerW: number, res: number, heat: number, t: number, alpha: number): void {
    if (len <= 4) return;
    const g = this.dynG, c = look.p.accent, nx = -sa, ny = ca;
    const a = (0.4 + 0.15 * heat) * alpha;
    switch (look.p.beam) {
      case 'jagged': {
        const n = Math.max(4, Math.round(len / 26)), amp = outerW * 0.55 + 2;
        g.moveTo(sx, sy);
        for (let k = 1; k <= n; k++) {
          const f = k / n, j = k === n ? 0 : (k % 2 ? amp : -amp) * (0.7 + 0.3 * Math.random());
          g.lineTo(sx + ca * len * f + nx * j, sy + sa * len * f + ny * j);
        }
        g.stroke({ width: 1.2, color: c, alpha: a, join: 'miter' });
        break;
      }
      case 'rays': {
        const step = 34, off = (t * 160) % step, L = outerW * 0.8 + 5;
        for (let u = step - off, k = 0; u < len; u += step, k++) {
          const px = sx + ca * u, py = sy + sa * u, side = k % 2 ? 1 : -1;
          g.moveTo(px + nx * outerW * 0.4 * side, py + ny * outerW * 0.4 * side)
            .lineTo(px + nx * L * side - ca * 6, py + ny * L * side - sa * 6);
        }
        g.stroke({ width: 1.2, color: c, alpha: a, cap: 'round' });
        break;
      }
      case 'split': {
        const n = Math.max(1, Math.min(8, Math.round(res)));
        const spread = outerW * 0.6 + 2;
        for (let i = 0; i < n; i++) {
          const o = n === 1 ? spread : -spread + (2 * spread * i) / (n - 1);
          const w = Math.sin(t * 9 + i * 1.7) * 1.5;
          g.moveTo(sx + nx * (o + w), sy + ny * (o + w)).lineTo(sx + ca * len + nx * o * 0.4, sy + sa * len + ny * o * 0.4);
        }
        g.stroke({ width: 1, color: c, alpha: a });
        break;
      }
      default: break;
    }
  }

  // =============================================================================================
  // ghosts (afterimages) & floating numbers

  private spawnGhost(ctx: GraphicsContext, x: number, y: number, rot: number, scale: number, life: number, alpha: number, tint: number): void {
    if (this.ghosts.length >= 48) return;
    const g = this.ghostFree.pop() ?? new Graphics();
    g.context = ctx;
    g.position.set(x, y);
    g.rotation = rot;
    g.scale.set(scale);
    g.tint = tint;
    g.alpha = alpha;
    g.visible = true;
    this.ghostLayer.addChild(g);
    this.ghosts.push({ g, life, max: life, a0: alpha });
  }

  private updateGhosts(dt: number): void {
    let w = 0;
    for (let i = 0; i < this.ghosts.length; i++) {
      const gh = this.ghosts[i];
      gh.life -= dt;
      if (gh.life <= 0) { this.ghostLayer.removeChild(gh.g); this.ghostFree.push(gh.g); continue; }
      gh.g.alpha = gh.a0 * (gh.life / gh.max);
      this.ghosts[w++] = gh;
    }
    this.ghosts.length = w;
  }

  private floatNumber(x: number, y: number, target: EntityId, amount: number, color: number): void {
    // merge rapid heals on the same target
    for (const n of this.nums) {
      if (n.active && n.target === target && n.target !== 0 && n.life > 0.55) {
        n.amount += amount;
        n.text.text = `+${Math.round(n.amount)}`;
        n.life = Math.max(n.life, 0.8);
        return;
      }
    }
    let n = this.nums.find((q) => !q.active);
    if (!n) {
      if (this.nums.length >= 20) return;
      const text = new Text({
        text: '', resolution: 2,
        style: { fontFamily: 'Consolas, "Courier New", monospace', fontSize: 14, fontWeight: '700', fill: 0xffffff, stroke: { color: 0x02140a, width: 3 } },
      });
      text.anchor.set(0.5);
      this.labelLayer.addChild(text);
      n = { text, life: 0, x: 0, y: 0, target: 0, amount: 0, active: false };
      this.nums.push(n);
    }
    n.active = true; n.life = 0.9; n.x = x + rand(-6, 6); n.y = y - 14; n.target = target; n.amount = amount;
    n.text.text = `+${Math.round(amount)}`;
    n.text.tint = color;
    n.text.visible = true;
  }

  private updateNums(dt: number): void {
    for (const n of this.nums) {
      if (!n.active) continue;
      n.life -= dt;
      if (n.life <= 0) { n.active = false; n.text.visible = false; continue; }
      n.y -= 38 * dt;
      n.text.position.set(n.x, n.y);
      n.text.alpha = Math.min(1, n.life * 2.5);
      n.text.scale.set((1 / Math.max(0.75, this.zoom)) * (1 + Math.max(0, n.life - 0.75) * 2));
    }
  }

  // =============================================================================================
  // deployables

  private getDeployDisp(id: EntityId, dv: DeployableView): { d: DeployDisp; fresh: boolean } {
    let d = this.deploys.get(id);
    if (d) return { d, fresh: false };
    d = this.deployPool.pop();
    if (!d) {
      const root = new Container();
      const base = new Graphics();
      const head = new Graphics();
      root.addChild(base, head);
      d = { root, base, head, key: '', seen: 0, born: 0, lastHp: 1, hitT: -9, kind: dv.kind, x: 0, y: 0, angle: 0, length: 0, radius: 0, color: 0 };
    }
    d.key = ''; d.born = this.now; d.lastHp = dv.hpFrac; d.hitT = -9; d.kind = dv.kind;
    this.deployLayer.addChild(d.root);
    this.deploys.set(id, d);
    return { d, fresh: true };
  }

  private deployColor(dv: { team: TeamId; ownerId: EntityId }): number {
    const s = this.shipById.get(dv.ownerId);
    return colorFor(dv.team, s ? s.playerId : dv.ownerId);
  }

  private drawDeployables(frame: RenderFrame, t: number, dt: number): void {
    const A = this.atlas, gb = this.deployGlow, g = this.dynG, o = this.overlayG;
    gb.begin();
    for (const dv of frame.deployables) {
      const { d, fresh } = this.getDeployDisp(dv.id, dv);
      d.seen = this.frameNo;
      const color = this.deployColor(dv);
      d.x = dv.x; d.y = dv.y; d.angle = dv.angle; d.length = dv.length; d.radius = dv.radius; d.color = color; d.kind = dv.kind;
      if (dv.hpFrac < d.lastHp - 0.001) d.hitT = t;
      d.lastHp = dv.hpFrac;
      if (fresh) this.deploySpawnFx(dv, color);
      const vis = this.inView(dv.x, dv.y, dv.radius + dv.length / 2 + 60);
      d.root.visible = vis;
      if (!vis) continue;
      const age = t - d.born;
      const fade = dv.lifeFrac < 0.2 ? Math.max(0, dv.lifeFrac / 0.2) : 1;
      const blink = dv.lifeFrac < 0.1 && Math.floor(t * 12) % 2 ? 0.4 : 1;
      const hitAge = t - d.hitT;
      d.root.position.set(dv.x, dv.y);
      d.root.rotation = 0;
      d.root.scale.set(1);
      switch (dv.kind) {
        case 'sentry': {
          const r = Math.max(8, Math.round(dv.radius));
          const key = `sentry|${color}|${r}`;
          if (d.key !== key) {
            d.base.context = deployBody('sentry', 'base', color, r);
            d.head.context = deployBody('sentry', 'head', color, r);
            d.key = key;
          }
          d.base.visible = d.head.visible = true;
          d.head.rotation = dv.angle;
          const drop = age < 0.28 ? 1 - age / 0.28 : 0;
          d.root.scale.set(1 + drop * 0.9);
          d.root.alpha = fade * blink * (1 - drop * 0.6);
          if (hitAge < 0.1) d.root.scale.set(1.08);
          // hp ring
          const hr = r * 1.55;
          o.circle(dv.x, dv.y, hr).stroke({ width: 2, color: 0x000000, alpha: 0.3 * fade });
          if (dv.hpFrac > 0.01) {
            o.moveTo(dv.x + Math.cos(-Math.PI / 2) * hr, dv.y + Math.sin(-Math.PI / 2) * hr)
              .arc(dv.x, dv.y, hr, -Math.PI / 2, -Math.PI / 2 + TAU * dv.hpFrac)
              .stroke({ width: 1.8, color: energyColor(dv.hpFrac), alpha: 0.85 * fade });
          }
          gb.put(A.soft, dv.x, dv.y, 0, (r / 32) * 2.2, (r / 32) * 2.2, color, 0.18 * fade);
          break;
        }
        case 'drone': {
          const r = Math.max(5, Math.round(dv.radius));
          const key = `drone|${color}|${r}`;
          if (d.key !== key) { d.base.context = deployBody('drone', 'base', color, r); d.key = key; }
          d.base.visible = true; d.head.visible = false;
          d.base.rotation = dv.angle;
          d.root.alpha = fade * blink;
          gb.put(A.soft, dv.x, dv.y, 0, (r / 32) * 2.5, (r / 32) * 2.5, color, 0.25 * fade);
          if (Math.random() < 0.6 * this.density) {
            this.trails.spawn({ tex: A.soft, x: dv.x - Math.cos(dv.angle) * r, y: dv.y - Math.sin(dv.angle) * r, life: 0.25, color, s0: 0.14, s1: 0, alpha: 0.7 });
          }
          break;
        }
        case 'wall': {
          const half = Math.max(4, dv.radius);
          const key = `wall|${color}|${Math.round(dv.length)}|${Math.round(half)}`;
          if (d.key !== key) { d.base.context = wallBody(color, dv.length, half); d.key = key; }
          d.base.visible = true; d.head.visible = false;
          d.root.rotation = dv.angle;
          const grow = age < 0.22 ? age / 0.22 : 1;
          d.root.scale.set(grow, 1);
          d.root.alpha = fade * blink * (0.82 + 0.18 * Math.sin(t * 6 + dv.id));
          this.drawWallFx(dv, color, t, hitAge, fade * grow);
          break;
        }
        case 'well': {
          d.base.visible = d.head.visible = false;
          this.drawWell(dv, color, t, fade);
          break;
        }
        case 'fire': {
          d.base.visible = d.head.visible = false;
          const rr = dv.radius;
          const fl = 0.8 + 0.2 * Math.sin(t * 23 + dv.id) + 0.1 * Math.sin(t * 37);
          gb.put(A.soft, dv.x, dv.y, 0, (rr / 32) * 1.9 * fl, (rr / 32) * 1.6 * fl, 0xff6a1a, 0.45 * fade);
          gb.put(A.soft, dv.x, dv.y, 0, (rr / 32) * 1.0 * fl, (rr / 32) * 0.9 * fl, 0xffd060, 0.35 * fade);
          const n = Math.ceil((rr / 22) * this.density * fade);
          for (let i = 0; i < n; i++) {
            const a = rand(0, TAU), q = Math.sqrt(Math.random()) * rr * 0.9;
            this.fx.spawn({ tex: A.soft, x: dv.x + Math.cos(a) * q, y: dv.y + Math.sin(a) * q, vx: rand(-15, 15), vy: rand(-70, -25),
              life: rand(0.25, 0.5), color: Math.random() < 0.4 ? 0xffd060 : 0xff6a1a, s0: rand(0.2, 0.4), s1: 0.05, alpha: 0.8 });
          }
          break;
        }
        case 'nanite': {
          d.base.visible = d.head.visible = false;
          const rr = dv.radius;
          for (let k = 0; k < 6; k++) {
            const a = t * 0.35 * (k % 2 ? 1 : -1) + k * 1.05;
            const q = rr * (0.25 + 0.35 * ((k * 0.37) % 1));
            const s = (rr / 32) * (0.8 + 0.2 * Math.sin(t * 1.3 + k));
            gb.put(A.soft, dv.x + Math.cos(a) * q, dv.y + Math.sin(a) * q, 0, s, s, HEAL_COLOR, 0.1 * fade);
          }
          g.circle(dv.x, dv.y, rr).stroke({ width: 1.2, color: HEAL_COLOR, alpha: 0.25 * fade });
          if (Math.random() < 0.5 * this.density * fade) {
            const a = rand(0, TAU), q = Math.sqrt(Math.random()) * rr * 0.9;
            this.fx.spawn({ tex: A.plus, x: dv.x + Math.cos(a) * q, y: dv.y + Math.sin(a) * q, vy: rand(-55, -30), life: 0.9,
              color: HEAL_COLOR, s0: 0.35, s1: 0.15, alpha: 0.9 });
          }
          break;
        }
      }
    }
    gb.end();
    for (const [id, d] of this.deploys) {
      if (d.seen === this.frameNo) continue;
      this.deployLayer.removeChild(d.root);
      this.deploys.delete(id);
      this.deployPool.push(d);
    }
    void dt;
  }

  private drawWallFx(dv: DeployableView, color: number, t: number, hitAge: number, alpha: number): void {
    const g = this.dynG;
    const ca = Math.cos(dv.angle), sa = Math.sin(dv.angle), nx = -sa, ny = ca;
    const L = dv.length, h = Math.max(4, dv.radius);
    // travelling shimmer band
    const u = (((t * 0.7 + dv.id * 0.37) % 1) - 0.5) * L;
    const bx = dv.x + ca * u, by = dv.y + sa * u;
    g.moveTo(bx - ca * 18, by - sa * 18).lineTo(bx + ca * 18, by + sa * 18).stroke({ width: h * 2, color: brighten(color, 0.5), alpha: 0.16 * alpha });
    // cracks as hp drops (deterministic per id)
    const cracks = Math.floor((1 - dv.hpFrac) * 7);
    if (cracks > 0) {
      for (let k = 0; k < cracks; k++) {
        const hsh = Math.sin(dv.id * 12.9898 + k * 78.233) * 43758.5453;
        const f = (hsh - Math.floor(hsh)) - 0.5;
        const cx = dv.x + ca * f * L * 0.9, cy = dv.y + sa * f * L * 0.9;
        const z = (k % 2 ? 1 : -1) * 3;
        g.moveTo(cx + nx * h, cy + ny * h).lineTo(cx + nx * h * 0.3 + ca * z, cy + ny * h * 0.3 + sa * z)
          .lineTo(cx - nx * h * 0.3 - ca * z, cy - ny * h * 0.3 - sa * z).lineTo(cx - nx * h, cy - ny * h);
      }
      g.stroke({ width: 1.4, color: 0xffffff, alpha: 0.75 * alpha });
    }
    // hit flare
    if (hitAge < 0.18) {
      const f = 1 - hitAge / 0.18;
      g.moveTo(dv.x - ca * L / 2, dv.y - sa * L / 2).lineTo(dv.x + ca * L / 2, dv.y + sa * L / 2)
        .stroke({ width: h * 2 + 8 * f, color: brighten(color, 0.6), alpha: 0.35 * f });
    }
  }

  private drawWell(dv: DeployableView, color: number, t: number, fade: number): void {
    const g = this.dynG, A = this.atlas;
    const core = clamp(dv.radius * 0.1, 10, 32);
    this.deployGlow.put(A.soft, dv.x, dv.y, 0, (dv.radius / 32) * 1.1, (dv.radius / 32) * 1.1, color, 0.07 * fade);
    this.deployGlow.put(A.soft, dv.x, dv.y, 0, (core / 32) * 3.2, (core / 32) * 3.2, brighten(color, 0.2), 0.5 * fade);
    this.darkG.circle(dv.x, dv.y, core).fill({ color: 0x000000, alpha: 0.95 * fade });
    g.circle(dv.x, dv.y, core).stroke({ width: 2.2, color: brighten(color, 0.5), alpha: fade });
    for (let i = 0; i < 3; i++) {
      const rr = core * (1.45 + i * 0.4);
      const a0 = -t * (3 - i * 0.7) + i * 2.1;
      g.moveTo(dv.x + Math.cos(a0) * rr, dv.y + Math.sin(a0) * rr).arc(dv.x, dv.y, rr, a0, a0 + 2.3)
        .stroke({ width: 2.4 - i * 0.5, color: i === 0 ? brighten(color, 0.5) : color, alpha: (0.8 - i * 0.2) * fade });
      g.moveTo(dv.x + Math.cos(a0 + Math.PI) * rr, dv.y + Math.sin(a0 + Math.PI) * rr).arc(dv.x, dv.y, rr, a0 + Math.PI, a0 + Math.PI + 1.3)
        .stroke({ width: 1.6, color, alpha: (0.55 - i * 0.12) * fade });
    }
    g.circle(dv.x, dv.y, dv.radius).stroke({ width: 1, color, alpha: 0.12 * fade });
    const n = Math.ceil(1.5 * this.density * fade);
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), rr = dv.radius * rand(0.5, 0.95);
      const sp = rr * 2.4;
      this.fx.spawn({
        tex: A.streak, x: dv.x + Math.cos(a) * rr, y: dv.y + Math.sin(a) * rr,
        vx: -Math.cos(a - 0.45) * sp, vy: -Math.sin(a - 0.45) * sp, life: 0.36, color: mix(color, 0xffffff, 0.3),
        s0: 0.3, s1: 0.05, alpha: 0.75, flags: P_ORIENT | P_STRETCH, sy: 0.35,
      });
    }
  }

  private deploySpawnFx(dv: DeployableView, color: number): void {
    if (!this.inView(dv.x, dv.y, 200)) return;
    const A = this.atlas;
    switch (dv.kind) {
      case 'sentry':
        this.ring(dv.x, dv.y, dv.radius * 3, dv.radius, 0.3, color, 2.5);
        this.burst(dv.x, dv.y, 12, mix(color, 0xffffff, 0.4), 60, 200, 0.35, 0.35, { tex: A.dot, flags: 0 });
        this.grid?.impulse(dv.x, dv.y, 120, 260);
        break;
      case 'wall': {
        const ca = Math.cos(dv.angle), sa = Math.sin(dv.angle);
        const n = Math.ceil(14 * this.density);
        for (let i = 0; i < n; i++) {
          const f = (i / (n - 1) - 0.5) * dv.length;
          this.fx.spawn({ tex: A.dot, x: dv.x + ca * f, y: dv.y + sa * f, vx: -sa * rand(-120, 120), vy: ca * rand(-120, 120), life: 0.35, color: brighten(color, 0.4), s0: 0.35, s1: 0 });
        }
        break;
      }
      case 'well':
        this.ring(dv.x, dv.y, dv.radius, 12, 0.45, color, 3);
        this.flash(dv.x, dv.y, 1.2, color, 0.25);
        break;
      case 'drone':
        this.ring(dv.x, dv.y, 30, 6, 0.25, color, 1.5);
        break;
      case 'fire':
        this.flash(dv.x, dv.y, dv.radius / 30, 0xff8a2b, 0.25);
        break;
      case 'nanite':
        this.ring(dv.x, dv.y, 10, dv.radius, 0.5, HEAL_COLOR, 2);
        break;
    }
  }

  // =============================================================================================
  // enemies

  private getEnemyDisp(id: EntityId): EnemyDisp {
    let d = this.enemies.get(id);
    if (d) return d;
    d = this.enemyPool.pop();
    if (!d) {
      const root = new Container();
      const body = new Graphics();
      root.addChild(body);
      d = { root, body, ring: null, hive0: null, hive1: null, m0: null, m1: null, m2: null, rot: 0, key: '', px: 0, py: 0, speed: 0, hitT: -1, seen: 0 };
    }
    d.key = ''; d.speed = 0; d.hitT = -1; d.px = NaN; d.rot = NaN;
    this.enemyLayer.addChild(d.root);
    this.enemies.set(id, d);
    return d;
  }

  private drawEnemies(frame: RenderFrame, t: number, dt: number): void {
    const g = this.dynG;
    for (const e of frame.enemies) {
      const d = this.getEnemyDisp(e.id);
      d.seen = this.frameNo;
      if (dt > 0 && !Number.isNaN(d.px)) {
        const sp = Math.hypot(e.x - d.px, e.y - d.py) / dt;
        d.speed += (sp - d.speed) * 0.2;
      }
      d.px = e.x; d.py = e.y;
      const vis = this.inView(e.x, e.y, e.radius + 40);
      d.root.visible = vis;
      if (!vis) continue;
      const key = `${e.kind}|${e.elite ? 1 : 0}`;
      if (d.key !== key) {
        d.body.context = enemyBody(e.kind, e.elite);
        d.key = key;
        if (e.elite) {
          if (!d.ring) { d.ring = new Graphics(eliteRing()); d.root.addChild(d.ring); }
          d.ring.visible = true;
          d.ring.tint = brighten(ENEMY_COLORS[e.kind], 0.3);
        } else if (d.ring) d.ring.visible = false;
        if (e.kind === 'hive') {
          if (!d.hive0) { d.hive0 = new Graphics(hiveRing(0)); d.hive1 = new Graphics(hiveRing(1)); d.root.addChildAt(d.hive1, 0); d.root.addChildAt(d.hive0, 0); }
          d.hive0.visible = d.hive1!.visible = true;
        } else if (d.hive0) { d.hive0.visible = d.hive1!.visible = false; }
        d.body.tint = 0xffffff;
        if (e.kind === 'matriarch') {
          if (!d.m0) {
            // halo + wings behind the body, brood sacs above it
            d.m0 = new Graphics(matriarchPart(0)); d.m1 = new Graphics(matriarchPart(1)); d.m2 = new Graphics(matriarchPart(2));
            d.root.addChildAt(d.m1, 0); d.root.addChildAt(d.m0, 0);
            d.root.addChildAt(d.m2, d.root.getChildIndex(d.body) + 1);
          }
          d.m0.visible = d.m1!.visible = d.m2!.visible = true;
        } else if (d.m0) { d.m0.visible = d.m1!.visible = d.m2!.visible = false; d.m0.tint = 0xffffff; }
      }
      this.poseEnemy(e, d, t);
      if (e.kind === 'blackhole') this.drawBlackhole(e, t, g);
      if (e.kind === 'matriarch') this.drawMatriarchFx(e, d, t, g);
    }
    for (const [id, d] of this.enemies) {
      if (d.seen === this.frameNo) continue;
      this.enemyLayer.removeChild(d.root);
      this.enemies.delete(id);
      this.enemyPool.push(d);
    }
  }

  private poseEnemy(e: EnemyView, d: EnemyDisp, t: number): void {
    const sc = e.radius / ENEMY_BASE_R;
    const ph = e.id * 1.37;
    let rot = 0, s = 1, alpha = 1;
    switch (e.kind) {
      case 'drone': rot = t * 2.4 + ph; break;
      case 'dart':
        rot = e.angle;
        if (d.speed < 60) { alpha = Math.sin(t * 45 + ph) > 0 ? 1 : 0.45; s = 1.08; }
        break;
      case 'weaver': rot = t * 1.3 + ph; s = 1 + 0.1 * Math.sin(t * 9 + ph); break;
      case 'splitter': rot = t * 0.9 + ph; break;
      case 'splitling': rot = t * 3.2 + ph; break;
      case 'spinner': rot = t * 5 + ph; break;
      case 'brute': rot = e.angle; s = 1 + 0.03 * Math.sin(t * 4 + ph); break;
      case 'hive':
        rot = t * 0.3;
        if (d.hive0) { d.hive0.rotation = -t * 0.55; d.hive1!.rotation = t * 1.2 - rot; }
        s = 1 + 0.03 * Math.sin(t * 3);
        break;
      case 'blackhole': rot = 0; s = 1 + 0.04 * Math.sin(t * 6 + ph); break;
      case 'matriarch': {
        // phase-driven pose: P1 calm, P2 Brood Burst (sacs pulse), P3 Frenzy (red-hot, fast halo + wings)
        const phase = this.riftLayer.bossPhase(e.id, e.hpFrac);
        if (!Number.isFinite(d.rot)) d.rot = e.angle;
        let da = e.angle - d.rot;
        while (da > Math.PI) da -= TAU;
        while (da < -Math.PI) da += TAU;
        d.rot += da * (phase >= 3 ? 0.2 : 0.08);
        rot = d.rot;
        s = 1 + 0.02 * Math.sin(t * 2);
        const flap = phase >= 3 ? 22 : phase === 2 ? 12 : 7;
        if (d.m0 && d.m1 && d.m2) {
          d.m0.rotation = t * (phase >= 3 ? 1.4 : phase === 2 ? 0.6 : 0.25);
          d.m0.tint = phase >= 3 ? 0xff9090 : 0xffffff;
          d.m1.rotation = rot;
          d.m1.scale.set(1, 1 + 0.12 * Math.sin(t * flap));
          d.m2.rotation = rot;
          d.m2.alpha = phase === 2 ? 0.6 + 0.4 * Math.sin(t * 10) : 0.55 + 0.2 * Math.sin(t * 2.5);
        }
        d.body.tint = phase >= 3 ? mix(0xffffff, 0xff6a6a, 0.35 + 0.2 * Math.sin(t * 14)) : 0xffffff;
        break;
      }
    }
    if (e.hpFrac < 0.5 && e.kind !== 'matriarch') alpha *= 0.78 + 0.22 * Math.sin(t * 28 + ph);
    const hitAge = d.hitT >= 0 ? t - d.hitT : 9;
    if (hitAge < 0.1) s *= 1.12;
    d.root.position.set(e.x, e.y);
    d.root.scale.set(sc * s);
    d.body.rotation = rot;
    if (d.ring) d.ring.rotation = t * 1.6 + ph;
    d.root.alpha = alpha;
  }

  /** Matriarch extras (additive dynG): the 3 s intro shield (damage-immune, §4.5) and a frenzy aura. */
  private drawMatriarchFx(e: EnemyView, d: EnemyDisp, t: number, g: Graphics): void {
    const ia = this.riftLayer.introAge(e.id, t);
    if (ia < 3) {
      const k = 1 - ia / 3, rr = e.radius * 1.3;
      for (let i = 0; i < 6; i++) {
        const a0 = t * 1.2 + (i * TAU) / 6 + 0.1, a1 = a0 + TAU / 6 - 0.2;
        g.moveTo(e.x + Math.cos(a0) * rr, e.y + Math.sin(a0) * rr).arc(e.x, e.y, rr, a0, a1);
      }
      g.stroke({ width: 5, color: 0xffffff, alpha: 0.55 * k + 0.2 });
      g.circle(e.x, e.y, rr).stroke({ width: 18, color: ENEMY_COLORS.matriarch, alpha: 0.08 * k });
    }
    if (this.riftLayer.bossPhase(e.id, e.hpFrac) >= 3) {
      const p = 0.5 + 0.5 * Math.sin(t * 9);
      g.circle(e.x, e.y, e.radius * (1.05 + 0.08 * p)).stroke({ width: 3, color: 0xff5050, alpha: 0.3 + 0.3 * p });
    }
    void d;
  }

  private drawBlackhole(e: EnemyView, t: number, g: Graphics): void {
    const col = ENEMY_COLORS.blackhole;
    for (let i = 0; i < 3; i++) {
      const rr = e.radius * (1.35 + i * 0.28);
      const a0 = t * (2.4 - i * 0.6) + i * 2.1;
      g.moveTo(e.x + Math.cos(a0) * rr, e.y + Math.sin(a0) * rr).arc(e.x, e.y, rr, a0, a0 + 2.2)
        .stroke({ width: 2.4 - i * 0.5, color: i === 0 ? 0xc8a8ff : col, alpha: 0.75 - i * 0.18 });
      g.moveTo(e.x + Math.cos(a0 + Math.PI) * rr, e.y + Math.sin(a0 + Math.PI) * rr).arc(e.x, e.y, rr, a0 + Math.PI, a0 + Math.PI + 1.4)
        .stroke({ width: 1.8 - i * 0.4, color: col, alpha: 0.55 - i * 0.12 });
    }
    if (Math.random() < 0.6 * this.density) {
      const a = rand(0, TAU), rr = e.radius * rand(2.2, 3.2);
      this.fx.spawn({
        tex: this.atlas.streak, x: e.x + Math.cos(a) * rr, y: e.y + Math.sin(a) * rr,
        vx: -Math.cos(a - 0.5) * rr * 2.2, vy: -Math.sin(a - 0.5) * rr * 2.2, life: 0.4, color: mix(col, 0xffffff, 0.3),
        s0: 0.25, s1: 0.05, alpha: 0.8, flags: P_ORIENT | P_STRETCH, sy: 0.4,
      });
    }
  }

  // =============================================================================================
  // gems & projectiles

  private drawGems(frame: RenderFrame, t: number): void {
    const b = this.gems, A = this.atlas;
    b.begin();
    for (const gm of frame.gems) {
      if (!this.inView(gm.x, gm.y, 20)) continue;
      const c = gemColor(gm.value), s = gemScale(gm.value);
      const ph = gm.id * 0.73;
      const y = gm.y + Math.sin(t * 3 + ph) * 2.5;
      b.put(A.soft, gm.x, y, 0, 0.5 * s, 0.5 * s, c, 0.45 + 0.15 * Math.sin(t * 5 + ph));
      const spin = Math.cos(t * 3.2 + ph);
      b.put(A.crystal, gm.x, y, 0, 0.5 * s * (0.25 + 0.75 * Math.abs(spin)), 0.5 * s, spin > 0 ? c : brighten(c, 0.35), 1);
    }
    b.end();
  }

  private projColor(p: { team: TeamId; ownerId: EntityId }): number {
    if (p.team === ENEMY_TEAM) return ENEMY_COLOR;
    const s = this.shipById.get(p.ownerId);
    return colorFor(p.team, s ? s.playerId : p.ownerId);
  }

  private drawProjectiles(frame: RenderFrame, t: number): void {
    const b = this.projs, A = this.atlas;
    b.begin();
    for (const p of frame.projectiles) {
      if (!this.inView(p.x, p.y, 30)) continue;
      const c = this.projColor(p);
      const lv = p.level || 1;
      const ph = p.id * 0.61;
      switch (p.kind) {
        case 'bullet': {
          const a = Math.atan2(p.vy, p.vx);
          const os = this.shipById.get(p.ownerId);
          const cls: ShipClassId | undefined = os?.shipClass;
          const wl = os && os.attachedTo === 0 ? weaponFor(this.looks.get(os.playerId), os.shipClass) : null;
          if (wl && wl.p.shape !== 'std' && cls) { this.putWeaponShot(p.x, p.y, a, c, lv, cls, wl, t + ph); break; }
          const lm = wl ? wl.len : 1;
          if (cls === 'brute') { // thick orange-hot slug
            const sx = (0.85 + 0.15 * lv) * lm, sy = 1.05 + 0.15 * lv;
            b.put(A.streak, p.x, p.y, a, sx, sy, mix(c, 0xff8a2b, 0.6), 1);
            b.put(A.streak, p.x, p.y, a, sx * 0.6, sy * 0.5, 0xfff0c0, 1);
          } else if (cls === 'engineer') { // thin rapid rivet
            b.put(A.streak, p.x, p.y, a, (0.5 + 0.08 * lv) * lm, 0.32, brighten(c, 0.3), 1);
            b.put(A.streak, p.x, p.y, a, 0.28 * lm, 0.2, 0xffffff, 1);
          } else {
            const sx = 0.65 + 0.22 * lv, sy = 0.55 + 0.18 * lv;
            b.put(A.streak, p.x, p.y, a, sx, sy, c, 1);
            b.put(A.streak, p.x, p.y, a, sx * 0.55, sy * 0.4, 0xffffff, 0.9);
          }
          break;
        }
        case 'plasma': {
          const a = Math.atan2(p.vy, p.vx);
          const os = this.shipById.get(p.ownerId);
          const wl = os && os.attachedTo === 0 ? weaponFor(this.looks.get(os.playerId), os.shipClass) : null;
          if (wl && wl.p.shape !== 'std') { this.putWeaponShot(p.x, p.y, a, c, lv, 'tech', wl, t + ph); break; }
          const pulse = 1 + 0.12 * Math.sin(t * 30 + ph);
          b.put(A.soft, p.x, p.y, 0, 0.42 * pulse, 0.42 * pulse, mix(c, 0x9d6bff, 0.55), 0.85);
          b.put(A.streak, p.x, p.y, a, (0.75 + 0.1 * lv) * (wl ? wl.len : 1), 0.7, mix(0x6ae4ff, c, 0.3), 1);
          b.put(A.dot, p.x, p.y, 0, 0.45, 0.45, 0xf0f8ff, 1);
          break;
        }
        case 'rocket': {
          const a = Math.atan2(p.vy, p.vx);
          b.put(A.streak, p.x, p.y, a, 0.55, 0.55, brighten(c, 0.2), 1);
          b.put(A.dot, p.x + Math.cos(a) * 6, p.y + Math.sin(a) * 6, 0, 0.3, 0.3, 0xffffff, 1);
          b.put(A.soft, p.x - Math.cos(a) * 7, p.y - Math.sin(a) * 7, 0, 0.3, 0.3, 0xffa040, 0.9);
          if (Math.random() < this.density) {
            this.trails.spawn({ tex: A.soft, x: p.x - Math.cos(a) * 8, y: p.y - Math.sin(a) * 8, vx: rand(-12, 12), vy: rand(-12, 12),
              life: 0.3, color: 0xff8a2b, s0: 0.22, s1: 0.05, alpha: 0.8 });
            if ((p.id + this.frameNo) % 2 === 0) {
              this.trails.spawn({ tex: A.soft, x: p.x - Math.cos(a) * 12, y: p.y - Math.sin(a) * 12, life: 0.55, color: 0x4a3a50, s0: 0.15, s1: 0.5, alpha: 0.5 });
            }
          }
          break;
        }
        case 'singularity': {
          const rr = 9 + lv;
          this.darkG.circle(p.x, p.y, rr).fill({ color: 0x000000, alpha: 0.95 });
          b.put(A.soft, p.x, p.y, 0, 0.9, 0.9, VOID_COLOR, 0.55);
          const g = this.dynG;
          for (let i = 0; i < 2; i++) {
            const a0 = -t * 9 + i * Math.PI + ph;
            g.moveTo(p.x + Math.cos(a0) * (rr + 3), p.y + Math.sin(a0) * (rr + 3)).arc(p.x, p.y, rr + 3, a0, a0 + 2.1);
          }
          g.stroke({ width: 2, color: brighten(VOID_COLOR, 0.4), alpha: 0.95 });
          g.circle(p.x, p.y, rr).stroke({ width: 1.2, color: VOID_COLOR, alpha: 0.8 });
          if (Math.random() < this.density) {
            this.trails.spawn({ tex: A.dot, x: p.x + rand(-6, 6), y: p.y + rand(-6, 6), life: 0.35, color: VOID_COLOR, s0: 0.4, s1: 0, alpha: 0.8 });
          }
          break;
        }
        case 'bomb': {
          const pulse = 1 + 0.18 * Math.sin(t * 16 + ph);
          const s = (0.5 + 0.12 * lv) * pulse;
          b.put(A.soft, p.x, p.y, 0, s, s, c, 0.95);
          b.put(A.ring, p.x, p.y, t * 4, s * 0.45, s * 0.45, brighten(c, 0.3), 0.9);
          b.put(A.dot, p.x, p.y, 0, 0.5, 0.5, 0xffffff, 1);
          if (Math.random() < this.density) {
            this.trails.spawn({ tex: A.soft, x: p.x, y: p.y, vx: rand(-15, 15), vy: rand(-15, 15), life: 0.35, color: c, s0: 0.32 + 0.05 * lv, s1: 0, alpha: 0.7 });
          }
          break;
        }
        case 'mine': {
          const blink = Math.sin(t * 6 + ph) > 0 ? 1 : 0.35;
          const s = 0.7 + 0.1 * lv;
          b.put(A.soft, p.x, p.y, 0, 0.5 * s, 0.5 * s, c, 0.35 * blink);
          b.put(A.diamond, p.x, p.y, t * 1.2 + ph, s, s, c, 0.6 + 0.4 * blink);
          b.put(A.dot, p.x, p.y, 0, 0.3, 0.3, 0xffffff, blink);
          break;
        }
        case 'shrapnel': {
          const a = Math.atan2(p.vy, p.vx);
          const tl = this.turretShotLook(p.ownerId);
          if (tl) { this.putTurretShot(p.x, p.y, a, c, tl, 0.8, t + ph); break; }
          b.put(A.streak, p.x, p.y, a, 0.35, 0.35, brighten(c, 0.3), 1);
          break;
        }
        case 'seeker': {
          const a = Math.atan2(p.vy, p.vx);
          const tl = this.turretShotLook(p.ownerId);
          if (tl) this.putTurretShot(p.x, p.y, a, c, tl, 1.2, t + ph);
          else {
            b.put(A.streak, p.x, p.y, a, 0.55, 0.55, c, 1);
            b.put(A.dot, p.x + Math.cos(a) * 5, p.y + Math.sin(a) * 5, 0, 0.3, 0.3, 0xffffff, 1);
          }
          if ((p.id + this.frameNo) % 2 === 0 && Math.random() < this.density) {
            this.trails.spawn({ tex: A.soft, x: p.x - Math.cos(a) * 6, y: p.y - Math.sin(a) * 6, life: 0.45, color: darken(c, 0.35), s0: 0.16, s1: 0.45, alpha: 0.45, vx: rand(-10, 10), vy: rand(-10, 10) });
          }
          break;
        }
        case 'enemyShot': {
          b.put(A.soft, p.x, p.y, 0, 0.42, 0.42, ENEMY_COLOR, 1);
          b.put(A.dot, p.x, p.y, 0, 0.35, 0.35, 0xffc8f4, 1);
          break;
        }
      }
    }
    b.end();
  }

  /**
   * v0.3 cosmetic primary shot. Main colour is always the team `c`; the shape changes the sprite, lengthMul
   * the length only (weaponVisualRatio: 0.8–1.6 × length, ≤ 1.3 × width of the class's standard shot).
   */
  private putWeaponShot(x: number, y: number, a: number, c: number, lv: number, cls: ShipClassId, wl: WeaponLook, ph: number): void {
    const b = this.projs, A = this.atlas;
    const L = (cls === 'brute' ? 60 * (0.85 + 0.15 * lv) : cls === 'engineer' ? 60 * (0.5 + 0.08 * lv) : 60 * (0.75 + 0.1 * lv)) * wl.len;
    const W = (cls === 'brute' ? 13 * (1.05 + 0.15 * lv) : cls === 'engineer' ? 13 * 0.32 : 13 * 0.7) * wl.wid;
    const ca = Math.cos(a), sa = Math.sin(a);
    if (cls === 'tech') { const pulse = 1 + 0.12 * Math.sin(ph * 30); b.put(A.soft, x, y, 0, 0.42 * pulse, 0.42 * pulse, c, 0.6); }
    let hx = x, hy = y, coreS = (W * 0.5) / 26;
    switch (wl.p.shape) {
      case 'orb': { // round head + comet tail
        const D = W * (cls === 'tech' ? 1.8 : 1);
        b.put(A.streak, x - ca * L * 0.25, y - sa * L * 0.25, a, L / 60, (D * 0.5) / 13, c, 0.8);
        b.put(A.orb, x, y, 0, D / 24, D / 24, c, 1);
        coreS = (D * 0.45) / 26;
        break;
      }
      case 'needle':
        b.put(A.needle, x, y, a, L / 30, W / 5, c, 1);
        hx = x + ca * L * 0.3; hy = y + sa * L * 0.3; coreS = (W * 0.8) / 26;
        break;
      case 'shard':
        b.put(A.wShard, x, y, a, L / 30, W / 14, c, 1);
        hx = x + ca * L * 0.2; hy = y + sa * L * 0.2;
        break;
      default: // droplet
        b.put(A.droplet, x, y, a, L / 28, W / 15, c, 1);
        hx = x + ca * L * 0.32; hy = y + sa * L * 0.32;
        break;
    }
    const core = wl.p.core;
    const cc = core === 'white' ? 0xffffff : core === 'dark' ? darken(c, 0.6) : wl.p.accent;
    b.put(A.dot, hx, hy, 0, coreS, coreS, cc, core === 'dark' ? 0.7 : 0.95);
  }

  /** Turret-kit shot look for a projectile owner that is attached as a turret (null = standard shot). */
  private turretShotLook(ownerId: EntityId): TurretLook | null {
    const os = this.shipById.get(ownerId);
    if (!os || os.attachedTo === 0) return null;
    const tl = turretFor(this.looks.get(os.playerId), os.shipClass);
    return tl && tl.p.shot !== 'std' ? tl : null;
  }

  /** Turret shrapnel / seeker in a cosmetic shot style (main colour team `c`, accent core). */
  private putTurretShot(x: number, y: number, a: number, c: number, tl: TurretLook, size: number, ph: number): void {
    const b = this.projs, A = this.atlas, acc = tl.p.accent;
    switch (tl.p.shot) {
      case 'shard':
        b.put(A.wShard, x, y, a, 0.55 * size, 0.5 * size, brighten(c, 0.3), 1);
        b.put(A.dot, x + Math.cos(a) * 3 * size, y + Math.sin(a) * 3 * size, 0, 0.16 * size, 0.16 * size, acc, 0.9);
        break;
      case 'spark':
        b.put(A.streak, x, y, a, 0.45 * size, 0.26 * size, brighten(c, 0.4), 1);
        b.put(A.dot, x + Math.cos(a) * 6 * size, y + Math.sin(a) * 6 * size, 0, 0.2 * size, 0.2 * size, acc, 1);
        break;
      default: { // mote: a wobbling soft orb
        const w = Math.sin(ph * 20) * 1.5;
        const ox = -Math.sin(a) * w, oy = Math.cos(a) * w;
        b.put(A.soft, x + ox, y + oy, 0, 0.3 * size, 0.3 * size, c, 0.9);
        b.put(A.dot, x + ox, y + oy, 0, 0.22 * size, 0.22 * size, acc, 1);
        break;
      }
    }
  }

  // =============================================================================================
  // events

  private burst(
    x: number, y: number, n: number, color: number, spMin: number, spMax: number, life: number, scale: number,
    opts: { tex?: Texture; flags?: number; drag?: number; sy?: number; into?: Particles; vyBias?: number } = {},
  ): void {
    const cnt = Math.ceil(n * this.density);
    const into = opts.into ?? this.fx;
    const tex = opts.tex ?? this.atlas.streak;
    const flags = opts.flags ?? (P_ORIENT | P_STRETCH);
    for (let i = 0; i < cnt; i++) {
      const a = rand(0, TAU), sp = rand(spMin, spMax);
      into.spawn({
        tex, x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + (opts.vyBias ?? 0), life: life * rand(0.6, 1.2), color,
        s0: scale * rand(0.7, 1.2), s1: 0, alpha: 1, drag: opts.drag ?? 2.4, flags, sy: opts.sy ?? 0.45,
        rot: a, spin: rand(-10, 10),
      });
    }
  }

  private flash(x: number, y: number, size: number, color: number, life = 0.22, alpha = 0.9): void {
    this.fx.spawn({ tex: this.atlas.soft, x, y, life, color, s0: size, s1: size * 1.4, alpha });
  }

  private ring(x: number, y: number, r0: number, r1: number, life: number, color: number, width = 3, follow = 0, alpha = 1): void {
    if (this.rings.length > 200) this.rings.shift();
    this.rings.push({ x, y, r0, r1, t: 0, life, color, width, follow, alpha });
  }

  private shipPos(id: EntityId, fx: number, fy: number): { x: number; y: number } {
    const d = this.ships.get(id);
    return d ? { x: d.x, y: d.y } : { x: fx, y: fy };
  }

  private handleEvent(ev: GameEvent, frame: RenderFrame): void {
    const A = this.atlas;
    switch (ev.t) {
      case 'explode': {
        const col = ev.team === ENEMY_TEAM ? ENEMY_COLOR : colorFor(ev.team, 0);
        const c = ev.team < 0 && ev.team !== ENEMY_TEAM ? 0xffe0a0 : col;
        const r = Math.max(20, ev.radius);
        this.grid?.impulse(ev.x, ev.y, r * 2.6, 160 + r * 2.2);
        if (!this.inView(ev.x, ev.y, r + 200)) break;
        if (ev.kind === 'rocket') { // flame puff
          this.burst(ev.x, ev.y, 14 + r / 6, 0xff8a2b, 60, 200 + r * 2, 0.45, 0.45, { tex: A.soft, flags: 0, drag: 3.5 });
          this.burst(ev.x, ev.y, 10, 0xffd060, 150, 380, 0.3, 0.5);
          this.burst(ev.x, ev.y, 6, 0x4a3a50, 20, 80, 0.8, 0.6, { tex: A.soft, flags: 0, drag: 1.5 });
          this.flash(ev.x, ev.y, r / 30, 0xffa040, 0.2);
          this.ring(ev.x, ev.y, r * 0.2, r, 0.3, 0xffc070, 2.5);
          this.addShake(0.06 + r / 1500, ev.x, ev.y);
          break;
        }
        if (ev.kind === 'singularity') {
          this.ring(ev.x, ev.y, r, 5, 0.35, VOID_COLOR, 3);
          this.burst(ev.x, ev.y, 20, VOID_COLOR, 100, 400, 0.4, 0.5);
          break;
        }
        const big = ev.kind === 'bomb' || ev.kind === 'mine';
        this.burst(ev.x, ev.y, big ? 18 + r / 4 : 6, c, 120, big ? 380 + r * 2 : 220, big ? 0.55 : 0.3, big ? 0.7 : 0.4);
        if (big) this.burst(ev.x, ev.y, 10, 0xffffff, 60, 260, 0.35, 0.5);
        this.flash(ev.x, ev.y, r / 26, c, 0.25);
        this.flash(ev.x, ev.y, r / 60, 0xffffff, 0.12);
        this.ring(ev.x, ev.y, r * 0.2, r * 1.1, 0.35, brighten(c, 0.3), big ? 3.5 : 2);
        if (big) this.addShake(0.12 + r / 900, ev.x, ev.y);
        break;
      }
      case 'shipDeath': {
        const s = this.shipById.get(ev.shipId);
        const c = s ? this.shipColor(s) : this.playerColor(frame, ev.playerId);
        this.grid?.impulse(ev.x, ev.y, 420, 900);
        if (!this.inView(ev.x, ev.y, 400)) break;
        // The team-coloured core burst, flash, ring and shake always play (readability rule).
        this.burst(ev.x, ev.y, 70, c, 150, 720, 0.9, 0.9);
        this.flash(ev.x, ev.y, 3.2, c, 0.4);
        this.ring(ev.x, ev.y, 10, 260, 0.6, brighten(c, 0.4), 5);
        const death = this.looks.get(ev.playerId).death;
        if (death.preset === 'std') {
          this.burst(ev.x, ev.y, 30, 0xffffff, 100, 500, 0.6, 0.6);
          this.burst(ev.x, ev.y, 25, mix(c, 0xffd060, 0.5), 80, 420, 1.0, 0.7);
          this.burst(ev.x, ev.y, 14, c, 60, 260, 1.4, 0.9, { tex: A.shard, flags: P_SPIN, drag: 1.2, sy: 1 });
          this.flash(ev.x, ev.y, 1.4, 0xffffff, 0.18);
          this.ring(ev.x, ev.y, 10, 150, 0.45, 0xffffff, 2);
        } else {
          // the death preset replaces the rest: ≤ 70 particles, gone within linger ≤ 1.5 s
          emitDeathPreset(this.fx, this.atlas, death, ev.x, ev.y, c, this.density, this.deathHost);
          this.flash(ev.x, ev.y, 1.4, 0xffffff, 0.18);
        }
        this.addShake(ev.shipId === frame.localShipId ? 0.9 : 0.5, ev.x, ev.y);
        this.startShock(ev.x, ev.y);
        break;
      }
      case 'enemyDeath': {
        const c = ENEMY_COLORS[ev.kind];
        const size = ev.kind === 'matriarch' ? 5 : ev.kind === 'hive' ? 4 : ev.kind === 'brute' || ev.kind === 'blackhole' ? 2 : ev.kind === 'splitling' ? 0.6 : 1;
        this.grid?.impulse(ev.x, ev.y, 110 * Math.sqrt(size) * (ev.elite ? 1.4 : 1), 260 * size);
        if (!this.inView(ev.x, ev.y, 100)) break;
        const n = (ev.kind === 'splitling' ? 10 : 22) * (ev.elite ? 1.6 : 1) * Math.sqrt(size);
        this.burst(ev.x, ev.y, n, c, 120, 340 + 120 * size, 0.55, 0.55 + 0.1 * size);
        this.burst(ev.x, ev.y, n * 0.3, brighten(c, 0.6), 80, 240, 0.35, 0.4);
        this.flash(ev.x, ev.y, 0.5 * size, c, 0.2, 0.7);
        if (size >= 2 || ev.elite) {
          this.ring(ev.x, ev.y, 10, 90 * size, 0.5, c, 3);
          this.addShake(0.08 * size, ev.x, ev.y);
        }
        if (ev.kind === 'hive') { this.ring(ev.x, ev.y, 20, 500, 0.9, 0xffffff, 4); this.startShock(ev.x, ev.y); }
        if (ev.kind === 'matriarch') { // the queen falls: gold crown shards, a white shock ring, a long tint
          this.ring(ev.x, ev.y, 30, 900, 1.3, 0xffffff, 6);
          this.ring(ev.x, ev.y, 20, 600, 1.0, MATRIARCH_GOLD, 4);
          this.burst(ev.x, ev.y, 40, MATRIARCH_GOLD, 100, 520, 1.2, 0.8, { tex: A.shard, flags: P_SPIN, drag: 1.2, sy: 1 });
          this.addShake(0.9, ev.x, ev.y);
          this.startShock(ev.x, ev.y);
          this.pulseTint(0xffffff, 0.22, 0.4);
        }
        break;
      }
      case 'hit': {
        if (ev.targetKind === 'enemy') { const d = this.enemies.get(ev.targetId); if (d) d.hitT = frame.time; }
        if (ev.targetKind === 'ship' && ev.targetId === frame.localShipId) {
          this.addShake(0.12 + Math.min(0.3, ev.amount / 1500), ev.x, ev.y);
          this.pulseTint(0xff2030, 0.1, 0.5);
        }
        if (!this.inView(ev.x, ev.y, 20)) break;
        this.burst(ev.x, ev.y, 5, ev.targetKind === 'ship' ? 0xffffff : 0xfff0a0, 80, 260, 0.2, 0.35);
        break;
      }
      case 'heal': {
        const pos = this.shipPos(ev.targetId, ev.x, ev.y);
        if (!this.inView(pos.x, pos.y, 40)) break;
        this.burst(pos.x, pos.y, 7, HEAL_COLOR, 40, 130, 0.6, 0.4, { tex: A.plus, flags: 0, drag: 2.5, vyBias: -40 });
        this.flash(pos.x, pos.y, 0.6, HEAL_COLOR, 0.2, 0.5);
        if (ev.amount >= 1) this.floatNumber(pos.x, pos.y, ev.targetId, ev.amount, 0x8dffae);
        break;
      }
      case 'blink': {
        const s = this.shipById.get(ev.shipId);
        const color = s ? this.shipColor(s) : 0xffffff;
        const accent = s ? this.accentOf(s, 0x6ae4ff) : 0x6ae4ff;
        const c = mix(accent, 0xffffff, 0.2);
        this.lines.push({ pts: [ev.fromX, ev.fromY, ev.x, ev.y], t: 0, life: 0.25, color: c, width: 5 });
        const d = this.ships.get(ev.shipId);
        if (s && d) {
          for (let i = 0; i < 5; i++) {
            const f = i / 5;
            this.spawnGhost(d.hull.context, ev.fromX + (ev.x - ev.fromX) * f, ev.fromY + (ev.y - ev.fromY) * f, s.angle, d.hull.scale.x, 0.18 + f * 0.25, 0.25 + f * 0.4, c);
          }
        }
        this.ring(ev.fromX, ev.fromY, 60, 4, 0.3, c, 3);
        this.ring(ev.x, ev.y, 6, 80, 0.35, c, 3);
        this.ring(ev.x, ev.y, 4, 45, 0.25, 0xffffff, 1.5);
        this.burst(ev.x, ev.y, 18, c, 80, 320, 0.35, 0.45);
        this.burst(ev.fromX, ev.fromY, 10, color, 20, 90, 0.4, 0.35, { tex: A.dot, flags: 0 });
        this.grid?.impulse(ev.x, ev.y, 160, 380);
        this.grid?.impulse(ev.fromX, ev.fromY, 140, -260);
        break;
      }
      case 'beam': {
        const ex = this.tethers.find((q) => q.from === ev.fromId && q.to === ev.toId);
        if (ex) ex.t = 0; else if (this.tethers.length < 32) this.tethers.push({ from: ev.fromId, to: ev.toId, t: 0, life: 0.15 });
        break;
      }
      case 'deployDeath': this.deployDeathFx(ev.id, ev.kind, ev.x, ev.y); break;
      case 'gem': {
        if (!this.inView(ev.x, ev.y, 20)) break;
        const c = gemColor(ev.value);
        this.burst(ev.x, ev.y, 6, c, 30, 120, 0.4, 0.4, { tex: A.dot, flags: 0, drag: 3 });
        this.flash(ev.x, ev.y, 0.35, c, 0.18, 0.7);
        break;
      }
      case 'levelUp': {
        const s = this.shipByPlayer.get(ev.playerId);
        if (!s) break;
        const { x, y } = this.shipPos(s.id, s.x, s.y);
        const local = ev.playerId === frame.localPlayerId;
        this.ring(x, y, 10, local ? 140 : 90, 0.7, GOLD, local ? 4 : 2.5, s.id);
        this.ring(x, y, 10, local ? 90 : 60, 0.5, 0xffffff, 1.5, s.id);
        if (this.inView(x, y, 100)) this.burst(x, y, local ? 30 : 14, GOLD, 60, 260, 0.7, 0.5, { tex: A.dot, flags: 0, drag: 2 });
        if (local) this.pulseTint(GOLD, 0.06, 0.6);
        break;
      }
      case 'upgrade': {
        const s = this.shipByPlayer.get(ev.playerId);
        if (!s) break;
        const { x, y } = this.shipPos(s.id, s.x, s.y);
        const path = ev.upgradeId.startsWith('path:') ? PATHS[ev.upgradeId.slice(5) as keyof typeof PATHS] : undefined;
        const tal = TALENTS[ev.upgradeId];
        const accent = path?.accent ?? (tal ? PATHS[tal.path].accent : 0x3bf2ff);
        this.ring(x, y, 8, path ? 160 : 70, path ? 0.8 : 0.4, accent, path ? 4 : 2, s.id);
        if (path && this.inView(x, y, 100)) this.burst(x, y, 30, accent, 80, 300, 0.7, 0.5);
        break;
      }
      case 'attach': {
        const tur = this.ships.get(ev.turretShipId), host = this.ships.get(ev.hostShipId);
        const hs = this.shipById.get(ev.hostShipId);
        if (!host || !hs) break;
        const c = this.shipColor(hs);
        const sx = tur?.x ?? host.x, sy = tur?.y ?? host.y;
        this.lines.push({ pts: [sx, sy, host.x, host.y], t: 0, life: 0.35, color: brighten(c, 0.4), width: 3 });
        const n = Math.ceil(12 * this.density);
        for (let i = 0; i < n; i++) {
          const f = i / n;
          this.fx.spawn({ tex: A.streak, x: sx + (host.x - sx) * f, y: sy + (host.y - sy) * f,
            vx: (host.x - sx) * 1.5, vy: (host.y - sy) * 1.5, life: 0.25, color: c, s0: 0.5, s1: 0, flags: P_ORIENT | P_STRETCH, sy: 0.35, drag: 4 });
        }
        this.ring(host.x, host.y, 40, 12, 0.3, 0xffffff, 2, ev.hostShipId);
        this.flash(host.x, host.y, 0.8, c, 0.2);
        break;
      }
      case 'detach': {
        const tur = this.ships.get(ev.turretShipId);
        const ts = this.shipById.get(ev.turretShipId);
        if (!tur || !ts) break;
        const c = this.shipColor(ts);
        this.ring(tur.x, tur.y, 8, 50, 0.3, c, 2);
        this.burst(tur.x, tur.y, 10, c, 60, 220, 0.3, 0.4);
        break;
      }
      case 'ability': this.abilityFx(ev.shipId, ev.skill, ev.x, ev.y, ev.talent); break;
      case 'nova': {
        const c = ev.team === ENEMY_TEAM ? ENEMY_COLOR : colorFor(ev.team, 0);
        this.ring(ev.x, ev.y, 10, ev.radius, 0.5, brighten(c, 0.3), 4);
        this.ring(ev.x, ev.y, 5, ev.radius * 0.7, 0.4, 0xffffff, 1.5);
        this.grid?.impulse(ev.x, ev.y, ev.radius * 1.3, 500);
        break;
      }
      case 'arc': {
        const c = ev.team === ENEMY_TEAM ? ENEMY_COLOR : mix(0x9ff0ff, colorFor(ev.team, 0), 0.25);
        const src = ev.points;
        const pts: number[] = [];
        for (let i = 0; i + 3 < src.length; i += 2) {
          const x0 = src[i], y0 = src[i + 1], x1 = src[i + 2], y1 = src[i + 3];
          const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len, ny = dx / len;
          const seg = Math.max(2, Math.round(len / 22));
          if (i === 0) pts.push(x0, y0);
          for (let k = 1; k < seg; k++) {
            const f = k / seg, j = rand(-1, 1) * Math.min(14, len * 0.15);
            pts.push(x0 + dx * f + nx * j, y0 + dy * f + ny * j);
          }
          pts.push(x1, y1);
          this.burst(x1, y1, 4, c, 60, 200, 0.2, 0.35);
          this.flash(x1, y1, 0.5, c, 0.1, 0.7);
        }
        this.lines.push({ pts, t: 0, life: 0.15, color: c, width: 2.6 });
        break;
      }
      case 'waveStart':
        this.pulseTint(ev.boss ? 0xff1030 : 0x6a4bff, ev.boss ? 0.22 : 0.09, ev.boss ? 0.35 : 0.9);
        break;
      case 'fire': this.muzzleFx(ev.shipId, ev.skill, ev.x, ev.y); break;
      case 'shipSpawn': {
        const c = this.playerColor(frame, ev.playerId);
        this.ring(ev.x, ev.y, 90, 12, 0.45, c, 3, ev.shipId);
        this.ring(ev.x, ev.y, 10, 60, 0.4, 0xffffff, 1.5, ev.shipId);
        if (this.inView(ev.x, ev.y, 100)) this.burst(ev.x, ev.y, 16, c, 40, 180, 0.5, 0.45, { tex: A.dot, flags: 0 });
        break;
      }
      case 'matchEnd':
        this.pulseTint(0xffffff, 0.18, 0.4);
        break;
      case 'lootDrop': case 'lootPickup': case 'lootSpill': case 'lootSecured':
        this.lootLayer.event(ev, frame, this.lootHost);
        break;
      case 'objective':
        this.objLayer.event(ev, this.objHost);
        break;
      // v0.3 M4 rift (floorStart / lifeLost need no world FX: setMap and the HUD handle them)
      case 'roomSeal': case 'roomClear': case 'roomReset': case 'spawnWarn': case 'chestOpen': case 'bossIntro':
      case 'bossPhase': case 'telegraph': case 'portalOpen': case 'departing': case 'extract': case 'outOfLives':
      case 'partyWiped': case 'instability': case 'riftEnd':
        this.riftLayer.event(ev, frame.time, this.riftHost);
        break;
    }
  }

  private muzzleFx(shipId: EntityId, skill: SkillId, ex: number, ey: number): void {
    const s = this.shipById.get(shipId);
    if (!s || !this.inView(ex, ey, 30)) return;
    const d = this.ships.get(shipId);
    const c = this.shipColor(s);
    const x = d?.x ?? ex, y = d?.y ?? ey;
    const sc = s.attachedTo ? 0.8 : 1;
    const a = s.angle, r = this.shipRadius(s) * sc;
    const mx = x + Math.cos(a) * r * 1.25, my = y + Math.sin(a) * r * 1.25;
    const A = this.atlas;
    let flashC = brighten(c, 0.4), size = 0.45, life = 0.07, sparks = 2, spark = c;
    switch (skill) {
      case 'autocannon': flashC = 0xffb040; size = 0.85; life = 0.09; sparks = 3; spark = 0xffd080;
        if (Math.random() < 0.5 * this.density) this.trails.spawn({ tex: A.soft, x: mx, y: my, vx: Math.cos(a) * 40 + s.vx * 0.5, vy: Math.sin(a) * 40 + s.vy * 0.5, life: 0.5, color: 0x3a3040, s0: 0.2, s1: 0.5, alpha: 0.5 });
        break;
      case 'plasma': flashC = 0xb89bff; size = 0.6; life = 0.08; sparks = 2; spark = 0x9ff0ff;
        this.fx.spawn({ tex: A.ring, x: mx, y: my, life: 0.12, color: 0xb89bff, s0: 0.15, s1: 0.4, alpha: 0.9 });
        break;
      case 'rivet': flashC = 0xffffff; size = 0.28; life = 0.05; sparks = 1; spark = 0xe8f4ff; break;
      default: break;
    }
    // v0.3 muzzle preset (primary weapons of a non-turret ship; nothing for a hidden non-ally)
    const primary = skill === 'autocannon' || skill === 'plasma' || skill === 'rivet';
    const wl = primary && !s.attachedTo ? weaponFor(this.looks.get(s.playerId), s.shipClass) : null;
    const fa = d ? d.alpha : 1;
    const cosm = wl && wl.p.muzzle !== 'std' && (!d || d.ally || fa >= 0.2) ? wl : null;
    this.fx.spawn({ tex: A.soft, x: mx, y: my, life, color: flashC, s0: size, s1: size * 0.3, alpha: 0.9 });
    if (cosm && cosm.p.muzzle === 'ring') {
      this.fx.spawn({ tex: A.ring, x: mx, y: my, life: 0.14, color: cosm.p.accent, s0: 0.1, s1: 0.42 * (0.6 + size), alpha: 0.85 * fa });
    }
    if (cosm && cosm.p.muzzle === 'sparks') sparks += 3;
    if (Math.random() < this.density) {
      for (let i = 0; i < sparks; i++) {
        const aa = a + rand(-0.45, 0.45), sp = rand(200, 420);
        const acc = cosm && cosm.p.muzzle === 'sparks' && i % 2 === 1;
        this.fx.spawn({ tex: A.streak, x: mx, y: my, vx: Math.cos(aa) * sp + s.vx, vy: Math.sin(aa) * sp + s.vy, life: acc ? 0.14 : 0.1,
          color: acc ? cosm.p.accent : spark, s0: 0.3, s1: 0, flags: P_ORIENT | P_STRETCH, sy: 0.4, alpha: acc ? fa : 1 });
      }
    }
  }

  private abilityFx(shipId: EntityId, skill: SkillId, ex: number, ey: number, talent?: string): void {
    const A = this.atlas;
    const s = this.shipById.get(shipId);
    const c = s ? this.shipColor(s) : 0xffffff;
    const accent = s ? this.accentOf(s, c) : c;
    const { x, y } = this.shipPos(shipId, ex, ey);
    const a = s?.angle ?? 0;
    const near = this.inView(x, y, 300);
    if (talent) { this.talentFx(talent, x, y, ex, ey, accent); return; }
    if (!near) return;
    switch (skill) {
      case 'rockets': {
        for (const side of [1, -1]) {
          const px = x + Math.cos(a + side * 1.6) * 22, py = y + Math.sin(a + side * 1.6) * 22;
          this.burst(px, py, 6, 0x5a4a60, 20, 70, 0.6, 0.5, { tex: A.soft, flags: 0, drag: 2 });
          this.flash(px, py, 0.6, 0xffa040, 0.12);
        }
        break;
      }
      case 'ram':
        this.flash(x, y, 1.6, mix(accent, 0xffa030, 0.5), 0.2);
        this.ring(x, y, 14, 70, 0.25, mix(accent, 0xffd080, 0.3), 3);
        this.addShake(0.15, x, y);
        break;
      case 'ironhide':
        this.ring(x, y, 50, 30, 0.25, STEEL, 5, shipId);
        this.flash(x, y, 1.1, 0xffffff, 0.12);
        this.burst(x, y, 14, 0xe8f0ff, 120, 320, 0.3, 0.4);
        break;
      case 'arc':
        this.flash(x + Math.cos(a) * 22, y + Math.sin(a) * 22, 0.9, 0x9ff0ff, 0.12);
        break;
      case 'blink':
        break; // the 'blink' event carries the visuals
      case 'singularity':
        this.flash(x + Math.cos(a) * 24, y + Math.sin(a) * 24, 1.0, VOID_COLOR, 0.2);
        this.ring(x, y, 10, 60, 0.3, VOID_COLOR, 2.5);
        break;
      case 'sentry':
        this.flash(ex, ey, 0.8, brighten(c, 0.3), 0.15);
        break;
      case 'repair': {
        const hr = SHIP_CLASSES.engineer.base.skill.healRadius ?? 380;
        this.ring(x, y, 20, hr, 0.6, HEAL_COLOR, 4, shipId);
        this.ring(x, y, 10, hr * 0.6, 0.45, 0xd8ffe4, 1.5, shipId);
        this.burst(x, y, 22, HEAL_COLOR, 60, 260, 0.7, 0.45, { tex: A.plus, flags: 0, drag: 2, vyBias: -30 });
        this.grid?.impulse(x, y, hr * 0.8, 150);
        break;
      }
      case 'wall':
        this.ring(ex, ey, 8, 40, 0.25, brighten(c, 0.3), 2);
        break;
      default:
        this.flash(x, y, 0.8, accent, 0.15);
        break;
    }
  }

  private talentFx(talent: string, x: number, y: number, ex: number, ey: number, fallback: number): void {
    const A = this.atlas;
    const tal = TALENTS[talent];
    const accent = tal ? PATHS[tal.path].accent : fallback;
    switch (talent) {
      case 'ram_quake':
        this.ring(ex, ey, 20, 220, 0.45, accent, 5);
        this.ring(ex, ey, 10, 150, 0.35, 0xffe0b0, 2);
        this.burst(ex, ey, 26, accent, 200, 520, 0.4, 0.55);
        this.burst(ex, ey, 10, 0x4a3a50, 30, 120, 0.8, 0.6, { tex: A.soft, flags: 0, drag: 1.5 });
        this.grid?.impulse(ex, ey, 300, 900);
        this.addShake(0.35, ex, ey);
        break;
      case 'sto_thunder':
        this.ring(ex, ey, 10, 200, 0.4, accent, 4);
        this.ring(ex, ey, 5, 130, 0.3, 0xffffff, 2);
        this.burst(ex, ey, 20, brighten(accent, 0.3), 200, 480, 0.3, 0.45);
        for (let i = 0; i < 5; i++) {
          const a = rand(0, TAU), L = rand(120, 200);
          this.lines.push({ pts: [ex, ey, ex + Math.cos(a) * L * 0.5 + rand(-15, 15), ey + Math.sin(a) * L * 0.5 + rand(-15, 15), ex + Math.cos(a) * L, ey + Math.sin(a) * L], t: 0, life: 0.15, color: accent, width: 2 });
        }
        this.grid?.impulse(ex, ey, 260, 700);
        break;
      case 'voi_collapse':
        this.ring(ex, ey, 200, 5, 0.3, accent, 4);
        this.burst(ex, ey, 40, accent, 150, 600, 0.5, 0.6);
        this.flash(ex, ey, 3, accent, 0.3);
        this.startShock(ex, ey);
        this.addShake(0.3, ex, ey);
        break;
      case 'voi_riftstep':
        this.ring(ex, ey, 70, 5, 0.3, accent, 2.5);
        break;
      case 'sum_salvage':
        this.flash(ex, ey, 2, accent, 0.25);
        this.ring(ex, ey, 10, 160, 0.35, accent, 3);
        this.burst(ex, ey, 24, accent, 150, 420, 0.4, 0.5);
        break;
      case 'bar_cluster': case 'bar_napalm': case 'bar_autolauncher':
        this.burst(ex, ey, 10, accent, 100, 300, 0.3, 0.4);
        this.flash(ex, ey, 0.7, 0xffa040, 0.12);
        break;
      default:
        this.ring(x, y, 10, 60, 0.35, accent, 2.5);
        this.burst(x, y, 10, accent, 60, 200, 0.4, 0.35, { tex: A.dot, flags: 0 });
        break;
    }
  }

  private deployDeathFx(id: EntityId, kind: DeployableKind, ex: number, ey: number): void {
    const A = this.atlas;
    const d = this.deploys.get(id);
    const x = d?.x ?? ex, y = d?.y ?? ey;
    const c = d?.color ?? 0xffffff;
    const r = d?.radius ?? 14;
    if (!this.inView(x, y, 200)) return;
    switch (kind) {
      case 'sentry':
        this.burst(x, y, 10, mix(c, STEEL, 0.5), 60, 240, 1.0, 0.7, { tex: A.shard, flags: P_SPIN, drag: 1.5, sy: 1 });
        this.burst(x, y, 16, c, 120, 360, 0.4, 0.5);
        this.flash(x, y, 1.2, c, 0.25);
        this.ring(x, y, 8, 70, 0.35, c, 2.5);
        this.grid?.impulse(x, y, 140, 380);
        break;
      case 'wall': {
        const ang = d?.angle ?? 0, L = d?.length ?? 120;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const n = Math.ceil(Math.max(10, L / 10) * this.density);
        for (let i = 0; i < n; i++) {
          const f = (Math.random() - 0.5) * L, sp = rand(40, 200), aa = rand(0, TAU);
          this.fx.spawn({ tex: Math.random() < 0.5 ? A.diamond : A.shard, x: x + ca * f, y: y + sa * f, vx: Math.cos(aa) * sp, vy: Math.sin(aa) * sp,
            life: rand(0.4, 0.8), color: brighten(c, 0.3), s0: rand(0.25, 0.45), s1: 0, flags: P_SPIN, spin: rand(-8, 8), drag: 2 });
        }
        this.lines.push({ pts: [x - ca * L / 2, y - sa * L / 2, x + ca * L / 2, y + sa * L / 2], t: 0, life: 0.2, color: brighten(c, 0.5), width: 6 });
        break;
      }
      case 'well':
        this.ring(x, y, 60, 4, 0.25, c, 3);
        this.burst(x, y, 24, c, 120, 420, 0.45, 0.5);
        this.flash(x, y, 1.5, c, 0.2);
        break;
      case 'drone':
        this.burst(x, y, 12, c, 80, 260, 0.35, 0.4);
        this.flash(x, y, 0.6, c, 0.15);
        break;
      case 'fire':
        this.burst(x, y, 8, 0x4a3a50, 10, 50, 0.9, 0.6, { tex: A.soft, flags: 0, drag: 1, vyBias: -30 });
        break;
      case 'nanite':
        this.burst(x, y, 14, HEAL_COLOR, 30, 120, 0.6, 0.35, { tex: A.plus, flags: 0, vyBias: -20 });
        this.ring(x, y, r, r * 1.2, 0.3, HEAL_COLOR, 1.5, 0, 0.5);
        break;
    }
  }

  private pulseTint(color: number, a: number, decay: number): void {
    if (a >= this.tint.a * 0.7) { this.tint.color = color; this.tint.a = a; this.tint.decay = a * decay * 2; }
  }

  private startShock(x: number, y: number): void {
    if (this.quality < 1) return;
    this.shock.centerX = x * this.zoom + this.cam.x;
    this.shock.centerY = y * this.zoom + this.cam.y;
    this.shock.time = 0;
    if (!this.shockOn) { this.shockOn = true; this.worldRoot.filters = [this.shock, this.bloom]; }
  }

  // =============================================================================================
  // transient fx (rings / lines / heal tethers)

  private drawTethers(t: number, dt: number): void {
    const g = this.dynG;
    let w = 0;
    for (let i = 0; i < this.tethers.length; i++) {
      const q = this.tethers[i];
      q.t += dt;
      if (q.t >= q.life) continue;
      this.tethers[w++] = q;
      const a = this.ships.get(q.from), b = this.ships.get(q.to);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const al = 1 - q.t / q.life * 0.5;
      for (let pass = 0; pass < 2; pass++) {
        g.moveTo(a.x, a.y);
        const n = 10;
        for (let k = 1; k <= n; k++) {
          const f = k / n, wv = k === n ? 0 : Math.sin(f * 12 - t * 18) * 4 * Math.sin(f * Math.PI);
          g.lineTo(a.x + dx * f + nx * wv, a.y + dy * f + ny * wv);
        }
        if (pass === 0) g.stroke({ width: 7, color: HEAL_COLOR, alpha: 0.18 * al });
        else g.stroke({ width: 1.8, color: 0xd8ffe4, alpha: 0.9 * al });
      }
      if (Math.random() < 0.35 * this.density) {
        const f = Math.random();
        this.fx.spawn({ tex: this.atlas.plus, x: a.x + dx * f, y: a.y + dy * f, vx: dx / len * 120, vy: dy / len * 120, life: 0.3, color: HEAL_COLOR, s0: 0.3, s1: 0.1 });
      }
    }
    this.tethers.length = w;
  }

  private drawFx(dt: number): void {
    const g = this.dynG;
    let w = 0;
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      r.t += dt;
      if (r.t >= r.life) continue;
      this.rings[w++] = r;
      if (r.follow) { const d = this.ships.get(r.follow); if (d) { r.x = d.x; r.y = d.y; } }
      if (!this.inView(r.x, r.y, Math.max(r.r0, r.r1))) continue;
      const p = r.t / r.life;
      const e = 1 - (1 - p) * (1 - p) * (1 - p);
      const rad = r.r0 + (r.r1 - r.r0) * e;
      const a = (1 - p) * r.alpha;
      g.circle(r.x, r.y, rad).stroke({ width: r.width * 3.5 * (1 - p * 0.5), color: r.color, alpha: a * 0.18 });
      g.circle(r.x, r.y, rad).stroke({ width: r.width * (1 - p * 0.6), color: r.color, alpha: a });
    }
    this.rings.length = w;

    w = 0;
    for (let i = 0; i < this.lines.length; i++) {
      const l = this.lines[i];
      l.t += dt;
      if (l.t >= l.life) continue;
      this.lines[w++] = l;
      const a = 1 - l.t / l.life;
      const P = l.pts;
      for (let pass = 0; pass < 2; pass++) {
        g.moveTo(P[0], P[1]);
        for (let k = 2; k < P.length; k += 2) g.lineTo(P[k], P[k + 1]);
        if (pass === 0) g.stroke({ width: l.width * 3.5, color: l.color, alpha: a * 0.22, join: 'round' });
        else g.stroke({ width: l.width * (0.5 + a * 0.5), color: brighten(l.color, 0.5), alpha: a, join: 'round' });
      }
    }
    this.lines.length = w;
  }

  private drawReticle(frame: RenderFrame, t: number): void {
    const s = this.shipById.get(frame.localShipId);
    if (!s || !s.alive) return;
    const c = brighten(this.shipColor(s), 0.3);
    const o = this.overlayG, x = frame.aimX, y = frame.aimY;
    const r = 11 / this.zoom;
    const spin = t * 1.5;
    for (let i = 0; i < 4; i++) {
      const a = spin + (i * Math.PI) / 2;
      o.moveTo(x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6).lineTo(x + Math.cos(a) * r * 1.35, y + Math.sin(a) * r * 1.35);
    }
    o.stroke({ width: 1.8 / this.zoom, color: c, alpha: 0.9 });
    o.circle(x, y, r).stroke({ width: 1.2 / this.zoom, color: c, alpha: 0.55 });
    o.circle(x, y, 1.6 / this.zoom).fill({ color: 0xffffff, alpha: 0.9 });
  }

  // =============================================================================================
  // radar / big map

  private drawRadar(frame: RenderFrame): void {
    const show = !!this.map;
    this.radarBg.visible = this.radarMap.visible = this.radarDots.visible = show && !this.bigOpen;
    this.radarDots.clear();
    this.bigDots.clear();
    if (!this.map) return;
    if (this.bigOpen) this.drawMapDots(frame, this.bigDots, this.bigX, this.bigY, this.bigSize, true);
    else this.drawMapDots(frame, this.radarDots, this.radarX, this.radarY, this.radarSize, false);
  }

  private drawMapDots(frame: RenderFrame, g: Graphics, ox: number, oy: number, size: number, big: boolean): void {
    const m = this.map!;
    const sx = size / m.width, sy = size / m.height;
    // v0.3 M3: objective icons first, under every dot (stands / flags, zone pads, the hot point + next site)
    this.objLayer.drawRadar(frame, g, ox, oy, sx, sy, big, frame.time, this.objHost);
    // v0.3 M4 rift: doors by state, chests, portals, the anchor (fogged rooms stay hidden)
    this.riftLayer.drawRadar(frame, g, ox, oy, sx, sy, big, frame.time);
    const es = big ? 2.2 : 1.4;
    const rift = this.riftLayer.active;
    let anyE = false;
    let boss: EnemyView | null = null;
    for (const e of frame.enemies) {
      if (rift && !this.riftLayer.revealedAt(e.x, e.y)) continue; // room fog hides what is inside
      if (e.kind === 'matriarch') { boss = e; continue; }
      const r = e.kind === 'hive' || e.kind === 'blackhole' || e.kind === 'brute' ? es * 1.8 : es;
      g.rect(ox + e.x * sx - r / 2, oy + e.y * sy - r / 2, r, r); anyE = true;
    }
    if (anyE) g.fill({ color: ENEMY_COLOR, alpha: 0.85 });
    if (boss) {
      const bx = ox + boss.x * sx, by = oy + boss.y * sy, r = es * 2.6;
      g.rect(bx - r, by - r, r * 2, r * 2).fill({ color: ENEMY_COLORS.matriarch, alpha: 1 });
      g.circle(bx, by, r * 1.9 + (Math.floor(frame.time * 4) % 2) * 1.5).stroke({ width: 1.2, color: ENEMY_COLORS.matriarch, alpha: 0.9 });
    }
    // deployable ticks
    const ds = big ? 3 : 2;
    for (const dv of frame.deployables) {
      const x = ox + dv.x * sx, y = oy + dv.y * sy;
      if (dv.kind === 'wall') {
        const hl = Math.max(ds, (dv.length / 2) * sx);
        g.moveTo(x - Math.cos(dv.angle) * hl, y - Math.sin(dv.angle) * hl).lineTo(x + Math.cos(dv.angle) * hl, y + Math.sin(dv.angle) * hl);
      } else {
        g.moveTo(x - ds / 2, y).lineTo(x + ds / 2, y);
      }
      g.stroke({ width: 1, color: this.deployColor(dv), alpha: 0.9 });
    }
    const v = this.view;
    g.rect(ox + clamp(v.x0, 0, m.width) * sx, oy + clamp(v.y0, 0, m.height) * sy,
      (clamp(v.x1, 0, m.width) - clamp(v.x0, 0, m.width)) * sx, (clamp(v.y1, 0, m.height) - clamp(v.y0, 0, m.height)) * sy)
      .stroke({ width: 1, color: 0xffffff, alpha: 0.45 });
    const local = this.shipById.get(frame.localShipId);
    const blink = Math.floor(frame.time * 4) % 2 === 0;
    const ss = big ? 4 : 2.6;
    for (const s of frame.ships) {
      if (!s.alive || s.id === frame.localShipId || s.attachedTo) continue;
      const d = this.ships.get(s.id);
      const x = ox + (d?.x ?? s.x) * sx, y = oy + (d?.y ?? s.y) * sy;
      const ally = local && s.team >= 0 && s.team === local.team;
      const c = this.shipColor(s);
      if (ally) g.circle(x, y, ss * 0.8).fill({ color: c, alpha: 0.95 });
      else g.rect(x - ss * 0.8, y - ss * 0.8, ss * 1.6, ss * 1.6).fill({ color: c, alpha: 0.95 });
      // turret stack: one ring per attached turret
      for (let k = 0; k < s.turretCount; k++) g.circle(x, y, ss * 0.8 + 1.6 + k * 1.6).stroke({ width: 0.9, color: c, alpha: 0.8 });
    }
    if (local && local.alive) {
      const d = this.ships.get(local.id);
      const x = ox + (d?.x ?? local.x) * sx, y = oy + (d?.y ?? local.y) * sy;
      g.circle(x, y, ss * 1.1).fill({ color: blink ? 0xffffff : this.shipColor(local), alpha: 1 });
      for (let k = 0; k < local.turretCount; k++) g.circle(x, y, ss * 1.1 + 1.6 + k * 1.6).stroke({ width: 0.9, color: 0xffffff, alpha: 0.8 });
    }
    // v0.3 loot: rare+ caches (epic+ pulsing) and beacon carriers
    this.lootLayer.drawRadar(frame, g, ox, oy, sx, sy, big, frame.time, this.lootHost);
  }
}
