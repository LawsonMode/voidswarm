// Command (v0.3; replaces the v0.2 ZoneLobby): three game-type cards (Quick Play / Create, featured
// draws), the live games list (sub-mode chips, sort, status, Join / Watch), zone chat, banners.
// docs/v0.3-proposal.md §2.3. All list logic is in gameTypeInfo.ts (pure, tested).
// v0.3 M2: the Hangar button shows shards + NEW count; each card's draws strip adds "Collected x/13 ·
// Epic within n crates" once a profile is loaded (lootInfo.ts).
import { GAME_TYPE_IDS, GAME_TYPES, SUB_MODES, subModeLabel } from '../../shared/data/gameTypes';
import type { RoomSummary } from '../../shared/protocol';
import type { GameType, SubMode } from '../../shared/types';
import type { GameClient } from '../net/GameClient';
import { loadStr, saveStr } from '../storage';
import { ChatView } from './ChatView';
import { h, replaceChildren, setText, toggleClass } from './dom';
import {
  DRAWS_LINE, featuredDraws, filterRooms, LIST_ROWS, liveLine, modeLabel, onlineText, parseStoredType, pilotsParts,
  rarityCss, rowActions, setName, sortRooms, statusText, typeAccentCss, typeOpen,
} from './gameTypeInfo';
import { drawsProgressLine, freshIds, hangarButtonText } from './lootInfo';

export interface CommandCallbacks {
  onCreate(t: GameType): void;
  onHangar(): void;
  onSettings(): void;
  /** Log out (account) / Disconnect (guest) / Quit to Title (offline). */
  onExit(): void;
  /** Guest banner: go register an account. */
  onCreateAccount(): void;
  onUi(name: string): void;
}

export const KEY_COMMAND_TYPE = 'voidswarm.command.type';

interface CardRefs { root: HTMLElement; live: HTMLElement; qp: HTMLButtonElement; create: HTMLButtonElement; progress: HTMLElement }
interface RowRefs { el: HTMLElement; sig: string; status: HTMLElement; room: RoomSummary }

export class CommandScreen {
  readonly root: HTMLElement;
  readonly chat: ChatView;
  private selected: GameType;
  private subFilter: SubMode | null = null;
  private showAll = false;
  private chatOpen = false;
  private unread = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  private pilotChip = h('div', { class: 'account-chip pilot-chip' });
  private onlineEl = h('div', { class: 'online-count' });
  private motdEl = h('div', { class: 'zone-motd' });
  private hangarBtn: HTMLButtonElement;
  private exitBtn: HTMLButtonElement;
  private banner = h('div', { class: 'cmd-banner hidden', role: 'note' });
  private cards = new Map<GameType, CardRefs>();
  private listTitle = h('h2', null);
  private chips = h('div', { class: 'submode-chips', role: 'toolbar', 'aria-label': 'Filter by mode' });
  private list = h('div', { class: 'lg-body', role: 'rowgroup' });
  private empty = h('div', { class: 'muted empty hidden' });
  private moreBtn: HTMLButtonElement;
  private rows = new Map<string, RowRefs>();
  private chipsKey = '';
  private chatTitle = h('h2', null, 'Zone Chat');
  private chatToggle: HTMLButtonElement;

