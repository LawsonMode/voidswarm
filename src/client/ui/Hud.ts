// In-match HUD (DOM overlay over the canvas). Updated every frame with cached writes.
// v0.3 M2: the unsecured-loot tray above the skill bar (rarity pips, per-mode hint, HOLD FULL toast), loot
// banners in the one shared banner queue, the killer's kill icon in the feed, and a first-time death-drop tip.
// v0.3 M3: objective sub-modes swap the classic clock + wave strip for the ObjectiveHud strip (one top-centre strip),
// add its centre capture bar, and feed objective banners into the same queue.
// v0.3 M4: in a rift the RiftHud strip is the top-centre strip (boss bar below it, rift banners in the same queue), a
// party roster replaces the team-score strip, and the out-of-lives overlay / extract ring / portal arrows / floor flash
// join the HUD (RiftHud.ts; wording in riftInfo.ts).
import type { RenderFrame } from '../contracts';
import { setHudInsets } from '../hudInsets';
import { LASER_RESONANCE, LOOT_PICKUP_PAD, NO_TEAM, PATH_LEVEL, TURRET_HOST_FLOOR_FRAC } from '../../shared/constants';
import { PATHS, SHIP_CLASSES, TALENTS } from '../../shared/data/ships';
import { teamName } from '../../shared/data/teams';
import {
  BEAM_LASER, BEAM_WELD, SHIPFLAG_CHARGING, SHIPFLAG_SHIELD,
  type DeployableKind, type GameEvent, type PlayerId, type ShipView, type YouState,
} from '../../shared/types';
import { hostEnergyState, hostLaserDraw, laserResonance } from '../net/attach';
import type { GameClient } from '../net/GameClient';
import { loadStr, saveStr } from '../storage';
import { BannerQueue } from './bannerQueue';
import { ChatView } from './ChatView';
import { accentCss, SLOT_KEYS, SLOT_ORDER, slotCost } from './classInfo';
import { fmtClock, h, replaceChildren, setStyle, setText, teamCss, toggleClass } from './dom';
import { hudShowsClock, hudWaveText, rarityCss } from './gameTypeInfo';
import { cacheInReach, killiconGlyph, lootBannerFor, trayModel } from './lootInfo';
import { LevelUpCards } from './LevelUpCards';
import { ObjectiveHud } from './ObjectiveHud';
import { hudShowsObjective } from './objectiveInfo';
import { RiftHud } from './RiftHud';
import { hudShowsRift, partyOf, projectorFrom, riftRespawnLine } from './riftInfo';
import { teamColorCss } from './RoomLobby';
import { SkillBar } from './SkillBar';
import { turretOffenseCooldown, TurretReload } from './turretReload';

interface FeedEntry { el: HTMLElement; at: number }

const FEED_MS = 7000;
/** How often the HUD re-measures the view edges it covers for the renderer's edge pointers (ms). */
const INSETS_EVERY_MS = 400;
const FEED_MAX = 6;

const DEPLOY_ICONS: Record<DeployableKind, [string, string]> = {
  sentry: ['🛰', 'Sentries'],
  wall: ['🧱', 'Walls'],
  well: ['🕳', 'Wells'],
  drone: ['🛸', 'Drones'],
  fire: ['🔥', 'Napalm'],
  nanite: ['💠', 'Nanites'],
};
const DEPLOY_ORDER: DeployableKind[] = ['sentry', 'drone', 'wall', 'well', 'fire', 'nanite'];

/** localStorage flag: the first-time "your caches spilled" tip was shown on this device. */
export const KEY_TIP_SPILL = 'voidswarm.tip.deathDrop';
const HOLD_TOAST_MS = 1600;
/** At most one HOLD FULL toast per this long (touching a cache while full re-shows it). */
const HOLD_TOAST_GAP_MS = 3500;
const TIP_MS = 9000;
/** Once you are flying again the tip gets out of the way (it sits over the centre of the screen). */
const TIP_MIN_MS = 3500;

/** First-time death-drop tip, per game type (caches bank at extraction in a rift, at match end elsewhere). */
export function spillTipText(gameType: string): string {
  return gameType === 'dungeon'
    ? 'Your unsecured caches spilled where you died. Grab them back, then extract after a boss to bank them.'
    : 'Your unsecured caches spilled where you died, and anyone can grab them. Survive to the end of the match to keep what you carry.';
}

