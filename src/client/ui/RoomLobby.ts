// Room lobby: team (or party) select, class picker + build planner, room chat, type-aware host settings,
// ready/start, countdown. v0.3: typed title, "Back to Command", Loadout button, equipped titles.
import { NO_TEAM } from '../../shared/constants';
import { isSubMode, objectiveTarget } from '../../shared/data/gameTypes';
import { COSMETICS } from '../../shared/data/cosmetics';
import { SHIP_CLASS_IDS, SHIP_CLASSES } from '../../shared/data/ships';
import { hexToCss, TEAM_COLORS, teamName } from '../../shared/data/teams';
import { TEAM_UNASSIGNED, type ClientMsg, type PlayerInfo, type RoomSettings } from '../../shared/protocol';
import type { ShipClassId, TeamId } from '../../shared/types';
import type { GameClient } from '../net/GameClient';
import { ChatView } from './ChatView';
import { h, replaceChildren, teamCss } from './dom';
import { PATH_HINT, pathBlock, accentCss, SLOT_ORDER, slotGlyph, statBars } from './classInfo';
import { roomTitleText, typeAccentCss } from './gameTypeInfo';
import { GameSettingsForm } from './GameSettingsForm';
import { shipIcon } from './icons';
import { framedTitle } from './lootInfo';
import { objectiveRulesLine } from './objectiveInfo';
import { riftRulesLine } from './riftInfo';

export interface RoomCallbacks {
  /** Back to Command (leaves the room). */
  onLeave(): void;
  onSettings(): void;
  /** Class panel "Loadout" (opens the Hangar). */
  onLoadout(): void;
  onUi(name: string): void;
}

/** Equipped title text of a player ('' = none / starter), framed per its catalog entry. */
export function playerTitle(p: Pick<PlayerInfo, 'cosmetics'>): string {
  const id = p.cosmetics?.title;
  return framedTitle(id ? COSMETICS[id] : undefined);
}

export function teamColorCss(team: TeamId): string {
  return team >= 0 ? hexToCss(TEAM_COLORS[team % TEAM_COLORS.length]) : '#9aa4c7';
}

/** Pick the team with the fewest humans (ties: fewest total, then lowest index). */
export function autoTeam(players: readonly PlayerInfo[], teamCount: number, selfId: number): number {
  let best = 0, bestKey = Infinity;
  for (let t = 0; t < teamCount; t++) {
    const members = players.filter((p) => p.team === t && p.playerId !== selfId);
    const humans = members.filter((p) => !p.isBot).length;
    const key = humans * 1000 + members.length;
    if (key < bestKey) { bestKey = key; best = t; }
  }
  return best;
}

/**
 * Messages to drop into (or watch) the running match from the room lobby. The server adds a pilot on
 * their team (auto-balancing one without a team) and lets spectators watch — but team -2 means
 * "spectating" OR "not picked yet" and PlayerInfo can't tell which, so without a real team the choice
 * is sent first and the outcome doesn't depend on it.
 */
export function dropInMessages(
  how: 'join' | 'watch', me: PlayerInfo | undefined, settings: RoomSettings, players: readonly PlayerInfo[], selfId: number,
): ClientMsg[] {
  if (how === 'watch') return [{ type: 'setTeam', team: TEAM_UNASSIGNED }, { type: 'joinMatch' }];
  const picked = !!me && (settings.mode === 'ffa' ? me.team === NO_TEAM : me.team >= 0);
  if (picked) return [{ type: 'joinMatch' }];
  const team = settings.mode === 'ffa' ? NO_TEAM : autoTeam(players, settings.teamCount, selfId);
  return [{ type: 'setTeam', team }, { type: 'joinMatch' }];
}

/** The room lobby's drop-in button while a match runs. A rift takes you at its next floor start. */
export function dropInLabel(rift: boolean, picked: boolean): string {
  if (rift) return 'Join · next floor';
  return picked ? 'Join Match' : 'Join Match (auto team)';
}