  constructor(private client: GameClient, private cb: CommandCallbacks) {
    this.selected = parseStoredType(loadStr(KEY_COMMAND_TYPE));
    this.chat = new ChatView({
      placeholder: 'Say hello… (/help · /rooms · /play arena)', channelToggle: false, fading: false,
      onSend: (ch, text) => { client.sendChat(ch, text); cb.onUi('chat'); },
      onNameClick: (n) => { this.chat.input.value += `@${n} `; this.chat.input.focus(); },
    });
    this.hangarBtn = h('button', { class: 'btn btn-ghost hangar-btn', 'data-nav': 'cmd-hangar', onclick: () => cb.onHangar() }, 'Hangar');
    this.exitBtn = h('button', { class: 'btn btn-ghost', 'data-nav': 'cmd-exit', onclick: () => cb.onExit() }, 'Disconnect');
    this.moreBtn = h('button', {
      class: 'btn btn-small btn-ghost lg-more hidden', 'data-nav': 'lg-more',
      onclick: () => { this.showAll = !this.showAll; this.renderList(); cb.onUi('click'); },
    }, 'Show all');
    this.chatToggle = h('button', {
      class: 'btn chat-toggle', 'data-nav': 'cmd-chat-toggle', 'aria-expanded': 'false',
      onclick: () => this.setChatOpen(!this.chatOpen),
    }, 'Chat');

    this.root = h('section', { class: 'screen screen-command' },
      h('header', { class: 'topbar cmd-top' },
        h('div', { class: 'brand' }, 'VOIDSWARM', h('span', { class: 'brand-sub' }, 'COMMAND')),
        this.pilotChip,
        this.onlineEl,
        this.motdEl,
        h('div', { class: 'topbar-actions' },
          this.hangarBtn,
          h('button', { class: 'btn btn-ghost', 'data-nav': 'cmd-settings', onclick: () => cb.onSettings() }, 'Settings'),
          this.exitBtn)),
      this.banner,
      h('div', { class: 'cmd-grid' },
        h('div', { class: 'cmd-main' },
          h('div', { class: 'gt-cards' }, GAME_TYPE_IDS.map((t) => this.card(t))),
          h('div', { class: 'panel live-games' },
            h('div', { class: 'panel-head' }, this.listTitle,
              h('button', { class: 'btn btn-small', 'data-nav': 'lg-refresh', onclick: () => { client.send({ type: 'listRooms' }); cb.onUi('click'); } }, 'Refresh')),
            this.chips,
            h('div', { class: 'lg-table', role: 'table' },
              h('div', { class: 'lg-row lg-head', role: 'row' },
                h('div', { class: 'lg-name' }, 'Name'), h('div', { class: 'lg-mode' }, 'Mode'), h('div', { class: 'lg-pilots' }, 'Pilots'),
                h('div', { class: 'lg-status' }, 'Status'), h('div', { class: 'lg-actions' }, '')),
              this.list),
            this.empty,
            this.moreBtn)),
        h('div', { class: 'panel cmd-chat' },
          h('div', { class: 'panel-head' }, this.chatTitle,
            h('button', { class: 'btn btn-small btn-ghost chat-close', 'data-nav': 'cmd-chat-close', onclick: () => this.setChatOpen(false) }, 'Close')),
          this.chat.root)),
      this.chatToggle);

    client.on('chat', (l) => {
      if (client.roomId !== null) return;
      this.chat.add(l);
      // Count unread lines only while the phone drawer is actually collapsed (the desktop panel is always shown).
      if (!this.chatOpen && phoneLayout()) { this.unread++; this.updateChatToggle(); }
    });
    client.on('chatReset', () => { if (client.roomId === null) this.chat.setLines(client.chat); });
  }

  // ------------------------------------------------------------------ lifecycle

  onShow(): void {
    this.chat.setLines(this.client.chat);
    this.showAll = false;
    this.refresh();
    this.client.send({ type: 'listRooms' });
    if (!this.timer) this.timer = setInterval(() => this.tick(), 1000);
  }

  onHide(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.setChatOpen(false);
  }

  /** Focus the chat input (opens the phone drawer first). */
  focusChat(): void {
    this.setChatOpen(true);
    this.chat.input.focus();
  }

  get selectedType(): GameType { return this.selected; }

  /** v0.5 mobile: the controller card (ui/mobile.ts) sits under the top banner. */
  mountNotice(el: HTMLElement): void {
    this.banner.after(el);
  }

  /** v0.5 mobile: where focus goes when the card's X (keyboard / gamepad) hides it: the selected game-type card. */
  focusDefault(): void {
    const el = this.root.querySelector<HTMLElement>(`[data-nav="gt-${this.selected}"]`) ?? this.root.querySelector<HTMLElement>('.gt-card-body');
    el?.focus({ preventScroll: true });
  }