export interface HudOpts {
  /** The renderer's camera (view px → world px), for the rift's off-screen portal arrows. */
  screenToWorld?: (sx: number, sy: number) => { x: number; y: number };
}

export class Hud {
  readonly root: HTMLElement;
  readonly chat: ChatView;
  private timer = h('div', { class: 'hud-timer' });
  private wave = h('div', { class: 'hud-wave' });
  private scoresStrip = h('div', { class: 'hud-scores' });
  private feed = h('div', { class: 'killfeed' });
  private banner = h('div', { class: 'hud-banner hidden' });
  private banners = new BannerQueue();
  private bannerSeq = -1;
  // v0.3 loot tray (above the skill bar), HOLD FULL toast, first-time spill tip
  private tray = h('div', { class: 'loot-tray hidden' });
  private trayPips = h('div', { class: 'lt-pips' });
  private trayCount = h('span', { class: 'lt-count' });
  private trayHint = h('span', { class: 'lt-hint' });
  private holdToast = h('div', { class: 'loot-toast hidden' }, 'HOLD FULL');
  private tip = h('div', { class: 'loot-tip hidden', role: 'note' });
  private trayKey = '';
  private wasFull = false;
  private holdToastAt = -1e9;
  private holdToastUntil = 0;
  private tipUntil = 0;
  private tipAt = 0;
  private respawn = h('div', { class: 'respawn hidden' });
  private turret = h('div', { class: 'turret-status hidden' });
  private spectate = h('div', { class: 'spectate hidden' });
  private panel: HTMLElement;
  private energyWrap = h('div', { class: 'energy' });
  private energyFill = h('div', { class: 'energy-fill' });
  private energyNum = h('div', { class: 'energy-num' });
  private hostWrap = h('div', { class: 'host-energy hidden' });
  private hostFill = h('div', { class: 'energy-fill' });
  private hostLabel = h('div', { class: 'host-label' });
  private xpFill = h('div', { class: 'xp-fill' });
  private levelEl = h('div', { class: 'level' });
  private bountyEl = h('div', { class: 'bounty' });
  private pathBadge = h('div', { class: 'path-badge' });
  private skills = new SkillBar();
  private attachPip = h('div', { class: 'pip attach-pip', title: 'Attach (F / Y)' }, h('span', null, 'ATT'));
  private deployEl = h('div', { class: 'deploys' });
  private resonanceEl = h('div', { class: 'resonance hidden' });
  private talentsEl = h('div', { class: 'talent-row' });
  private cards: LevelUpCards;
  private upgrades = h('div', { class: 'upgrade-list' });
  private stats = h('div', { class: 'hud-stats' });
  private feedEntries: FeedEntry[] = [];
  private upgradesKey = '';
  private scoresKey = '';
  private pathKey = '';
  private talentsKey = '';
  private deployKey = '';
  private lastScoresAt = 0;
  private turretReload = new TurretReload();
  /** v0.3 M3: objective strip + capture bar + objective banners. */
  private obj: ObjectiveHud;
  /** v0.3 M4: rift strip + boss bar + roster + waiting overlay + extract ring + portal arrows + floor flash. */
  private rift: RiftHud;
  private top: HTMLElement;
  private bottom: HTMLElement;
  private insetsAt = -1e9;