export class RoomLobby {
  readonly root: HTMLElement;
  readonly chat: ChatView;
  private title: HTMLElement;
  private teams: HTMLElement;
  private classGrid: HTMLElement;
  private classDetail: HTMLElement;
  private actions: HTMLElement;
  private settingsForm: GameSettingsForm;
  private teamsHead: HTMLElement;
  private countdownEl: HTMLElement;
  /** v0.3 M3: the objective sub-mode's one-line rules + target ("First to 3 captures."). */
  private rulesEl = h('div', { class: 'room-rules muted small hidden' });
  private previewClass: ShipClassId | null = null;
  /** Which of the 3 build paths the planner is showing. */
  private pathTab = 0;
  private detailKey = '';
  private lastCountdown = -1;

  constructor(private client: GameClient, private cb: RoomCallbacks) {
    this.chat = new ChatView({
      placeholder: 'Room chat… (// for team, /help)', channelToggle: true, fading: false,
      onSend: (ch, text) => { client.sendChat(ch, text); cb.onUi('chat'); },
    });
    this.title = h('div', { class: 'room-title' });
    this.teams = h('div', { class: 'teams' });
    this.classGrid = h('div', { class: 'class-grid' });
    this.classDetail = h('div', { class: 'class-detail' });
    this.actions = h('div', { class: 'room-actions' });
    this.countdownEl = h('div', { class: 'countdown hidden' });

    // Host settings: the same type-aware rows as Create Game; the server normalizes and echoes roomState.
    const send = (s: Partial<RoomSettings>) => { client.send({ type: 'updateSettings', settings: s }); cb.onUi('click'); };
    this.settingsForm = new GameSettingsForm({ nav: 'set', includeType: true, onChange: send });
    this.teamsHead = h('h2', null, 'Teams');

    this.root = h('section', { class: 'screen screen-room' },
      h('header', { class: 'topbar' },
        h('div', { class: 'brand' }, 'VOIDSWARM', h('span', { class: 'brand-sub' }, 'ROOM')),
        this.title,
        h('div', { class: 'topbar-actions' },
          h('button', { class: 'btn btn-ghost', 'data-nav': 'r-settings', onclick: () => cb.onSettings() }, 'Settings'),
          h('button', { class: 'btn btn-danger', 'data-nav': 'r-leave', onclick: () => cb.onLeave() }, 'Back to Command'))),
      h('div', { class: 'room-grid' },
        h('div', { class: 'room-main' },
          h('div', { class: 'panel teams-panel' },
            h('div', { class: 'panel-head' }, this.teamsHead,
              h('div', { class: 'row-gap' },
                h('button', { class: 'btn btn-small', 'data-nav': 'team-auto', onclick: () => this.autoJoin() }, 'Auto'),
                h('button', { class: 'btn btn-small btn-ghost', 'data-nav': 'team-spec', onclick: () => this.setTeam(TEAM_UNASSIGNED) }, 'Spectate'))),
            this.teams),
          h('div', { class: 'panel room-chat' }, h('h2', null, 'Room Chat'), this.chat.root)),
        h('div', { class: 'room-classes panel' },
          h('div', { class: 'panel-head' }, h('h2', null, 'Class'),
            h('button', { class: 'btn btn-small btn-ghost', 'data-nav': 'r-loadout', onclick: () => cb.onLoadout() }, 'Loadout')),
          this.classGrid, this.classDetail),
        h('div', { class: 'room-side' },
          h('div', { class: 'panel actions-panel' }, this.actions),
          h('div', { class: 'panel' }, h('h2', null, 'Game Settings'), this.rulesEl, this.settingsForm.root))),
      this.countdownEl);

    client.on('chat', (l) => { if (client.roomId !== null) this.chat.add(l); });
    client.on('chatReset', () => { if (client.roomId !== null) this.chat.setLines(client.chat); });
  }

  private setTeam(team: TeamId): void {
    this.client.send({ type: 'setTeam', team });
    this.cb.onUi('select');
  }

  private autoJoin(): void {
    const c = this.client;
    if (c.settings.mode === 'ffa') this.setTeam(NO_TEAM);
    else this.setTeam(autoTeam(c.playerList, c.settings.teamCount, c.playerId));
  }

  onShow(): void {
    this.chat.setLines(this.client.chat);
    this.refresh();
  }