  refresh(): void {
    const c = this.client;
    replaceChildren(this.pilotChip,
      c.offline
        ? [h('span', { class: 'strong' }, c.name), h('span', { class: 'badge' }, 'offline')]
        : c.account
          ? [h('span', { class: 'muted' }, 'Pilot '), h('span', { class: 'strong accent-c' }, c.account.username)]
          : [h('span', { class: 'strong' }, c.name), h('span', { class: 'badge' }, 'guest')]);
    setText(this.onlineEl, c.offline ? '' : onlineText(c.online));
    toggleClass(this.onlineEl, 'hidden', c.offline);
    setText(this.motdEl, c.motd || '');
    setText(this.exitBtn, c.offline ? 'Quit to Title' : c.account ? 'Log out' : 'Disconnect');
    setText(this.hangarBtn, hangarButtonText(c.profile));
    toggleClass(this.hangarBtn, 'has-new', freshIds(c.profile).length > 0);
    setText(this.chatTitle, c.offline ? 'Comms (offline)' : 'Zone Chat');
    this.renderBanner();
    for (const t of GAME_TYPE_IDS) this.updateCard(t);
    this.renderChips();
    this.renderList();
  }

  // ------------------------------------------------------------------ top / banners

  /** Why the device profile won't keep this session's loot (newer-version read-only, or storage blocked). */
  private deviceWarning(): HTMLElement | null {
    const c = this.client;
    if (c.deviceReadOnly) return h('span', { class: 'hg-volatile' }, 'This device’s profile is from a newer version: read-only, loot won’t be saved.');
    if (c.deviceVolatile) return h('span', { class: 'hg-volatile' }, 'Browser storage is blocked: loot won’t survive a reload.');
    return null;
  }

  private renderBanner(): void {
    const c = this.client;
    if (c.offline) {
      replaceChildren(this.banner, h('span', null, 'Offline: you vs bots. Items stay on this device.'), this.deviceWarning());
      this.banner.className = 'cmd-banner offline';
    } else if (!c.account) {
      replaceChildren(this.banner,
        h('span', null, 'Playing as guest: items you find stay on this device and only you see them.'),
        this.deviceWarning(),
        h('button', { class: 'btn btn-small btn-accent', 'data-nav': 'cmd-register', onclick: () => this.cb.onCreateAccount() }, 'Create account'));
      this.banner.className = 'cmd-banner guest';
    } else if (c.profileSource === 'server' && !c.profilePersisted) {
      // §7.2: the account profile store is down; this session's loot lives in memory only.
      replaceChildren(this.banner, h('span', null, 'Loot won’t be saved this session.'));
      this.banner.className = 'cmd-banner warn';
    } else {
      this.banner.className = 'cmd-banner hidden';
    }
  }

  // ------------------------------------------------------------------ type cards

  private card(t: GameType): HTMLElement {
    const T = GAME_TYPES[t];
    const open = typeOpen(t);
    const live = h('div', { class: 'gt-live' });
    const qp = h('button', {
      class: 'btn btn-primary gt-qp', 'data-nav': `qp-${t}`, disabled: !open,
      onclick: () => { this.select(t); this.client.quickPlay(t); this.cb.onUi('start'); },
    }, 'Quick Play');
    const create = h('button', {
      class: 'btn gt-create', 'data-nav': `create-${t}`, disabled: !open,
      onclick: () => { this.select(t); this.cb.onCreate(t); },
    }, 'Create');
    const draws = featuredDraws(t);
    const progress = h('div', { class: 'gt-draws-progress small hidden' });
    const body = h('button', {
      class: 'gt-card-body', type: 'button', 'data-nav': `gt-${t}`, 'aria-label': `Show ${T.name} games`,
      onclick: () => { this.select(t); this.cb.onUi('select'); },
    },
    h('div', { class: 'gt-head' },
      h('span', { class: 'gt-icon', 'aria-hidden': 'true' }, T.icon),
      h('span', { class: 'gt-name' }, T.name),
      h('span', { class: `badge kind kind-${T.kind.toLowerCase()}` }, T.kind)),
    h('div', { class: 'gt-tagline' }, T.tagline),
    h('ul', { class: 'gt-bullets' }, T.bullets.map((b) => h('li', null, b))),
    h('div', { class: 'gt-players muted' }, T.playersLine),
    h('div', { class: 'gt-draws' },
      h('div', { class: 'gt-draws-head' }, h('span', { class: 'path-label' }, 'Draws'), h('span', { class: 'muted small' }, setName(t))),
      h('div', { class: 'draw-chips' }, draws.map((d) => h('span', {
        class: `draw-chip r-${d.rarity}`, title: `${d.rarityName} · ${d.name}`, style: `--rarity:${rarityCss(d.rarity)}`,
      }, d.name))),
      h('div', { class: 'gt-draws-line muted small' }, DRAWS_LINE),
      progress),
    live);
    const root = h('article', { class: `gt-card${open ? '' : ' soon'}`, style: `--accent:${typeAccentCss(t)}` },
      body,
      h('div', { class: 'gt-actions' },
        open ? null : h('span', { class: 'gt-soon' }, 'Coming soon'),
        qp, create));
    this.cards.set(t, { root, live, qp, create, progress });
    return root;
  }

