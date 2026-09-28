// Level-up offer cards: general cards, "Choose your path" fork cards, and path-accented talent cards.
import { PATHS, TALENTS } from '../../shared/data/ships';
import type { PathDef, PathId, UpgradeChoice } from '../../shared/types';
import { accentCss } from './classInfo';
import { glyph, h, replaceChildren } from './dom';

const PAD_GLYPHS = ['◀', '▲', '▶'];

/** PathDef for a path offer (`path:<PathId>`), or null. */
export function pathForChoice(o: UpgradeChoice): PathDef | null {
  if (o.category !== 'path') return null;
  const id = (o.id.startsWith('path:') ? o.id.slice(5) : o.id) as PathId;
  return PATHS[id] ?? null;
}

/** Owning path of a talent offer, or null. */
export function talentPath(o: UpgradeChoice): PathDef | null {
  if (o.category !== 'talent') return null;
  const t = TALENTS[o.id];
  return t ? PATHS[t.path] ?? null : null;
}

export type OfferKind = 'path' | 'talent' | 'general';

export function offerKind(offer: readonly UpgradeChoice[]): OfferKind {
  if (offer.length && offer.every((o) => o.category === 'path')) return 'path';
  if (offer.length && offer.every((o) => o.category === 'talent')) return 'talent';
  return 'general';
}

export class LevelUpCards {
  readonly root = h('div', { class: 'levelup' });
  private key = '';
  private picked = -1;

  constructor(private onPick: (i: number) => void) {}

  render(offer: UpgradeChoice[] | null, queued: number): void {
    const key = offer ? offer.map((o) => `${o.id}:${o.level}`).join('|') + `+${queued}` : '';
    if (key === this.key) return;
    this.key = key;
    this.picked = -1;
    this.root.classList.remove('picked');
    if (!offer || !offer.length) {
      replaceChildren(this.root);
      this.root.classList.remove('show');
      this.root.removeAttribute('data-kind');
      return;
    }
    const kind = offerKind(offer);
    const title = kind === 'path' ? 'CHOOSE YOUR PATH' : kind === 'talent' ? 'TALENT — choose one' : 'LEVEL UP — choose one';
    const accent = kind === 'talent' ? talentPath(offer[0]) : null;
    this.root.dataset.kind = kind;
    replaceChildren(this.root,
      h('div', { class: 'levelup-title', style: accent ? `--accent:${accentCss(accent)}` : null },
        title, queued > 0 ? h('span', { class: 'queued' }, ` +${queued} more`) : null),
      h('div', { class: 'cards' }, offer.slice(0, 3).map((o, i) => this.card(o, i))));
    this.root.classList.remove('show');
    void this.root.offsetWidth;
    this.root.classList.add('show');
  }

  /** Show that card `i` was picked (the offer stays up until the next snapshot); -1 = none. */
  setPicked(i: number): void {
    if (i === this.picked) return;
    this.picked = i;
    this.root.classList.toggle('picked', i >= 0);
    const cards = this.root.querySelectorAll<HTMLElement>('.card');
    cards.forEach((el, j) => el.classList.toggle('chosen', j === i));
  }

  private card(o: UpgradeChoice, i: number): HTMLElement {
    const key = h('div', { class: 'card-key' }, glyph(String(i + 1), PAD_GLYPHS[i]));
    const pick = () => this.onPick(i);
    const path = pathForChoice(o);
    if (path) {
      return h('button', { class: 'card card-path', tabindex: -1, style: `--accent:${accentCss(path)}`, onclick: pick },
        key,
        h('div', { class: 'card-icon big' }, path.icon || o.icon),
        h('div', { class: 'card-name' }, path.name),
        h('div', { class: 'card-tagline' }, path.tagline),
        h('div', { class: 'card-desc' }, path.description || o.description),
        h('div', { class: 'card-talents' },
          h('div', { class: 'card-sub' }, 'Talents'),
          path.talents.map((t) => h('div', { class: 'card-talent', title: t.description }, h('span', null, t.icon), ' ', t.name))));
    }
    const tp = talentPath(o);
    if (tp) {
      return h('button', { class: 'card card-talent-offer', tabindex: -1, style: `--accent:${accentCss(tp)}`, onclick: pick },
        key,
        h('div', { class: 'card-level' }, `TALENT · ${tp.name.toUpperCase()}`),
        h('div', { class: 'card-icon' }, o.icon || TALENTS[o.id]?.icon || '✦'),
        h('div', { class: 'card-name' }, o.name),
        h('div', { class: 'card-desc' }, o.description));
    }
    return h('button', { class: `card cat-${o.category}`, tabindex: -1, onclick: pick },
      key,
      h('div', { class: 'card-icon' }, o.icon || '✦'),
      h('div', { class: 'card-name' }, o.name),
      h('div', { class: 'card-level' }, o.level <= 1 ? 'NEW' : `LV ${o.level}/${o.maxLevel}`),
      h('div', { class: 'card-desc' }, o.description));
  }
}
