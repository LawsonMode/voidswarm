// v0.3 M4 rift HUD (docs/v0.3-proposal.md §4, §9 CLIENT M4). HUD layout rule: the rift strip is the ONE top-centre
// strip (FLOOR n/N · biome · lives · rooms c/R · mm:ss, amber after RIFT_WARN_SEC); the boss bar sits below it; rift
// banners go into the HUD's one shared banner queue below that. Also: the party roster (in place of the team-score
// strip), the out-of-lives waiting overlay (the camera follows RiftYou.followId — GameClient), the extract ring, the
// off-screen Descend / Extract arrows, and the 0.6 s floor-start flash. Wording and rules live in riftInfo.ts (pure,
// unit-tested); this file only draws, with cached writes (setText / setStyle / toggleClass) every frame.
import type { RenderFrame } from '../contracts';
import { hudInsets } from '../hudInsets';
import type { GameEvent, PlayerId } from '../../shared/types';
import type { GameClient } from '../net/GameClient';
import type { BannerQueue } from './bannerQueue';
import { h, replaceChildren, setStyle, setText, toggleClass } from './dom';
import { fmtDist } from './objectiveInfo';
import {
  bossBarModel, edgeArrow, extractRingModel, isFinalFloor, mergeArrows, partyOf, portalTargets, riftSpectateModel,
  riftStripModel, RiftAnnouncer, rosterModel, ROSTER_GLYPHS, shipPilotName, waitingModel,
  type OverlayModel, type PlacedArrow, type RiftBanner, type RiftCtx,
} from './riftInfo';

/** Floor-start flash length (ms), §9 CLIENT M4. */
export const FLOOR_FLASH_MS = 600;
/** Arrow pins stay this far inside the uncovered view edges (px). */
const ARROW_MARGIN = 34;
const ROSTER_EVERY_MS = 250;

interface ArrowEls { root: HTMLElement; glyph: HTMLElement; label: HTMLElement }

export interface RiftHudOpts {
  /** World → view px for this frame (null = unknown: no off-screen arrows). */
  project?: () => ((x: number, y: number) => { x: number; y: number }) | null;
}

export class RiftHud {
  /** Top-centre strip (the HUD puts it in its top-middle slot). */
  readonly strip = h('div', { class: 'rift-strip hidden', role: 'status' });
  /** Boss bar, below the strip. */
  readonly boss = h('div', { class: 'rift-boss hidden', role: 'status' });
  /** Party roster (the HUD puts it where the team-score strip goes). */
  readonly roster = h('div', { class: 'rift-roster hidden' });
  /** Out-of-lives / extracted overlay (centre). */
  readonly overlay = h('div', { class: 'rift-wait hidden' });
  /** Extract channel ring (around the local ship at the view centre). */
  readonly ring = h('div', { class: 'rift-ring hidden' });
  /** Off-screen portal arrows. */
  readonly arrows = h('div', { class: 'rift-arrows' });
  /** Full-view floor-start flash. */
  readonly flash = h('div', { class: 'rift-flash', 'aria-hidden': 'true' });

  private sFloor = h('span', { class: 'rs-floor' });
  private sBiome = h('span', { class: 'rs-biome' });
  private sLives = h('span', { class: 'rs-lives' });
  private sRooms = h('span', { class: 'rs-rooms' });
  private sClock = h('span', { class: 'rs-clock' });
  private sBadge = h('span', { class: 'rs-badge hidden' });
  private bName = h('span', { class: 'rb-name' });
  private bPhase = h('span', { class: 'rb-phase' });
  private bPips = h('span', { class: 'rb-pips' });
  private bPct = h('span', { class: 'rb-pct' });
  private bFill = h('div', { class: 'rb-fill' });
  private ringLabel = h('span', { class: 'rr-label' });
  private ringPct = h('span', { class: 'rr-pct' });
  private arrowEls: ArrowEls[] = [];

