// Results Debrief panel (docs/v0.3-proposal.md §2.5): the lootGrant's items revealed one at a time 350 ms
// apart (sealed crates first), "DUPLICATE → +N shards", the shard total, caches secured / lost, pity
// progress, and other pilots' epic-or-better highlights (MatchResult.lootHighlights).
import type { LootGrant, MatchResult } from '../../shared/protocol';
import type { GameClient } from '../net/GameClient';
import { h, replaceChildren, teamCss } from './dom';
import { rarityCss } from './gameTypeInfo';
import {
  cachesLine, debriefRows, othersHighlights, pityLine, rarityName, revealCount, REVEAL_STEP_MS, type DebriefRow,
} from './lootInfo';

export class DebriefPanel {
  readonly root = h('div', { class: 'debrief hidden', 'aria-live': 'polite' });
  private list = h('ul', { class: 'db-items' });
  private summary = h('div', { class: 'db-summary' });
  private others = h('div', { class: 'db-others' });
  private rows: DebriefRow[] = [];
  private rowEls: HTMLElement[] = [];
  private revealed = 0;
  private startAt = 0;
  private grant: LootGrant | null = null;

  constructor(private client: GameClient, private onUi: (name: string) => void) {
    this.root.append(
      h('div', { class: 'db-head' }, h('h2', null, 'Debrief')),
      this.list, this.summary, this.others);
  }

  /** New results: forget the previous grant, show others' highlights (if any). */
  reset(result: MatchResult | null): void {
    this.grant = null;
    this.rows = [];
    this.rowEls = [];
    this.revealed = 0;
    replaceChildren(this.list);
    replaceChildren(this.summary);
    this.renderOthers(result);
    this.syncVisible();
  }

  /** The local pilot's grant arrived (performance.now() of arrival). */
  setGrant(grant: LootGrant, arrivedAt: number): void {
    if (this.grant && this.grant.grantKey === grant.grantKey) return;
    this.grant = grant;
    this.startAt = arrivedAt;
    this.rows = debriefRows(grant);
    this.revealed = 0;
    this.rowEls = this.rows.map((r) => h('li', { class: 'db-item sealed', style: `--rarity:${rarityCss(r.rarity)}` },
      h('span', { class: 'db-crate', 'aria-hidden': 'true' }, '▣'),
      h('span', { class: 'db-name' }, r.fromLabel),
      h('span', { class: 'db-tag muted' }, '…')));
    replaceChildren(this.list, this.rowEls.length ? this.rowEls : h('li', { class: 'db-item empty muted' }, 'No items this time.'));
    replaceChildren(this.summary,
      h('span', { class: 'db-shards' }, `◆ +${Math.max(0, Math.round(grant.shards || 0))} shards`),
      cachesLine(grant) ? h('span', { class: 'muted' }, cachesLine(grant)) : null,
      // Online guests: crates roll against an empty server-side profile, so there is no pity to promise.
      this.client.deviceProfileMode ? null : h('span', { class: 'db-pity muted' }, pityLine(grant)));
    this.syncVisible();
  }

  /** Per frame while results are up: reveal the next item when its time comes. */
  update(now: number): void {
    if (!this.grant || this.revealed >= this.rows.length) return;
    const n = revealCount(now - this.startAt, this.rows.length, REVEAL_STEP_MS);
    while (this.revealed < n) {
      const i = this.revealed++;
      const r = this.rows[i];
      const el = this.rowEls[i];
      el.className = `db-item r-${r.rarity}${r.dupe ? ' dupe' : ' new'} pop`;
      replaceChildren(el,
        h('span', { class: 'db-rar' }, rarityName(r.rarity)),
        h('span', { class: 'db-name' }, r.name, h('span', { class: 'db-detail muted' }, ` ${r.detail}`)),
        h('span', { class: 'db-from muted small' }, r.fromLabel),
        h('span', { class: `db-tag${r.dupe ? ' dupe' : ' new'}` }, r.tag));
      this.onUi(r.rarity >= 4 ? 'reveal-legendary' : r.rarity >= 3 ? 'reveal-epic' : 'reveal');
    }
  }

  private renderOthers(result: MatchResult | null): void {
    const list = othersHighlights(result, this.client.playerId);
    replaceChildren(this.others, list.length
      ? [h('div', { class: 'path-label' }, 'Squad highlights'),
        ...list.map((x) => {
          const p = this.client.players.get(x.playerId);
          return h('div', { class: 'db-hl', style: `--rarity:${rarityCss(x.rarity)}` },
            h('span', { class: 'strong', style: `color:${teamCss(p?.team ?? -1, x.playerId)}` }, p?.name ?? `Pilot ${x.playerId}`),
            ' found ', h('span', { class: 'db-hl-item' }, x.itemName), h('span', { class: 'muted' }, ` (${rarityName(x.rarity)})`));
        })]
      : []);
  }

  private syncVisible(): void {
    this.root.classList.toggle('hidden', !this.grant && !this.others.childElementCount);
  }
}