  constructor(
    private client: GameClient, onPick: (i: number) => void, onChatFocus: (f: boolean) => void, onUi: (n: string) => void,
    opts: HudOpts = {},
  ) {
    this.chat = new ChatView({
      placeholder: 'Chat… (Enter to send, Esc to cancel, // team)', channelToggle: true, fading: true,
      onSend: (ch, text) => { client.sendChat(ch, text); onUi('chat'); },
      onFocusChange: onChatFocus,
      maxLines: 40,
    });
    this.cards = new LevelUpCards(onPick);
    this.obj = new ObjectiveHud(client);
    const s2w = opts.screenToWorld;
    this.rift = new RiftHud(client, { project: () => (s2w ? projectorFrom(s2w) : null) });
    this.energyWrap.append(this.energyFill, this.energyNum);
    this.hostWrap.append(
      this.hostFill,
      h('div', { class: 'host-floor', style: `left:${TURRET_HOST_FLOOR_FRAC * 100}%` }),
      this.hostLabel);
    this.panel = h('div', { class: 'hud-panel' },
      h('div', { class: 'hud-row' }, this.pathBadge, this.levelEl, h('div', { class: 'xp' }, this.xpFill), this.bountyEl),
      this.hostWrap,
      this.energyWrap,
      h('div', { class: 'hud-row skills-row' }, this.skills.root, this.attachPip,
        h('div', { class: 'hud-side' }, this.resonanceEl, this.deployEl)),
      this.talentsEl);
    this.tray.append(h('span', { class: 'lt-label' }, 'UNSECURED'), this.trayPips, this.trayCount, this.trayHint);
    this.top = h('div', { class: 'hud-top' }, this.scoresStrip, this.rift.roster,
      h('div', { class: 'hud-top-mid' }, this.timer, this.wave, this.obj.strip, this.rift.strip, this.rift.boss), this.stats);
    this.bottom = h('div', { class: 'hud-bottom' }, this.cards.root, this.turret, h('div', { class: 'loot-tray-wrap' }, this.holdToast, this.tray), this.panel);
    this.root = h('div', { class: 'screen hud' },
      this.rift.flash,
      this.rift.arrows,
      this.top,
      this.feed,
      this.banner,
      this.obj.bar,
      this.respawn,
      this.rift.overlay,
      this.rift.ring,
      this.tip,
      this.spectate,
      h('div', { class: 'hud-chat' }, this.chat.root),
      this.upgrades,
      this.bottom);
    client.on('chat', (l) => { if (client.matchActive) this.chat.add(l); });
    client.on('chatReset', () => this.chat.setLines(client.chat.slice(-12)));
    client.on('matchStart', () => { this.obj.reset(); this.rift.reset(); });
  }

  onShow(): void {
    this.chat.setLines(this.client.chat.slice(-8));
    this.feedEntries.forEach((e) => e.el.remove());
    this.feedEntries = [];
    this.upgradesKey = this.scoresKey = this.pathKey = this.talentsKey = this.deployKey = '';
    this.cards.render(null, 0);
    this.turretReload.reset();
    this.banners.clear();
    this.bannerSeq = -1;
    this.banner.classList.add('hidden');
    this.trayKey = '';
    this.wasFull = false;
    this.holdToastUntil = this.tipUntil = 0;
    this.tray.classList.add('hidden');
    this.holdToast.classList.add('hidden');
    this.tip.classList.add('hidden');
    this.obj.reset();
    this.rift.reset();
  }

  /**
   * Tell the renderer how much of the view the top row (scores / objective strip / stats) and the bottom block
   * (skill panel, XP bar, loot tray) cover, so off-screen objective pointers stay clear of them (client/hudInsets).
   * Measured a few times a second (getBoundingClientRect forces a layout), not every frame.
   */
  private reportInsets(now: number): void {
    if (now - this.insetsAt < INSETS_EVERY_MS) return;
    this.insetsAt = now;
    const root = this.root.getBoundingClientRect();
    if (!(root.height > 0)) return;
    const top = this.top.getBoundingClientRect();
    const bottom = this.bottom.getBoundingClientRect();
    setHudInsets(top.height > 0 ? top.bottom - root.top : 0, bottom.height > 0 ? root.bottom - bottom.top : 0);
  }

  private name(pid: PlayerId): string {
    return this.client.players.get(pid)?.name ?? `#${pid}`;
  }

  private color(pid: PlayerId): string {
    const p = this.client.players.get(pid);
    return teamCss(p ? (this.client.mode === 'ffa' ? NO_TEAM : p.team) : NO_TEAM, pid);
  }