  refresh(): void {
    const c = this.client;
    const s = c.settings;
    const me = c.me;
    const isHost = c.isHost;
    this.title.style.setProperty('--accent', typeAccentCss(s.gameType ?? 'warzone'));
    replaceChildren(this.title,
      h('span', { class: 'strong' }, s.name),
      h('span', { class: 'room-type' }, ` · ${roomTitleText(s)} `),
      h('span', { class: `phase phase-${c.phase}` }, c.phase),
      c.offline ? h('span', { class: 'badge' }, 'offline') : null);
    this.teamsHead.textContent = s.gameType === 'dungeon' ? 'Party' : 'Teams';

    this.renderTeams(me);
    this.renderClasses(me);
    this.renderSettings(isHost);
    this.renderActions(me, isHost);
    this.renderCountdown();
  }

  private memberRow(p: PlayerInfo): HTMLElement {
    const c = this.client;
    const color = teamCss(p.team, p.playerId);
    return h('li', { class: `member${p.playerId === c.playerId ? ' me' : ''}` },
      shipIcon(p.shipClass, color, 20),
      h('span', { class: 'member-name', style: `color:${color}` }, p.name),
      playerTitle(p) ? h('span', { class: 'member-title' }, playerTitle(p)) : null,
      p.isHost ? h('span', { class: 'crown', title: 'Host' }, '♛') : null,
      p.isBot ? h('span', { class: 'badge bot' }, 'BOT') : null,
      p.inMatch ? h('span', { class: 'badge live', title: 'In match' }, 'LIVE') : null,
      p.ready && !p.isBot ? h('span', { class: 'ready', title: 'Ready' }, '✔') : null,
      !p.isBot && p.ping ? h('span', { class: 'muted ping' }, `${p.ping}ms`) : null);
  }

  private renderTeams(me: PlayerInfo | undefined): void {
    const c = this.client;
    const s = c.settings;
    const cols: HTMLElement[] = [];
    const sortP = (a: PlayerInfo, b: PlayerInfo) => Number(a.isBot) - Number(b.isBot) || a.name.localeCompare(b.name);
    if (s.mode === 'teams') {
      for (let t = 0; t < s.teamCount; t++) {
        const members = c.playerList.filter((p) => p.team === t).sort(sortP);
        const color = teamColorCss(t);
        const mine = me?.team === t;
        const label = s.gameType === 'dungeon' ? (s.teamCount > 1 ? `Party ${t + 1}` : 'Party') : teamName(t);
        const count = s.gameType === 'dungeon' ? `${members.length}/${s.maxPlayers}` : String(members.length);
        cols.push(h('div', { class: `team-col${mine ? ' mine' : ''}`, style: `--team:${color}` },
          h('div', { class: 'team-head' }, h('span', null, label), h('span', { class: 'muted' }, count)),
          h('ul', { class: 'members' }, members.map((p) => this.memberRow(p))),
          h('button', {
            class: 'btn btn-small team-join', 'data-nav': `team-${t}`, disabled: mine,
            onclick: () => this.setTeam(t),
          }, mine ? 'Joined' : 'Join')));
      }
    } else {
      const members = c.playerList.filter((p) => p.team === NO_TEAM).sort(sortP);
      const mine = me?.team === NO_TEAM;
      cols.push(h('div', { class: `team-col ffa${mine ? ' mine' : ''}`, style: '--team:#ff5bd6' },
        h('div', { class: 'team-head' }, h('span', null, 'Free-for-all'), h('span', { class: 'muted' }, String(members.length))),
        h('ul', { class: 'members' }, members.map((p) => this.memberRow(p))),
        h('button', { class: 'btn btn-small team-join', 'data-nav': 'team-ffa', disabled: mine, onclick: () => this.setTeam(NO_TEAM) }, mine ? 'Joined' : 'Join')));
    }
    const specs = c.playerList.filter((p) => p.team < 0 && !(s.mode === 'ffa' && p.team === NO_TEAM)).sort(sortP);
    cols.push(h('div', { class: 'team-col spec', style: '--team:#9aa4c7' },
      h('div', { class: 'team-head' }, h('span', null, 'Spectators'), h('span', { class: 'muted' }, String(specs.length))),
      h('ul', { class: 'members' }, specs.map((p) => this.memberRow(p)))));
    replaceChildren(this.teams, cols);
    // Team columns share the row (max 4 per row); spectators get a full-width strip below.
    this.teams.style.setProperty('--cols', String(Math.max(1, Math.min(cols.length - 1, 4))));
  }