  private updateCard(t: GameType): void {
    const refs = this.cards.get(t);
    if (!refs) return;
    toggleClass(refs.root, 'selected', t === this.selected);
    refs.root.setAttribute('aria-current', t === this.selected ? 'true' : 'false');
    setText(refs.live, typeOpen(t) ? liveLine(this.client.rooms, t) : 'Opens in a later update');
    // Online guests: the server can't honour device pity (it rolls their crates against an empty profile).
    const line = drawsProgressLine(this.client.profile, t, !this.client.deviceProfileMode);
    setText(refs.progress, line);
    toggleClass(refs.progress, 'hidden', !line);
  }

  private select(t: GameType): void {
    if (t !== this.selected) {
      this.selected = t;
      this.subFilter = null;
      this.showAll = false;
      saveStr(KEY_COMMAND_TYPE, t);
    }
    for (const id of GAME_TYPE_IDS) this.updateCard(id);
    this.renderChips();
    this.renderList();
  }

  // ------------------------------------------------------------------ live list

  private renderChips(): void {
    const t = this.selected;
    const T = GAME_TYPES[t];
    const key = `${t}|${this.subFilter ?? ''}`;
    setText(this.listTitle, `Live Games · ${T.name}`);
    if (key === this.chipsKey) return;
    this.chipsKey = key;
    const chip = (sub: SubMode | null) => {
      const ready = sub === null || SUB_MODES[sub].ready;
      const on = this.subFilter === sub;
      return h('button', {
        class: `chip${on ? ' on' : ''}${ready ? '' : ' soon'}`, 'data-nav': `sub-${sub ?? 'all'}`, disabled: !ready,
        'aria-pressed': on ? 'true' : 'false',
        onclick: () => { this.subFilter = sub; this.showAll = false; this.renderChips(); this.renderList(); this.cb.onUi('click'); },
      }, sub === null ? 'All' : subModeLabel(t, sub), ready ? null : h('span', { class: 'chip-soon' }, 'Soon'));
    };
    replaceChildren(this.chips, chip(null), T.subModes.map((s) => chip(s)));
  }