  handleEvents(events: readonly GameEvent[], now: number): void {
    const me = this.client.playerId;
    for (const ev of events) {
      if (ev.t === 'shipDeath') {
        const victim = h('span', { style: `color:${this.color(ev.playerId)}` }, this.name(ev.playerId));
        let row: HTMLElement;
        if (ev.cause === 'player' && ev.killerPlayerId) {
          // v0.3: the killer's equipped kill icon (starter ✦), in the killer's team colour.
          const killer = this.color(ev.killerPlayerId);
          const glyph = killiconGlyph(this.client.players.get(ev.killerPlayerId)?.cosmetics);
          row = h('div', { class: 'feed-row' },
            h('span', { style: `color:${killer}` }, this.name(ev.killerPlayerId)),
            h('span', { class: 'feed-icon killicon', style: `color:${killer}` }, ` ${glyph} `), victim,
            ev.bounty ? h('span', { class: 'feed-bounty' }, ` +${ev.bounty}`) : null);
        } else {
          row = h('div', { class: 'feed-row' }, victim, h('span', { class: 'feed-icon' }, ev.cause === 'enemy' ? ' ✕ the Swarm' : ' ✕ self-destructed'));
        }
        if (ev.killerPlayerId === me && ev.playerId !== me) row.classList.add('mine');
        if (ev.playerId === me) row.classList.add('victim');
        this.feed.appendChild(row);
        this.feedEntries.push({ el: row, at: now });
        while (this.feedEntries.length > FEED_MAX) this.feedEntries.shift()!.el.remove();
      } else if (ev.t === 'waveStart') {
        if (this.client.gameType === 'dungeon') continue; // a rift's wave is its enemy tier: never announced
        this.banners.push(ev.boss
          ? { text: `⚠ HIVE INBOUND — WAVE ${ev.wave}`, kind: 'boss', priority: 3, ms: 2600 }
          : { text: `WAVE ${ev.wave}`, kind: 'wave', priority: 2, ms: 2600 }, now);
      } else if (ev.t === 'levelUp' && ev.playerId === me) {
        this.banners.push({
          text: ev.level === PATH_LEVEL ? `LEVEL ${ev.level} — CHOOSE YOUR PATH` : `LEVEL ${ev.level}`,
          kind: 'level', priority: 2, ms: 1600,
        }, now);
      } else if (ev.t === 'lootPickup' || ev.t === 'lootSpill' || ev.t === 'lootSecured' || ev.t === 'lootDrop') {
        const b = lootBannerFor(ev, me);
        if (b) this.banners.push({ text: b.text, kind: 'loot', rarity: b.rarity, priority: b.priority, ms: b.ms }, now);
        if (ev.t === 'lootSpill' && ev.playerId === me && ev.count > 0) this.maybeSpillTip(now);
      }
    }
    this.obj.handleEvents(events, now, this.banners);
    this.rift.handleEvents(events, now, this.banners);
  }

  /** The first time your caches spill on this device, explain what happened (and how to keep them). */
  private maybeSpillTip(now: number): void {
    if (loadStr(KEY_TIP_SPILL)) return;
    saveStr(KEY_TIP_SPILL, '1');
    replaceChildren(this.tip, h('div', { class: 'lt-tip-head' }, 'TIP · UNSECURED LOOT'), h('div', null, spillTipText(this.client.gameType)));
    this.tip.classList.remove('hidden');
    this.tipAt = now;
    this.tipUntil = now + TIP_MS;
  }

  /** Show whatever the shared banner queue has on screen now (re-renders only when it changes). */
  private renderBanner(now: number): void {
    const b = this.banners.current(now);
    const seq = this.banners.currentSeq;
    if (seq === this.bannerSeq) return;
    this.bannerSeq = seq;
    if (!b) { this.banner.classList.add('hidden'); return; }
    this.banner.textContent = b.text;
    this.banner.className = `hud-banner ${b.kind}`;
    if (b.kind === 'loot') this.banner.style.setProperty('--rarity', rarityCss((b.rarity ?? 0) as 0 | 1 | 2 | 3 | 4));
    if (b.color) this.banner.style.setProperty('--obj', b.color);
    void this.banner.offsetWidth;
    this.banner.classList.add('pop');
  }