  private ann = new RiftAnnouncer();
  private extracted = new Set<PlayerId>();
  /** Run (mapSeed) `extracted` belongs to: a rift re-sends matchStart within one run (a drop-in at a floor start). */
  private extractedSeed = -1;
  private visible = false;
  private pipsKey = '';
  private rosterKey = '';
  private rosterAt = -1e9;
  private overlayKey = '';
  private flashUntil = 0;
  /** Banners raised outside a frame (floorStart), handed to the HUD's queue on its next update. */
  private pending: RiftBanner[] = [];

  constructor(private client: GameClient, private opts: RiftHudOpts = {}) {
    this.strip.append(this.sFloor, dot(), this.sBiome, dot(), this.sLives, dot(), this.sRooms, dot(), this.sClock, this.sBadge);
    this.boss.append(
      h('div', { class: 'rb-head' }, h('span', { class: 'rb-skull', 'aria-hidden': 'true' }, '☠'), this.bName, this.bPhase, this.bPips, this.bPct),
      h('div', { class: 'rb-track' }, this.bFill));
    this.ring.append(h('div', { class: 'rr-disc' }), h('div', { class: 'rr-text' }, this.ringLabel, this.ringPct));
    client.on('floorStart', (floor) => this.onFloor(floor));
  }

  /**
   * New match (or HUD shown): forget every per-match memory — except who extracted, while it is still the same run
   * (same mapSeed): a pending drop-in gets a second matchStart at its floor start, and the pilots who extracted before
   * must stay "⇪ out" in the roster, not turn "✕ dead".
   */
  reset(): void {
    this.ann.reset();
    const seed = this.client.matchSeed;
    if (seed < 0 || seed !== this.extractedSeed) this.extracted.clear();
    this.extractedSeed = seed;
    this.pending = [];
    this.pipsKey = this.rosterKey = this.overlayKey = '';
    this.rosterAt = -1e9;
    this.flashUntil = 0;
    this.flash.classList.remove('on');
    this.hide();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    for (const el of [this.strip, this.boss, this.roster, this.overlay, this.ring]) el.classList.add('hidden');
    for (const a of this.arrowEls) a.root.classList.add('hidden');
  }

  /** The client moved the run to a new floor: flash, and announce it (once). */
  private onFloor(floor: number): void {
    const now = performance.now();
    this.flash.classList.remove('on');
    void this.flash.offsetWidth;
    this.flash.classList.add('on');
    this.flashUntil = now + FLOOR_FLASH_MS;
    this.pending.push(...this.ann.onFloor(floor, this.client.map?.dungeon));
  }

  private ctx(f: RenderFrame | null): RiftCtx {
    const c = this.client;
    const you = f?.you ?? c.latest?.you ?? null;
    return {
      myPid: c.playerId,
      party: partyOf(you, c.me?.team),
      name: (pid) => c.players.get(pid)?.name ?? (pid ? `#${pid}` : ''),
      layout: c.map?.dungeon,
      view: c.latest?.match.dungeon ?? null,
    };
  }

  private pushAll(q: BannerQueue, list: readonly RiftBanner[], now: number): void {
    for (const b of list) q.push({ text: b.text, kind: b.kind, priority: b.priority, ms: b.ms }, now);
  }

  /** Released events → rift banners (and extraction memory for the roster). */
  handleEvents(events: readonly GameEvent[], now: number, q: BannerQueue): void {
    if (this.client.gameType !== 'dungeon') return;
    for (const ev of events) if (ev.t === 'extract') this.extracted.add(ev.playerId);
    this.pushAll(q, this.ann.onEvents(events, this.ctx(this.client.lastFrame), now), now);
  }

  /** Spectating a rift: a pending drop-in / an extracted pilot's line (null = the default spectate line). */
  spectateLine(targetName: string): OverlayModel | null {
    const c = this.client;
    if (c.gameType !== 'dungeon') return null;
    return riftSpectateModel({ dropIn: c.riftDropInPending, extracted: c.riftExtracted }, targetName);
  }

