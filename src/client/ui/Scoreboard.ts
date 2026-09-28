// Tab / View scoreboard and the end-of-match results screen (v0.3: carried caches column, titles, Debrief;
// M3: objective columns — caps / returns / zone caps / objective time, FFA Hot Point points — and the result summary;
// M4: the rift outcome banner — RIFT CONQUERED / EXTRACTED — F3 / PARTY WIPED — F5 / ABANDONED — the run line, a
// per-pilot Status column (extracted / survived / lost / left), and "Party" for the dungeon's one team).
import { RESULTS_SEC } from '../../shared/constants';
import { SHIP_CLASSES } from '../../shared/data/ships';
import { teamName } from '../../shared/data/teams';
import type { LootGrant, MatchResult, PlayerInfo, PlayerScore } from '../../shared/protocol';
import type { GameMode, PlayerId, Rarity, SubMode } from '../../shared/types';
import type { GameClient } from '../net/GameClient';
import { DebriefPanel } from './Debrief';
import { h, replaceChildren, teamCss } from './dom';
import { rarityCss, resultModeLine, typeAccentCss } from './gameTypeInfo';
import { shipIcon } from './icons';
import { carriedByPlayer, rarityName } from './lootInfo';
import { objCell, objColumns, pointsMap, teamTotalUnit, type ObjColumn } from './objectiveInfo';
import { playerTitle, teamColorCss } from './RoomLobby';
import { riftResultModel, riftStatusMap } from './riftInfo';

const EMPTY_SCORE = (playerId: number): PlayerScore => ({ playerId, score: 0, kills: 0, deaths: 0, enemyKills: 0, bounty: 0, level: 1 });

type Carried = Map<PlayerId, { n: number; best: Rarity }>;

/** v0.3 carried column: unsecured caches (count, tinted by the best rarity); '—' when none. */
function carriedCell(c: { n: number; best: Rarity } | undefined): HTMLElement {
  if (!c) return h('td', { class: 'muted' }, '—');
  return h('td', { class: 'carried-cell', style: `--rarity:${rarityCss(c.best)}`, title: `${c.n} unsecured (best: ${rarityName(c.best)})` },
    h('span', { class: 'carried-pip' }), String(c.n));
}

/** v0.3 M3: the objective columns of this match, and FFA Hot Point points by player. */
export interface ObjCols { cols: ObjColumn[]; points: Map<PlayerId, number> | null; unit: string }

/** Objective columns for a sub-mode + allegiance (`pairs` = FFA Hot Point [playerId, points]). */
export function objColsFor(sub: SubMode | undefined, mode: GameMode, pairs: readonly [PlayerId, number][] | undefined): ObjCols {
  const cols = objColumns(sub, mode);
  return { cols, points: cols.some((c) => c.key === 'points') ? pointsMap(pairs) : null, unit: teamTotalUnit(sub) };
}

const NO_OBJ: ObjCols = { cols: [], points: null, unit: '' };

/** v0.3 M4 results: the rift Status column ("Extracted F3", "Lost F5", ...) by player id. */
type StatusCol = Map<PlayerId, string> | null;

/** A dungeon's one team is "Party" (Party 1 / 2 once v0.4 runs two). */
export function groupLabel(gameType: string, team: number, teamCount: number): string {
  if (gameType === 'dungeon') return teamCount > 1 ? `Party ${team + 1}` : 'Party';
  return teamName(team);
}