  private renderClasses(me: PlayerInfo | undefined): void {
    const cur: ShipClassId = me?.shipClass && SHIP_CLASSES[me.shipClass] ? me.shipClass : 'brute';
    const color = me ? teamCss(me.team, me.playerId) : '#3bf2ff';
    replaceChildren(this.classGrid, SHIP_CLASS_IDS.map((id) => {
      const def = SHIP_CLASSES[id];
      const b = h('button', {
        class: `class-card${id === cur ? ' selected' : ''}`, 'data-nav': `class-${id}`,
        'aria-pressed': id === cur ? 'true' : 'false',
        onclick: () => { this.client.send({ type: 'setShip', shipClass: id }); this.previewClass = null; this.cb.onUi('select'); },
      },
      h('div', { class: 'class-card-head' },
        shipIcon(id, id === cur ? color : '#8fa0d8', 40),
        h('div', null, h('div', { class: 'class-name' }, def.name), h('div', { class: 'class-arch' }, `${def.archetype} · ${def.role}`))),
      h('div', { class: 'class-desc' }, def.description),
      statBars(def.base));
      const preview = () => { if (this.previewClass !== id) { this.previewClass = id; this.pathTab = 0; this.renderDetail(cur); } };
      b.addEventListener('mouseenter', preview);
      b.addEventListener('focus', preview);
      return b;
    }));
    this.renderDetail(cur);
  }

  /** Skills, turret kit and the 3-path build planner for the previewed (or selected) class. */
  private renderDetail(cur: ShipClassId): void {
    const id = this.previewClass ?? cur;
    const key = `${id}|${cur}|${this.pathTab}`;
    if (key === this.detailKey && this.classDetail.childElementCount) return;
    this.detailKey = key;
    const def = SHIP_CLASSES[id];
    const kit = def.turret;
    const tab = Math.min(this.pathTab, def.paths.length - 1);
    replaceChildren(this.classDetail,
      h('div', { class: 'detail-head' },
        h('span', { class: 'strong' }, def.name),
        h('span', { class: 'muted' }, ` — ${def.archetype}`),
        id !== cur ? h('span', { class: 'badge' }, 'preview') : null),
      h('div', { class: 'detail-section' }, h('div', { class: 'path-label' }, 'Skills'),
        h('ul', { class: 'skill-list' }, SLOT_ORDER.map((slot) => {
          const sk = def.skills[slot];
          return h('li', { class: 'skill-row' },
            h('span', { class: 'skill-icon' }, sk.icon),
            h('span', { class: 'skill-body' }, h('span', { class: 'skill-name' }, sk.name), ' ', h('span', { class: 'skill-desc' }, sk.description)),
            slotGlyph(slot));
        }))),
      h('div', { class: 'detail-section' },
        h('div', { class: 'path-label' }, `Turret kit — ${kit.name}`, def.canTurret ? null : ' (cannot attach)'),
        h('ul', { class: 'skill-list' },
          h('li', { class: 'skill-row' }, h('span', { class: 'skill-icon' }, kit.offense.icon),
            h('span', { class: 'skill-body' }, h('span', { class: 'skill-name' }, kit.offense.name), ' ', h('span', { class: 'skill-desc' }, kit.offense.description)),
            slotGlyph('primary')),
          h('li', { class: 'skill-row' }, h('span', { class: 'skill-icon' }, kit.defense.icon),
            h('span', { class: 'skill-body' }, h('span', { class: 'skill-name' }, kit.defense.name), ' ', h('span', { class: 'skill-desc' }, kit.defense.description)),
            slotGlyph('secondary')))),
      h('div', { class: 'detail-section planner' },
        h('div', { class: 'path-label' }, 'Build planner — ', h('span', { class: 'muted' }, PATH_HINT)),
        h('div', { class: 'path-tabs', role: 'tablist' }, def.paths.map((p, i) => h('button', {
          class: `path-tab${i === tab ? ' active' : ''}`, role: 'tab', 'aria-selected': i === tab ? 'true' : 'false',
          'data-nav': `path-tab-${i}`, style: `--accent:${accentCss(p)}`,
          onclick: () => { this.pathTab = i; this.previewClass = id === cur ? null : id; this.renderDetail(cur); this.cb.onUi('click'); },
        }, h('span', null, p.icon), ' ', p.name))),
        pathBlock(def.paths[tab])));
  }