  private renderList(): void {
    const c = this.client;
    const all = sortRooms(filterRooms(c.rooms, this.selected, this.subFilter));
    const shown = this.showAll ? all : all.slice(0, LIST_ROWS);
    const keep = new Set<string>();
    const now = performance.now();
    const focusedNav = (document.activeElement as HTMLElement | null)?.getAttribute?.('data-nav') ?? null;
    let refocus = false;
    shown.forEach((r, i) => {
      keep.add(r.id);
      const sig = rowSig(r, c.offline);
      let refs = this.rows.get(r.id);
      if (!refs || refs.sig !== sig) {
        if (refs && refs.el.contains(document.activeElement)) refocus = true;
        refs?.el.remove();
        refs = this.buildRow(r, sig);
        this.rows.set(r.id, refs);
      }
      refs.room = r;
      setText(refs.status, statusText(r, c.roomsAt, now));
      const at = this.list.children[i];
      if (at !== refs.el) this.list.insertBefore(refs.el, at ?? null);
    });
    for (const [id, refs] of this.rows) {
      if (keep.has(id)) continue;
      if (refs.el.contains(document.activeElement)) refocus = true;
      refs.el.remove();
      this.rows.delete(id);
    }
    if (refocus && focusedNav) {
      this.root.querySelector<HTMLElement>(`[data-nav="${CSS.escape(focusedNav)}"]`)?.focus({ preventScroll: true });
    }
    const open = typeOpen(this.selected);
    toggleClass(this.empty, 'hidden', shown.length > 0);
    setText(this.empty, !open
      ? `${GAME_TYPES[this.selected].name} opens in a later update.`
      : this.subFilter
        ? 'No games of this mode right now. Quick Play starts one.'
        : 'No games yet. Quick Play starts one.');
    toggleClass(this.moreBtn, 'hidden', all.length <= LIST_ROWS);
    setText(this.moreBtn, this.showAll ? 'Show fewer' : `Show all (${all.length})`);
  }

  private buildRow(r: RoomSummary, sig: string): RowRefs {
    const c = this.client;
    const p = pilotsParts(r);
    const status = h('div', { class: `lg-status phase-${r.phase}` });
    const actions = rowActions(r, c.offline).map((a) => a.kind === 'full'
      ? h('button', { class: 'btn btn-small', disabled: true }, a.label)
      : h('button', {
        class: `btn btn-small ${a.kind === 'join' ? 'btn-primary' : 'btn-ghost'}`, 'data-nav': `${a.kind}-${r.id}`,
        onclick: () => { c.joinRoom(r.id, a.intent); this.cb.onUi(a.kind === 'join' ? 'start' : 'click'); },
      }, a.label));
    const el = h('div', { class: `lg-row${r.humans > 0 ? ' has-humans' : ''}`, role: 'row' },
      h('div', { class: 'lg-name' },
        h('span', { class: 'strong lg-room' }, r.name),
        r.house ? h('span', { class: 'badge house' }, 'HOUSE') : r.hostName ? h('span', { class: 'muted small lg-host' }, r.hostName) : null),
      h('div', { class: 'lg-mode' }, modeLabel(r)),
      h('div', { class: 'lg-pilots' },
        h('span', { class: 'strong' }, p.humans), h('span', { class: 'muted' }, p.rest),
        p.watch ? h('span', { class: 'muted small lg-watch' }, p.watch) : null),
      status,
      h('div', { class: 'lg-actions' }, actions));
    return { el, sig, status, room: r };
  }

  /** 1 s re-render while Command is visible: status timers only (rows are rebuilt on list changes). */
  private tick(): void {
    const now = performance.now();
    for (const refs of this.rows.values()) setText(refs.status, statusText(refs.room, this.client.roomsAt, now));
  }

  // ------------------------------------------------------------------ phone chat drawer

  private setChatOpen(open: boolean): void {
    this.chatOpen = open;
    if (open) this.unread = 0;
    toggleClass(this.root, 'chat-open', open);
    this.chatToggle.setAttribute('aria-expanded', String(open));
    this.updateChatToggle();
  }

  private updateChatToggle(): void {
    setText(this.chatToggle, this.unread > 0 ? `Chat (${this.unread})` : 'Chat');
  }
}

/** The phone layout (< 720 px, styles.css) where zone chat is a drawer behind the Chat button. */
function phoneLayout(): boolean {
  try { return typeof matchMedia === 'function' && matchMedia('(max-width: 719px)').matches; } catch { return false; }
}

/** Everything that changes a row's look except the ticking status timer. */
function rowSig(r: RoomSummary, offline: boolean): string {
  return [
    r.name, r.house, r.hostName, r.gameType, r.subMode, r.mode, r.teamCount, r.floors, r.humans, r.bots, r.spectators,
    r.maxPlayers, r.joinable, r.watchable, r.phase, offline,
  ].join('|');
}
