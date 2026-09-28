// v0.3 M3 objective HUD (docs/v0.3-proposal.md §5.7, §9 CLIENT): the top-centre objective strip (it replaces the
// classic clock + wave strip — one strip at a time), the centre capture bar while you stand in a zone, and the
// objective banners (pushed into the HUD's one shared banner queue). Wording, rules and "which banner, once" live
// in objectiveInfo.ts (pure, unit-tested); this file only draws.
import type { RenderFrame } from '../contracts';
import type { GameEvent, MapFeature, MatchView, ObjectiveGameEvent, ObjectiveSubMode, ObjectiveView } from '../../shared/types';
import type { GameClient } from '../net/GameClient';
import type { BannerQueue } from './bannerQueue';
import { h, replaceChildren, setStyle, setText, toggleClass } from './dom';
import {
  captureBarModel, clockModel, ctfHint, ctfModel, ffaTop, hotModel, ObjectiveAnnouncer, overloadModel, teamPointRows,
  zoneChips, type EventCtx, type ObjBanner, type ObjCtx, type SideScore,
} from './objectiveInfo';

interface FlagEls { root: HTMLElement; caps: HTMLElement; status: HTMLElement }
interface ZoneEls { root: HTMLElement; glyph: HTMLElement; badge: HTMLElement }
interface PointEls { root: HTMLElement; val: HTMLElement }

export class ObjectiveHud {
  /** Goes in the HUD's top-centre slot (hidden when the match has no objective). */
  readonly strip = h('div', { class: 'obj-strip hidden', role: 'status' });
  /** The centre capture bar (absolute; the HUD appends it to its root). */
  readonly bar = h('div', { class: 'obj-bar hidden' });

  private time = h('span', { class: 'obj-time' });
  private badge = h('span', { class: 'obj-badge hidden' });
  private main = h('div', { class: 'obj-main' });
  private points = h('div', { class: 'obj-points hidden' });
  private limitEl = h('span', { class: 'op-limit' });
  private carry = h('div', { class: 'obj-carry hidden' });
  private wave = h('div', { class: 'obj-wave hidden' });
  private barLabel = h('span', { class: 'ob-label' });
  private barText = h('span', { class: 'ob-text' });
  private barPct = h('span', { class: 'ob-pct' });
  private barTrack = h('div', { class: 'ob-track' });
  private barFill = h('div', { class: 'ob-fill' });

  private layoutKey = '';
  private flagEls: FlagEls[] = [];
  private zoneEls: ZoneEls[] = [];
  private pointEls: PointEls[] = [];
  private pointsKey = '';
  // hot point row (built with the layout)
  private hotOwner = h('span', { class: 'oh-owner' });
  private hotFill = h('div', { class: 'oh-fill' });
  private hotTimer = h('span', { class: 'oh-timer' });
  private hotNext = h('span', { class: 'oh-next hidden' });

  private ann = new ObjectiveAnnouncer();
  private visible = false;

  constructor(private client: GameClient) {
    this.strip.append(h('div', { class: 'obj-clock' }, this.time, this.badge), this.main, this.points, this.carry, this.wave);
    this.barTrack.append(this.barFill);
    this.bar.append(h('div', { class: 'ob-head' }, this.barLabel, this.barText, this.barPct), this.barTrack);
  }

  /** New match (or HUD shown): forget every per-match memory. */
  reset(): void {
    this.ann.reset();
    this.layoutKey = '';
    this.pointsKey = '';
    this.hide();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.strip.classList.add('hidden');
    this.bar.classList.add('hidden');
  }

  /** The viewer carries a flag (a carrier can't attach: the HUD dims its attach pip). */
  get carryingFlag(): boolean { return this.ann.carrying; }

  private ctx(f: RenderFrame | null): ObjCtx {
    const c = this.client;
    const ships = f?.ships ?? c.lastFrame?.ships ?? [];
    return {
      mode: c.mode,
      myTeam: c.me?.team ?? -2,
      myPid: c.playerId,
      myShipId: (f?.you ?? c.latest?.you)?.shipId ?? 0,
      name: (pid) => c.players.get(pid)?.name ?? (pid ? `#${pid}` : ''),
      shipPlayer: (id) => ships.find((s) => s.id === id)?.playerId ?? 0,
      teamOf: (pid) => c.players.get(pid)?.team,
    };
  }

  private pushAll(q: BannerQueue, list: readonly ObjBanner[], now: number): void {
    for (const b of list) q.push({ text: b.text, kind: b.kind, color: b.color, priority: b.priority, ms: b.ms }, now);
  }

  /** `objective` events → banners (the rest of the HUD handles every other event). */
  handleEvents(events: readonly GameEvent[], now: number, q: BannerQueue): void {
    const view = this.client.latest?.match.objective;
    if (!view) return;
    let obj: ObjectiveGameEvent[] | null = null;
    for (const ev of events) if (ev.t === 'objective') (obj ??= []).push(ev);
    if (!obj) return;
    const scores = this.client.latest?.match.teamScores ?? [];
    const ctx: EventCtx = {
      ...this.ctx(this.client.lastFrame),
      sub: view.mode, teamCount: this.client.teamCount, limit: view.limit, teamScore: (t) => scores[t] ?? 0,
    };
    this.pushAll(q, this.ann.onEvents(obj, view, ctx, now), now);
  }