  /** `secondaryHeld` = local RMB / RB state (turret defense has no other visible "on" signal). */
  update(f: RenderFrame, now: number, fps: number, showFps: boolean, secondaryHeld = false): void {
    const c = this.client;
    const you = f.you;
    const m = f.match;
    this.reportInsets(now);

    while (this.feedEntries.length && now - this.feedEntries[0].at > FEED_MS) this.feedEntries.shift()!.el.remove();
    this.renderBanner(now);
    if (this.tipUntil && now > this.tipUntil) { this.tip.classList.add('hidden'); this.tipUntil = 0; }
    if (this.holdToastUntil && now > this.holdToastUntil) { this.holdToast.classList.add('hidden'); this.holdToastUntil = 0; }

    // HUD layout rule: ONE top-centre strip — the rift strip (M4), the objective strip (M3) or the classic clock + wave.
    const rift = hudShowsRift(m);
    const objective = !rift && hudShowsObjective(m);
    if (rift) {
      toggleClass(this.timer, 'hidden', true);
      toggleClass(this.wave, 'hidden', true);
      this.obj.hide();
      this.rift.update(f, now, this.banners);
    } else if (objective) {
      this.rift.hide();
      toggleClass(this.timer, 'hidden', true);
      toggleClass(this.wave, 'hidden', true);
      this.obj.update(f, now, this.banners);
    } else {
      this.rift.hide();
      this.obj.hide();
      toggleClass(this.wave, 'hidden', false);
    }
    if (m && !objective && !rift) {
      // v0.3: untimed matches (dungeons) have no clock; a rift's wave is its enemy tier, never shown.
      const timed = hudShowsClock(m);
      toggleClass(this.timer, 'hidden', !timed);
      if (timed) {
        setText(this.timer, fmtClock(m.timeLeftSec));
        toggleClass(this.timer, 'low', m.timeLeftSec <= 30);
      }
      setText(this.wave, hudWaveText(m));
    }
    // The objective strip carries the team points / FFA top 3 itself; a rift shows its party roster instead.
    toggleClass(this.scoresStrip, 'hidden', objective || rift);
    toggleClass(this.top, 'has-obj', objective);
    toggleClass(this.top, 'has-rift', rift);
    if (!objective && !rift) this.updateScores(f, now);

    const ns = c.netStats();
    setText(this.stats, `${showFps ? `${Math.round(fps)} fps · ` : ''}${c.offline ? 'offline' : `${c.pingMs} ms`}${showFps && !c.offline ? ` · buf ${ns.delayMs}ms` : ''}`);

    const spectating = !you;
    toggleClass(this.spectate, 'hidden', !spectating);
    if (spectating) {
      const target = f.ships.find((s) => s.id === c.spectateId);
      // Rift: a pending drop-in ("joining at the next floor") or an extracted pilot has its own line.
      const rs = rift ? this.rift.spectateLine(target ? this.name(target.playerId) : '') : null;
      if (rs) twoLine(this.spectate, rs.big, rs.small);
      else twoLine(this.spectate, `SPECTATING${target ? ` — ${this.name(target.playerId)}` : ''}`, 'Click / A to cycle · Esc for menu');
    }
    toggleClass(this.panel, 'hidden', spectating);
    if (!you) {
      toggleClass(this.respawn, 'hidden', true);
      toggleClass(this.turret, 'hidden', true);
      toggleClass(this.tray, 'hidden', true);
      this.wasFull = false;
      this.cards.render(null, 0);
      return;
    }

    const own = f.ships.find((s) => s.id === you.shipId);
    const cls = SHIP_CLASSES[own?.shipClass ?? c.me?.shipClass ?? 'brute'] ?? SHIP_CLASSES.brute;
    const host = you.attachedTo ? f.ships.find((s) => s.id === you.attachedTo) : undefined;

    // Own energy.
    const frac = you.stats.maxEnergy > 0 ? Math.max(0, you.energy) / you.stats.maxEnergy : 0;
    setStyle(this.energyFill, 'width', `${(Math.min(1, frac) * 100).toFixed(1)}%`);
    setText(this.energyNum, `${Math.max(0, Math.round(you.energy))}`);
    toggleClass(this.energyWrap, 'low', you.alive && frac < 0.25);
    toggleClass(this.energyWrap, 'crit', you.alive && frac < 0.12);
    toggleClass(this.energyWrap, 'skill-active', you.skillActive);

    // XP / level / bounty / path.
    setStyle(this.xpFill, 'width', `${you.xpToNext > 0 ? Math.min(100, (you.xp / you.xpToNext) * 100).toFixed(1) : 0}%`);
    setText(this.levelEl, `LV ${you.level}`);
    setText(this.bountyEl, `BOUNTY ${you.bounty}`);
    this.updatePath(you);

    // Skill bar (class skills, or turret kit while attached).
    if (host) this.updateTurretMode(you, cls.id, host, f.ships, now, secondaryHeld);
    else { this.updateSkillMode(you, cls.id, own); this.turretReload.reset(); }
    toggleClass(this.attachPip, 'hidden', c.mode === 'ffa' || !cls.canTurret);
    // CTF: a flag carrier can't attach as a turret (§5.3).
    toggleClass(this.attachPip, 'blocked', this.obj.carryingFlag);
    const acd = Math.max(0, Math.min(1, you.cd.attach));
    setStyle(this.attachPip, '--p', acd.toFixed(3));
    toggleClass(this.attachPip, 'ready', acd <= 0);

    this.updateDeployables(you, cls.id);

    // Respawn (a rift's out-of-lives / extracted overlay replaces it; the rift line counts the shared lives).
    const riftOverlay = rift && this.rift.overlayShown;
    toggleClass(this.respawn, 'hidden', you.alive || riftOverlay);
    if (!you.alive && !riftOverlay) {
      const lives = rift ? m?.dungeon?.lives?.[partyOf(you, c.me?.team)] : undefined;
      twoLine(this.respawn, 'DESTROYED', typeof lives === 'number'
        ? riftRespawnLine(you.respawnIn, lives)
        : `Respawning in ${Math.max(0, you.respawnIn).toFixed(1)}s`);
    }

    // Turret status line (both sides of the stack).
    let turretText = '';
    if (host) {
      turretText = `TURRET on ${this.name(host.playerId)} — ${cls.turret.name}`;
    } else if (you.turrets.length) {
      const draw = hostLaserDraw(f.ships, you.shipId);
      turretText = `Turrets: ${you.turrets.length}${draw > 0 ? ` — drawing ~${Math.round(draw)}/s` : ''}`;
    }
    toggleClass(this.turret, 'hidden', !turretText);
    setText(this.turret, turretText);

    this.updateTray(f, you, now);
    if (this.tipUntil && you.alive && now - this.tipAt > TIP_MIN_MS) { this.tip.classList.add('hidden'); this.tipUntil = 0; }

    this.cards.render(you.offer, you.queuedOffers);
    this.cards.setPicked(c.pickedUpgrade);
    this.renderUpgrades(you.upgrades);
  }