  /** True while the waiting / extracted overlay replaces the respawn line. */
  get overlayShown(): boolean { return this.visible && !this.overlay.classList.contains('hidden'); }

  update(f: RenderFrame, now: number, q: BannerQueue): void {
    if (this.flashUntil && now > this.flashUntil) { this.flash.classList.remove('on'); this.flashUntil = 0; }
    const view = f.match?.dungeon;
    if (!view) { this.hide(); return; }
    if (!this.visible) {
      this.visible = true;
      this.strip.classList.remove('hidden');
      this.roster.classList.remove('hidden');
    }
    if (this.pending.length) { this.pushAll(q, this.pending, now); this.pending = []; }
    this.pushAll(q, this.ann.observe(view), now);
    const c = this.client;
    const you = f.you;
    if (you?.rift?.extracted) this.extracted.add(c.playerId);
    const party = partyOf(you, c.me?.team);

    // Strip.
    const sm = riftStripModel(view, party);
    setText(this.sFloor, sm.floor);
    setText(this.sBiome, sm.biome);
    setClass(this.sBiome, `rs-biome b-${sm.biomeKey || 'none'}`);
    setText(this.sLives, `♥ ${sm.lives}`);
    setTitle(this.sLives, `${sm.lives} shared ${sm.lives === 1 ? 'life' : 'lives'}`);
    toggleClass(this.sLives, 'low', sm.livesLevel === 1);
    toggleClass(this.sLives, 'none', sm.livesLevel === 2);
    setText(this.sRooms, sm.rooms);
    setText(this.sClock, sm.clock);
    toggleClass(this.sClock, 'warn', sm.clockLevel === 1);
    toggleClass(this.sClock, 'unstable', sm.clockLevel === 2);
    setText(this.sBadge, sm.badge);
    setClass(this.sBadge, `rs-badge k-${sm.badgeKind || 'none'}${sm.badge ? '' : ' hidden'}`);

    // Boss bar.
    const bm = bossBarModel(view);
    toggleClass(this.boss, 'hidden', !bm);
    if (bm) {
      setText(this.bName, bm.name);
      setText(this.bPhase, bm.phaseName);
      toggleClass(this.bPhase, 'hidden', !bm.phaseName);
      setText(this.bPct, bm.pct);
      setStyle(this.bFill, 'width', `${(bm.hpFrac * 100).toFixed(1)}%`);
      const pk = `${bm.phases}|${bm.phase}`;
      if (pk !== this.pipsKey) {
        this.pipsKey = pk;
        replaceChildren(this.bPips, Array.from({ length: bm.phases }, (_, i) => h('span', { class: `rb-pip${i < bm.phase ? ' on' : ''}` })));
      }
      toggleClass(this.boss, 'enraged', bm.phase >= 3);
    }

    // Party roster.
    if (now - this.rosterAt >= ROSTER_EVERY_MS) {
      this.rosterAt = now;
      const members = c.playerList.filter((p) => p.team === party || this.extracted.has(p.playerId));
      const rows = rosterModel(members, f.ships, view, this.extracted, c.playerId);
      const key = rows.map((r) => `${r.playerId}:${r.state}:${r.name}`).join(',');
      if (key !== this.rosterKey) {
        this.rosterKey = key;
        replaceChildren(this.roster, rows.map((r) => h('div', { class: `rr-row s-${r.state}${r.me ? ' me' : ''}`, title: `${r.name} · ${r.state}` },
          h('span', { class: 'rr-glyph' }, ROSTER_GLYPHS[r.state]),
          h('span', { class: 'rr-name' }, r.name),
          r.bot ? h('span', { class: 'badge bot' }, 'BOT') : null)));
      }
    }

    // Waiting / extracted overlay (the camera already follows followId).
    const followName = shipPilotName(f.ships, you?.rift?.followId ?? 0, (pid) => c.players.get(pid)?.name ?? '');
    const wm = you && !you.alive ? waitingModel(you.rift, followName) : null;
    toggleClass(this.overlay, 'hidden', !wm);
    if (wm) {
      const key = `${wm.big}\n${wm.small}`;
      if (key !== this.overlayKey) {
        this.overlayKey = key;
        replaceChildren(this.overlay, h('div', { class: 'big' }, wm.big), h('div', { class: 'small' }, wm.small));
        setClass(this.overlay, `rift-wait${you?.rift?.extracted ? ' extracted' : ''}`);
      }
    }

    // Extract ring, around the own ship where the renderer drew it (its camera leads the aim, so not always centred).
    const rm = extractRingModel(you, isFinalFloor(view));
    toggleClass(this.ring, 'hidden', !rm);
    let project: ReturnType<NonNullable<RiftHudOpts['project']>> | undefined;
    const projector = () => (project === undefined ? (project = this.opts.project?.() ?? null) : project);
    if (rm) {
      setStyle(this.ring, '--p', rm.frac.toFixed(3));
      setText(this.ringLabel, rm.label);
      setText(this.ringPct, rm.pct);
      const own = you ? f.ships.find((s) => s.id === you.shipId) : undefined;
      const p = own ? projector()?.(own.x, own.y) : undefined;
      const ok = !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
      setStyle(this.ring, 'left', ok ? `${p!.x.toFixed(0)}px` : '50%');
      setStyle(this.ring, 'top', ok ? `${p!.y.toFixed(0)}px` : '50%');
    }

    this.updateArrows(f, projector);
  }