/** `carried` = the live scoreboard's carried column (null on the results screen: everything is settled). */
function scoreTable(
  client: GameClient, players: PlayerInfo[], scores: Map<number, PlayerScore>, showPing: boolean, carried: Carried | null, obj: ObjCols,
  status: StatusCol = null,
): HTMLElement {
  const pts = obj.points;
  const rows = players
    .map((p) => ({ p, s: scores.get(p.playerId) ?? EMPTY_SCORE(p.playerId) }))
    .sort((a, b) => (pts ? (pts.get(b.p.playerId) ?? 0) - (pts.get(a.p.playerId) ?? 0) : 0) || b.s.score - a.s.score);
  return h('table', { class: 'table score-table' },
    h('thead', null, h('tr', null,
      h('th', null, 'Pilot'), h('th', null, 'Class'), h('th', null, 'Lv'), h('th', null, 'K'), h('th', null, 'D'),
      h('th', null, 'Swarm'), h('th', null, 'Bounty'), h('th', null, 'Score'),
      obj.cols.map((col) => h('th', { class: 'obj-col', title: col.title }, col.label)),
      status ? h('th', { class: 'rift-col', title: 'How the run ended for this pilot' }, 'Status') : null,
      carried ? h('th', { title: 'Unsecured caches carried' }, 'Loot') : null,
      showPing ? h('th', null, 'Ping') : null)),
    h('tbody', null, rows.map(({ p, s }) => {
      const color = teamCss(client.mode === 'ffa' ? -1 : p.team, p.playerId);
      const title = playerTitle(p);
      return h('tr', { class: p.playerId === client.playerId ? 'me' : '' },
        h('td', { class: 'strong', style: `color:${color}` }, p.name,
          p.isBot ? h('span', { class: 'badge bot' }, 'BOT') : null,
          title ? h('span', { class: 'member-title score-title' }, title) : null),
        h('td', { title: SHIP_CLASSES[p.shipClass]?.name ?? p.shipClass }, shipIcon(p.shipClass, color, 16),
          h('span', { class: 'score-class-name' }, ` ${SHIP_CLASSES[p.shipClass]?.name ?? p.shipClass}`)),
        h('td', null, String(s.level)), h('td', null, String(s.kills)), h('td', null, String(s.deaths)),
        h('td', null, String(s.enemyKills)), h('td', null, String(s.bounty)), h('td', { class: 'strong' }, String(Math.round(s.score))),
        obj.cols.map((col) => h('td', { class: `obj-cell${col.key === 'points' ? ' strong' : ''}` }, objCell(col.key, s, pts))),
        status ? riftStatusCell(status.get(p.playerId)) : null,
        carried ? carriedCell(carried.get(p.playerId)) : null,
        showPing ? h('td', { class: 'muted' }, p.isBot ? '—' : `${p.ping}`) : null);
    })));
}

function riftStatusCell(label: string | undefined): HTMLElement {
  const v = label ?? '—';
  const kind = v.startsWith('Extracted') || v === 'Survived' ? 'good' : v.startsWith('Lost') ? 'bad' : 'muted';
  return h('td', { class: `rift-cell ${kind}` }, v);
}

function groups(
  client: GameClient, scores: Map<number, PlayerScore>, teamScores: number[] | null, showPing: boolean, carried: Carried | null = null,
  obj: ObjCols = NO_OBJ, status: StatusCol = null, gameType: string = client.gameType,
): HTMLElement[] {
  const c = client;
  const active = c.playerList.filter((p) => p.inMatch || scores.has(p.playerId));
  if (c.mode === 'teams') {
    const out: HTMLElement[] = [];
    const count = Math.max(c.teamCount, teamScores?.length ?? 0);
    for (let t = 0; t < count; t++) {
      const members = active.filter((p) => p.team === t);
      const total = teamScores?.[t] ?? members.reduce((a, p) => a + (scores.get(p.playerId)?.score ?? 0), 0);
      out.push(h('div', { class: 'score-group', style: `--team:${teamColorCss(t)}` },
        h('div', { class: 'score-group-head' }, h('span', null, groupLabel(gameType, t, count)),
          h('span', { class: 'ts-val' }, String(Math.round(total)), obj.unit ? h('span', { class: 'ts-unit' }, ` ${obj.unit}`) : null)),
        scoreTable(c, members, scores, showPing, carried, obj, status)));
    }
    return out;
  }
  return [h('div', { class: 'score-group', style: '--team:#ff5bd6' },
    h('div', { class: 'score-group-head' }, h('span', null, 'Free-for-all')),
    scoreTable(c, active, scores, showPing, carried, obj, status))];
}

export class Scoreboard {
  readonly root = h('div', { class: 'overlay scoreboard hidden' });
  private body = h('div', { class: 'score-body' });
  private lastAt = 0;
  visible = false;

  constructor(private client: GameClient) {
    this.root.append(h('div', { class: 'panel overlay-panel wide' }, h('h2', null, 'Scoreboard'), this.body));
  }

  setVisible(v: boolean, now: number): void {
    if (v !== this.visible) {
      this.visible = v;
      this.root.classList.toggle('hidden', !v);
      if (v) this.lastAt = 0;
    }
    if (v && now - this.lastAt > 250) {
      this.lastAt = now;
      const f = this.client.lastFrame;
      const m = f?.match;
      const carried = carriedByPlayer(f?.ships, f?.carry);
      const obj = objColsFor(m?.objective ? m.objective.mode : this.client.subMode, this.client.mode, m?.objective?.playerPoints);
      replaceChildren(this.body, groups(this.client, this.client.scores, m?.teamScores ?? null, true, carried, obj));
    }
  }
}

export class ResultsScreen {
  readonly root = h('div', { class: 'overlay results hidden' });
  private panel = h('div', { class: 'panel overlay-panel wide' });
  private countdownEl = h('div', { class: 'muted results-count' });
  private debrief: DebriefPanel;
  private shownAt = 0;
  visible = false;