  /** Unsecured caches: rarity pips, n/cap, the per-mode hint, and the HOLD FULL toast. */
  private updateTray(f: RenderFrame, you: YouState, now: number): void {
    const tm = trayModel(you, this.client.gameType);
    toggleClass(this.tray, 'hidden', !tm);
    if (!tm) { this.wasFull = false; return; }
    const key = `${tm.pips.join('')}|${tm.cap}|${tm.hint}`;
    if (key !== this.trayKey) {
      this.trayKey = key;
      replaceChildren(this.trayPips, tm.pips.map((r) => h('span', { class: `lt-pip r-${r}`, style: `--rarity:${rarityCss(r)}` })));
      setText(this.trayCount, tm.cap ? `${tm.n}/${tm.cap}` : String(tm.n));
      setText(this.trayHint, tm.hint);
      setStyle(this.tray, '--rarity', rarityCss(tm.best));
    }
    toggleClass(this.tray, 'full', tm.full);
    if (tm.full) {
      const own = f.ships.find((s) => s.id === you.shipId);
      const reach = (you.stats.radius || 16) + LOOT_PICKUP_PAD + 6;
      const near = !!own && you.alive && cacheInReach(f.loot, own.x, own.y, reach, this.client.playerId);
      if ((!this.wasFull || near) && now - this.holdToastAt > HOLD_TOAST_GAP_MS) {
        this.holdToastAt = now;
        this.holdToastUntil = now + HOLD_TOAST_MS;
        setText(this.holdToast, `HOLD FULL · ${tm.n}/${tm.cap}`);
        this.holdToast.classList.remove('hidden', 'pop');
        void this.holdToast.offsetWidth;
        this.holdToast.classList.add('pop');
      }
    }
    this.wasFull = tm.full;
  }