  update(f: RenderFrame, now: number, q: BannerQueue): void {
    const m = f.match;
    const view = m?.objective;
    if (!m || !view) { this.hide(); return; }
    if (!this.visible) {
      this.visible = true;
      this.strip.classList.remove('hidden');
    }
    const ctx = this.ctx(f);
    const features = this.client.map?.features;
    // The viewer's drawn position (predicted ship, or its turret seat); spectators use the camera focus.
    const own = f.you && f.you.alive ? f.ships.find((s) => s.id === f.you!.shipId) : undefined;
    const pos = own ? { x: own.x, y: own.y } : { x: f.focusX, y: f.focusY };
    const tick = this.client.latest?.tick ?? 0;

    this.pushAll(q, this.ann.observe(view, ctx, tick, now), now);

    // Clock + overtime / sudden death badge.
    const clock = clockModel(m, view);
    setText(this.time, clock.text);
    toggleClass(this.time, 'hidden', !clock.text);
    toggleClass(this.time, 'low', clock.low);
    setText(this.badge, clock.badge);
    toggleClass(this.badge, 'hidden', !clock.badge);
    toggleClass(this.badge, 'sudden', !!view.suddenDeath);

    const layout = `${view.mode}|${this.client.mode}`;
    if (layout !== this.layoutKey) this.buildLayout(view.mode, layout);

    if (view.mode === 'ctf') this.updateCtf(view, m.teamScores, ctx);
    else if (view.mode === 'zones') this.updateZones(view, ctx);
    else if (view.mode === 'hotpoint') this.updateHot(view, ctx, features, pos, m);

    // Points row: team points (Zones / Hot teams) or the FFA top 3 (Hot FFA). CTF captures sit on the flag chips.
    let rows: SideScore[] = [];
    if (view.mode !== 'ctf') rows = this.client.mode === 'ffa' ? ffaTop(view.playerPoints, ctx) : teamPointRows(m.teamScores, m.teamCount, ctx);
    this.renderPoints(rows, view.limit);

    // CTF: the Flag Overload countdown while you carry.
    toggleClass(this.carry, 'hidden', !this.ann.carrying);
    if (this.ann.carrying) {
      const ov = overloadModel(this.ann.carrySec(tick));
      setText(this.carry, `⚑ ${ov.text}`);
      this.carry.className = `obj-carry lvl-${ov.level}`;
    }

    // Warzone Zones keeps its wave number in the strip.
    const wave = m.gameType === 'warzone' && m.wave > 0 ? `WAVE ${m.wave}` : '';
    setText(this.wave, wave);
    toggleClass(this.wave, 'hidden', !wave);

    this.updateBar(view, features, own ? pos : null, ctx);
  }

  // ------------------------------------------------------------------ strip rows

  private buildLayout(mode: ObjectiveSubMode, key: string): void {
    this.layoutKey = key;
    this.flagEls = [];
    this.zoneEls = [];
    this.strip.className = `obj-strip mode-${mode}`;
    if (mode === 'hotpoint') {
      replaceChildren(this.main,
        h('div', { class: 'obj-hot' },
          h('span', { class: 'oh-icon', 'aria-hidden': 'true' }, '✦'),
          this.hotOwner,
          h('div', { class: 'oh-track' }, this.hotFill),
          this.hotTimer,
          this.hotNext));
    } else {
      replaceChildren(this.main);
    }
  }

  private updateCtf(view: ObjectiveView, teamScores: readonly number[], ctx: ObjCtx): void {
    const model = ctfModel(view, teamScores, ctx);
    if (this.flagEls.length !== model.flags.length) {
      this.flagEls = model.flags.map(() => {
        const caps = h('span', { class: 'of-caps' });
        const status = h('span', { class: 'of-status' });
        const root = h('div', { class: 'obj-flag' }, h('span', { class: 'of-icon', 'aria-hidden': 'true' }, '⚑'), caps, status);
        return { root, caps, status };
      });
      replaceChildren(this.main, h('div', { class: 'obj-flags' }, this.flagEls.map((e) => e.root)));
    }
    model.flags.forEach((fm, i) => {
      const el = this.flagEls[i];
      setStyle(el.root, '--team', fm.color);
      setStyle(el.root, '--carrier', fm.carrierColor);
      const cls = `obj-flag s-${fm.state}${fm.mine ? ' mine' : ''}${fm.carrierIsMe ? ' you' : ''}`;
      if (el.root.className !== cls) el.root.className = cls;
      const title = `${fm.name} flag · ${fm.state}${fm.carrier ? ` (${fm.carrier})` : ''}`;
      if (el.root.title !== title) el.root.title = title;
      setText(el.caps, model.limit > 0 ? `${fm.caps}/${model.limit}` : String(fm.caps));
      setText(el.status, fm.status);
    });
  }