  constructor(private client: GameClient, onUi: (name: string) => void = () => {}) {
    this.root.append(this.panel);
    this.debrief = new DebriefPanel(client, onUi);
  }

  /** v0.3: the local pilot's loot grant for this match (arrives right after matchEnd). */
  setGrant(grant: LootGrant, arrivedAt: number): void {
    this.debrief.setGrant(grant, arrivedAt);
  }

  show(r: MatchResult, now: number): void {
    const c = this.client;
    this.shownAt = now;
    this.visible = true;
    this.root.classList.remove('hidden');
    let banner: HTMLElement;
    const rift = r.rift && typeof r.rift === 'object' ? riftResultModel(r.rift, c.playerId) : null;
    if (rift) {
      // M4: the PvE outcome banner (§2.5) — the run, not a winning team.
      banner = h('div', { class: `winner rift-result ${rift.good ? 'good' : 'bad'}`, style: `--team:${rift.good ? typeAccentCss('dungeon') : '#ff3b5c'}` },
        h('div', { class: 'winner-sub' }, rift.sub), h('div', { class: 'winner-name' }, rift.title));
    } else if (c.mode === 'teams' && r.winnerTeam >= 0) {
      const color = teamColorCss(r.winnerTeam);
      const mine = c.me?.team === r.winnerTeam;
      banner = h('div', { class: 'winner', style: `--team:${color}` },
        h('div', { class: 'winner-sub' }, mine ? 'VICTORY' : 'MATCH OVER'), h('div', { class: 'winner-name' }, `${teamName(r.winnerTeam)} wins`));
    } else if (r.winnerPlayerId) {
      const name = c.players.get(r.winnerPlayerId)?.name ?? 'Unknown';
      const color = teamCss(-1, r.winnerPlayerId);
      banner = h('div', { class: 'winner', style: `--team:${color}` },
        h('div', { class: 'winner-sub' }, r.winnerPlayerId === c.playerId ? 'VICTORY' : 'MATCH OVER'), h('div', { class: 'winner-name' }, `${name} wins`));
    } else {
      banner = h('div', { class: 'winner', style: '--team:#3bf2ff' }, h('div', { class: 'winner-sub' }, 'MATCH OVER'), h('div', { class: 'winner-name' }, 'Draw'));
    }
    // v0.3: the banner sub-line names the game type and sub-mode ("Arena · Deathmatch", "Warzone · Classic").
    const modeLine = resultModeLine(r.gameType, r.subMode);
    if (modeLine) banner.appendChild(h('div', { class: 'winner-mode' }, modeLine));
    // M3: the objective summary ("Crimson 3 – 1 Azure (captures)").
    const summary = typeof r.objective?.summary === 'string' ? r.objective.summary.slice(0, 160) : '';
    if (summary) banner.appendChild(h('div', { class: 'winner-obj' }, summary));
    // M4: the run line ("All 6 floors cleared · …") and what happened to you.
    if (rift) {
      banner.appendChild(h('div', { class: 'winner-obj' }, rift.line));
      if (rift.you) banner.appendChild(h('div', { class: 'winner-you' }, rift.you));
    }
    const scores = new Map(r.scores.map((s) => [s.playerId, s]));
    this.debrief.reset(r);
    // The grant may already be here (it follows matchEnd, and lastGrant is cleared at every matchStart).
    if (c.lastGrant) this.debrief.setGrant(c.lastGrant, c.lastGrantAt || now);
    replaceChildren(this.panel,
      banner,
      this.debrief.root,
      r.awards.length ? h('div', { class: 'awards' }, r.awards.map((a) => h('div', { class: 'award' },
        h('div', { class: 'award-title' }, a.title),
        h('div', { class: 'award-name', style: `color:${teamCss(c.players.get(a.playerId)?.team ?? -1, a.playerId)}` }, c.players.get(a.playerId)?.name ?? '—'),
        h('div', { class: 'award-val muted' }, a.value)))) : null,
      h('div', { class: 'score-body' }, groups(c, scores, r.teamScores.length ? r.teamScores : null, false, null,
        objColsFor(r.objective?.mode ?? r.subMode, c.mode, r.objective?.playerPoints),
        rift ? riftStatusMap(r.rift) : null, r.gameType ?? c.gameType)),
      this.countdownEl);
  }

  hide(): void {
    this.visible = false;
    this.root.classList.add('hidden');
  }

  update(now: number): void {
    if (!this.visible) return;
    this.debrief.update(now);
    const left = Math.max(0, RESULTS_SEC - (now - this.shownAt) / 1000);
    this.countdownEl.textContent = left > 0 ? `Back to the room lobby in ${Math.ceil(left)}s` : 'Returning to lobby…';
  }
}