  private renderSettings(isHost: boolean): void {
    // Locked for non-hosts and outside the lobby (§2.5).
    const s = this.client.settings;
    this.settingsForm.render(s, !isHost || this.client.phase !== 'lobby');
    const rules = s.gameType === 'dungeon' ? riftRulesLine(s.floors)
      : isSubMode(s.subMode) ? objectiveRulesLine(s.subMode, s.mode, objectiveTarget(s.subMode, s.mode, s.objectiveLimit || 0)) : '';
    this.rulesEl.textContent = rules;
    this.rulesEl.classList.toggle('hidden', !rules);
  }

  private renderActions(me: PlayerInfo | undefined, isHost: boolean): void {
    const c = this.client;
    const els: HTMLElement[] = [];
    const picked = !!me && (c.settings.mode === 'ffa' ? me.team === NO_TEAM : me.team >= 0);
    if (c.phase === 'lobby') {
      els.push(h('button', {
        class: `btn btn-big ${me?.ready ? 'btn-accent' : 'btn-primary'}`, 'data-nav': 'ready',
        onclick: () => { c.send({ type: 'ready', ready: !me?.ready }); this.cb.onUi('click'); },
      }, me?.ready ? 'Ready ✔' : 'Ready'));
      if (isHost) {
        els.push(h('button', {
          class: 'btn btn-big btn-start', 'data-nav': 'start',
          onclick: () => { c.send({ type: 'startMatch' }); this.cb.onUi('start'); },
        }, 'Start Match'));
      } else {
        els.push(h('div', { class: 'muted' }, 'Waiting for the host to start…'));
      }
    } else if (c.phase === 'countdown') {
      els.push(h('div', { class: 'strong' }, 'Match starting…'));
    } else if (c.phase === 'playing') {
      if (!me?.inMatch) {
        // v0.3 M4: a running rift takes new pilots at its next floor start (you watch the party until then).
        const rift = c.settings.gameType === 'dungeon';
        const go = (how: 'join' | 'watch') => {
          if (how === 'join' && rift) c.noteRiftDropIn();
          for (const m of dropInMessages(how, me, c.settings, c.playerList, c.playerId)) c.send(m);
          this.cb.onUi('start');
        };
        els.push(h('button', { class: 'btn btn-big btn-start', 'data-nav': 'join-match', onclick: () => go('join') },
          dropInLabel(rift, picked || c.settings.mode === 'ffa')));
        if (!picked) els.push(h('button', { class: 'btn btn-big btn-ghost', 'data-nav': 'watch-match', onclick: () => go('watch') }, 'Watch Match'));
        if (rift) els.push(h('div', { class: 'muted small' }, 'The run is underway: you join the party at the next floor start and watch until then.'));
      } else {
        els.push(h('div', { class: 'muted' }, 'Entering the arena…'));
      }
    } else {
      els.push(h('div', { class: 'muted' }, 'Match results in progress…'));
    }
    if (!picked && c.phase === 'lobby') els.push(h('div', { class: 'muted small' }, 'You are spectating — join a team to play.'));
    replaceChildren(this.actions, els);
  }

  private renderCountdown(): void {
    const c = this.client;
    const on = c.phase === 'countdown';
    this.countdownEl.classList.toggle('hidden', !on);
    if (!on) { this.lastCountdown = -1; return; }
    // Server countdown is seconds; accept ticks too (defensive).
    const secs = c.countdown > 20 ? c.countdown / 60 : c.countdown;
    const n = Math.max(0, Math.ceil(secs));
    if (n !== this.lastCountdown) {
      this.lastCountdown = n;
      this.countdownEl.textContent = n > 0 ? String(n) : 'GO';
      this.countdownEl.classList.remove('pulse');
      void this.countdownEl.offsetWidth;
      this.countdownEl.classList.add('pulse');
      this.cb.onUi(n > 0 ? 'countdown' : 'start');
    }
  }
}