  private updateZones(view: ObjectiveView, ctx: ObjCtx): void {
    const chips = zoneChips(view, ctx);
    if (this.zoneEls.length !== chips.length) {
      this.zoneEls = chips.map(() => {
        const glyph = h('span', { class: 'oz-glyph' });
        const badge = h('span', { class: 'oz-badge hidden' });
        return { root: h('div', { class: 'obj-zone' }, glyph, badge), glyph, badge };
      });
      replaceChildren(this.main, h('div', { class: 'obj-zones' }, this.zoneEls.map((e) => e.root)));
    }
    chips.forEach((z, i) => {
      const el = this.zoneEls[i];
      setStyle(el.root, '--owner', z.ownerColor);
      setStyle(el.root, '--cap', z.capColor);
      setStyle(el.root, '--p', z.p.toFixed(3));
      toggleClass(el.root, 'owned', z.owned);
      toggleClass(el.root, 'mine', z.mine);
      toggleClass(el.root, 'threat', z.threat);
      toggleClass(el.root, 'contested', z.contested);
      toggleClass(el.root, 'inactive', !z.active);
      const title = `${z.name}${z.contested ? ' · contested' : ''}${z.swarm ? ' · swarm blocking' : ''}`;
      if (el.root.title !== title) el.root.title = title;
      setText(el.glyph, z.glyph);
      const badge = z.contested ? '⚔' : z.swarm ? '✺' : '';
      setText(el.badge, badge);
      toggleClass(el.badge, 'hidden', !badge);
      toggleClass(el.badge, 'swarm', !z.contested && z.swarm);
    });
  }

  private updateHot(
    view: ObjectiveView, ctx: ObjCtx, features: readonly MapFeature[] | undefined, pos: { x: number; y: number },
    clock: Pick<MatchView, 'timed' | 'timeLeftSec'>,
  ): void {
    const hm = hotModel(view, ctx, features, pos, clock);
    if (!hm) return;
    setText(this.hotOwner, hm.contested ? 'CONTESTED' : hm.ownerName);
    setStyle(this.hotOwner, '--team', hm.contested ? '#ffd43b' : hm.ownerColor);
    toggleClass(this.hotOwner, 'mine', hm.mine);
    setStyle(this.hotFill, 'width', `${(hm.p * 100).toFixed(1)}%`);
    setStyle(this.hotFill, '--cap', hm.capColor);
    setText(this.hotTimer, hm.timer);
    toggleClass(this.hotTimer, 'warn', hm.warn || hm.armIn > 0);
    setText(this.hotNext, hm.next);
    toggleClass(this.hotNext, 'hidden', !hm.next);
  }

  private renderPoints(rows: SideScore[], limit: number): void {
    const key = rows.map((r) => `${r.key}:${r.name}:${r.color}:${r.mine ? 1 : 0}`).join(',');
    if (key !== this.pointsKey) {
      this.pointsKey = key;
      this.pointEls = rows.map((r) => {
        const val = h('span', { class: 'op-val' });
        const root = h('div', { class: `op${r.mine ? ' mine' : ''}`, style: `--team:${r.color}`, title: r.name },
          h('span', { class: 'op-name' }, r.name), val);
        return { root, val };
      });
      replaceChildren(this.points, this.pointEls.map((e) => e.root), rows.length ? this.limitEl : null);
    }
    rows.forEach((r, i) => {
      setText(this.pointEls[i].val, String(r.value));
      toggleClass(this.pointEls[i].root, 'lead', r.lead);
    });
    setText(this.limitEl, limit > 0 ? `/ ${limit}` : '');
    toggleClass(this.points, 'hidden', rows.length === 0);
  }

  // ------------------------------------------------------------------ centre capture bar

  private updateBar(view: ObjectiveView, features: readonly MapFeature[] | undefined, pos: { x: number; y: number } | null, ctx: ObjCtx): void {
    const bm = pos ? captureBarModel(view, features, pos.x, pos.y, ctx) : null;
    if (bm) {
      const cls = `obj-bar st-${bm.state}`;
      if (this.bar.className !== cls) this.bar.className = cls;
      toggleClass(this.barTrack, 'hidden', false);
      setStyle(this.bar, '--cap', bm.color);
      setText(this.barLabel, bm.label);
      setText(this.barText, bm.text);
      setText(this.barPct, bm.state === 'cap' || bm.state === 'decap' || bm.state === 'secure' || bm.state === 'revert' ? `${Math.floor(bm.p * 100)}%` : '');
      setStyle(this.barFill, 'width', `${(bm.p * 100).toFixed(1)}%`);
      return;
    }
    const hint = pos && view.mode === 'ctf' ? ctfHint(view, features, pos.x, pos.y, ctx) : '';
    if (!hint) { toggleClass(this.bar, 'hidden', true); return; }
    if (this.bar.className !== 'obj-bar st-hint') this.bar.className = 'obj-bar st-hint';
    setText(this.barLabel, '⚑');
    setText(this.barText, hint);
    setText(this.barPct, '');
    toggleClass(this.barTrack, 'hidden', true);
  }
}