  /** Off-screen Descend / Extract pointers, pinned inside the view edges the HUD doesn't cover. */
  private updateArrows(f: RenderFrame, projector: () => ((x: number, y: number) => { x: number; y: number }) | null): void {
    const targets = portalTargets(f.match?.dungeon, this.client.map?.dungeon);
    const project = targets.length ? projector() : null;
    const w = typeof window !== 'undefined' ? window.innerWidth : 0;
    const hgt = typeof window !== 'undefined' ? window.innerHeight : 0;
    const ins = hudInsets();
    let used = 0;
    if (project && w > 0 && hgt > 0) {
      const inset = { top: ins.top + ARROW_MARGIN, bottom: ins.bottom + ARROW_MARGIN, side: ARROW_MARGIN };
      const placed: PlacedArrow[] = [];
      for (const t of targets) {
        const p = project(t.x, t.y);
        const a = edgeArrow(p.x, p.y, w, hgt, inset);
        if (a) placed.push({ ...a, kind: t.kind, label: t.label, dist: Math.hypot(t.x - f.focusX, t.y - f.focusY) });
      }
      for (const a of mergeArrows(placed)) {
        const el = this.arrowEl(used++);
        setClass(el.root, `rift-arrow k-${a.kind}`);
        setStyle(el.root, 'transform', `translate(${a.x.toFixed(0)}px, ${a.y.toFixed(0)}px)`);
        setStyle(el.glyph, 'transform', `rotate(${a.angle.toFixed(3)}rad)`);
        setText(el.label, `${a.label} ${fmtDist(a.dist)}`);
      }
    }
    for (let i = used; i < this.arrowEls.length; i++) this.arrowEls[i].root.classList.add('hidden');
  }

  private arrowEl(i: number): ArrowEls {
    let el = this.arrowEls[i];
    if (!el) {
      const glyph = h('span', { class: 'ra-glyph', 'aria-hidden': 'true' }, '➤');
      const label = h('span', { class: 'ra-label' });
      el = { root: h('div', { class: 'rift-arrow' }, glyph, label), glyph, label };
      this.arrowEls.push(el);
      this.arrows.appendChild(el.root);
    }
    return el;
  }
}

/** className / title writes only when they change (per-frame HUD). */
function setClass(el: HTMLElement, cls: string): void {
  if (el.className !== cls) el.className = cls;
}

function setTitle(el: HTMLElement, t: string): void {
  if (el.title !== t) el.title = t;
}

function dot(): HTMLElement {
  return h('span', { class: 'rs-dot', 'aria-hidden': 'true' }, '·');
}