  private updateSkillMode(you: YouState, clsId: keyof typeof SHIP_CLASSES, own: ShipView | undefined): void {
    const def = SHIP_CLASSES[clsId];
    this.skills.setSlots(`skills:${clsId}`, SLOT_ORDER.map((slot) => ({
      icon: def.skills[slot].icon, name: def.skills[slot].name, keys: SLOT_KEYS[slot],
    })));
    const flags = own?.flags ?? 0;
    SLOT_ORDER.forEach((slot, i) => {
      const sec = slot === 'primary' ? null : you.cdSec[slot];
      const active = (slot === 'mobility' && (flags & SHIPFLAG_CHARGING) !== 0)
        || (slot === 'utility' && clsId === 'brute' && (flags & SHIPFLAG_SHIELD) !== 0);
      this.skills.update(i, { cd: you.cd[slot], cdSec: sec, dim: you.alive && you.energy < slotCost(you.stats, slot), active });
    });
    toggleClass(this.hostWrap, 'hidden', true);
    toggleClass(this.resonanceEl, 'hidden', true);
  }

  private updateTurretMode(
    you: YouState, clsId: keyof typeof SHIP_CLASSES, host: ShipView, ships: ShipView[], now: number, secondaryHeld: boolean,
  ): void {
    const kit = SHIP_CLASSES[clsId].turret;
    this.skills.setSlots(`turret:${kit.id}`, [
      { icon: kit.offense.icon, name: kit.offense.name, keys: SLOT_KEYS.primary, note: 'host energy' },
      { icon: kit.defense.icon, name: kit.defense.name, keys: SLOT_KEYS.secondary, hold: true, note: 'your energy' },
    ]);
    const hostState = hostEnergyState(host.energyFrac);
    const res = laserResonance(ships, host.id);
    const mine = ships.find((s) => s.id === you.shipId);
    const beam = mine && mine.beamLen > 0 ? mine.beamKind : 0;
    // Offense reload is the kit's (flakCd / podCd), not the class gun's; the laser is continuous.
    const kitCd = turretOffenseCooldown(kit.id, you.stats.skill ?? {});
    const offCd = this.turretReload.frac(you.cd.primary, you.stats.gunCooldown, kitCd, now);
    this.skills.update(0, { cd: offCd, cdSec: null, dim: hostState === 'offline', active: beam === BEAM_LASER });
    // Turret defenses are held and have no cooldown (the class secondary's readyTick doesn't apply).
    const defending = beam === BEAM_WELD || (secondaryHeld && you.energy > 0);
    this.skills.update(1, { cd: 0, cdSec: null, dim: you.energy <= 0, active: defending });

    // Host energy bar — it fuels our offense.
    toggleClass(this.hostWrap, 'hidden', false);
    setStyle(this.hostFill, 'width', `${(Math.max(0, Math.min(1, host.energyFrac)) * 100).toFixed(1)}%`);
    toggleClass(this.hostWrap, 'warn', hostState === 'warn');
    toggleClass(this.hostWrap, 'offline', hostState === 'offline');
    const pct = Math.round(host.energyFrac * 100);
    setText(this.hostLabel, hostState === 'offline'
      ? `HOST ${pct}% — OFFENSE OFFLINE (below ${Math.round(TURRET_HOST_FLOOR_FRAC * 100)}%)`
      : `HOST ${this.name(host.playerId)} · ${pct}%${hostState === 'warn' ? ' — LOW' : ''}`);

    // Laser resonance (only meaningful when lasers ride this host).
    const showRes = res.lasers > 0 || clsId === 'tech';
    toggleClass(this.resonanceEl, 'hidden', !showRes);
    if (showRes) {
      setText(this.resonanceEl, res.lasers > 1
        ? `RESONANCE ×${res.factor.toFixed(2)} · ${res.lasers} lasers`
        : `RESONANCE ×1 · ${res.lasers === 1 ? '1 laser' : 'idle'} (×${LASER_RESONANCE} per extra)`);
      toggleClass(this.resonanceEl, 'hot', res.lasers > 1);
    }
  }

  private updatePath(you: YouState): void {
    const key = `${you.path ?? ''}|${you.level >= PATH_LEVEL}`;
    if (key !== this.pathKey) {
      this.pathKey = key;
      const p = you.path ? PATHS[you.path] : undefined;
      if (p) {
        this.pathBadge.setAttribute('style', `--accent:${accentCss(p)}`);
        replaceChildren(this.pathBadge, h('span', { class: 'pb-icon' }, p.icon), h('span', { class: 'pb-name' }, p.name));
        this.pathBadge.title = `${p.name}: ${p.description}`;
        this.pathBadge.classList.remove('none');
      } else {
        this.pathBadge.removeAttribute('style');
        replaceChildren(this.pathBadge, h('span', { class: 'pb-name' }, you.level >= PATH_LEVEL ? 'PICK PATH' : `PATH @ LV ${PATH_LEVEL}`));
        this.pathBadge.title = '';
        this.pathBadge.classList.add('none');
      }
    }
    const tkey = you.talents.join(',');
    if (tkey !== this.talentsKey) {
      this.talentsKey = tkey;
      replaceChildren(this.talentsEl, you.talents.map((id) => {
        const t = TALENTS[id];
        const p = t ? PATHS[t.path] : undefined;
        return h('span', { class: 'talent-chip', style: p ? `--accent:${accentCss(p)}` : null, title: t ? `${t.name}: ${t.description}` : id },
          h('span', null, t?.icon ?? '✦'), ' ', t?.name ?? id);
      }));
      toggleClass(this.talentsEl, 'hidden', you.talents.length === 0);
    }
  }

  private updateDeployables(you: YouState, clsId: string): void {
    const parts: string[] = [];
    const chips: HTMLElement[] = [];
    for (const kind of DEPLOY_ORDER) {
      const n = you.deployables[kind] ?? 0;
      let max = 0;
      if (kind === 'sentry') max = you.stats.skill.sentryMax ?? 0;
      if (kind === 'drone') max = you.stats.skill.droneCount ?? 0;
      const always = kind === 'sentry' && clsId === 'engineer';
      if (n <= 0 && !always) continue;
      const [icon, label] = DEPLOY_ICONS[kind];
      const text = max > 0 ? `${n}/${max}` : String(n);
      parts.push(`${kind}${text}`);
      chips.push(h('span', { class: `deploy-chip${max > 0 && n >= max ? ' full' : ''}`, title: label }, icon, ' ', text));
    }
    const key = parts.join(',');
    if (key === this.deployKey) return;
    this.deployKey = key;
    replaceChildren(this.deployEl, chips);
  }

  private updateScores(f: RenderFrame, now: number): void {
    if (now - this.lastScoresAt < 250) return;
    this.lastScoresAt = now;
    const c = this.client;
    const m = f.match;
    let key = '';
    let nodes: HTMLElement[] = [];
    if (m && m.mode === 'teams') {
      const myTeam = c.me?.team ?? -9;
      key = m.teamScores.join(',') + '|' + myTeam;
      nodes = m.teamScores.map((sc, t) => h('div', { class: `ts${t === myTeam ? ' mine' : ''}`, style: `--team:${teamColorCss(t)}` },
        h('span', { class: 'ts-name' }, teamName(t)), h('span', { class: 'ts-val' }, String(Math.round(sc)))));
    } else {
      const top = [...c.scores.values()].sort((a, b) => b.score - a.score).slice(0, 3);
      key = top.map((s) => `${s.playerId}:${s.score}`).join(',');
      nodes = top.map((s, i) => h('div', { class: `ts${s.playerId === c.playerId ? ' mine' : ''}`, style: `--team:${this.color(s.playerId)}` },
        h('span', { class: 'ts-name' }, `${i + 1}. ${this.name(s.playerId)}`), h('span', { class: 'ts-val' }, String(Math.round(s.score)))));
    }
    if (key === this.scoresKey) return;
    this.scoresKey = key;
    replaceChildren(this.scoresStrip, nodes);
  }

  private renderUpgrades(list: { id: string; name: string; icon: string; level: number; maxLevel: number }[]): void {
    // Paths and talents have their own badge/row; the tray shows general upgrades only.
    const general = list.filter((u) => !u.id.startsWith('path:') && !TALENTS[u.id]);
    const key = general.map((u) => `${u.id}${u.level}`).join(',');
    if (key === this.upgradesKey) return;
    this.upgradesKey = key;
    replaceChildren(this.upgrades, general.map((u) => h('div', { class: 'upg', title: `${u.name} ${u.level}/${u.maxLevel}` },
      h('span', { class: 'upg-icon' }, u.icon || '✦'), h('span', { class: 'upg-lv' }, String(u.level)))));
  }
}

function twoLine(el: HTMLElement, big: string, small: string): void {
  const key = big + '\n' + small;
  if (el.dataset.k === key) return;
  el.dataset.k = key;
  replaceChildren(el, h('div', { class: 'big' }, big), h('div', { class: 'small' }, small));
}
