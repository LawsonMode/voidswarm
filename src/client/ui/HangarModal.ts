// v0.3 Hangar (docs/v0.3-proposal.md §2.4): a full-bleed modal to equip cosmetics per class.
// Header: back, shards, per-set progress. Left: class tabs + 7 slot rows. Centre: SVG hull preview in a team
// colour with a swatch row (8 teams + FFA) for readability checks. Right: filters + 4-column item grid with
// rarity borders (equipped / owned / locked / NEW) and a detail drawer with [Equip]. Viewing an item sends
// seenItems (batched). Gamepad: FocusNav, LB/RB switch class (cycleClass), A on a selected tile equips it.
// Keyboard: [ / ] switch class too.
import { NO_TEAM } from '../../shared/constants';
import { COSMETICS, isStarter, type CosmeticDef } from '../../shared/data/cosmetics';
import { SHIP_CLASS_IDS, SHIP_CLASSES } from '../../shared/data/ships';
import { colorFor, hexToCss, TEAM_COLORS, TEAM_NAMES } from '../../shared/data/teams';
import { LOOT_SETS, type CosmeticId, type CosmeticSlot, type ShipClassId } from '../../shared/types';
import type { GameClient } from '../net/GameClient';
import { hangarPreview, itemIcon, SLOT_GLYPHS, type PreviewLook } from './cosmeticIcons';
import { h, replaceChildren } from './dom';
import { rarityCss } from './gameTypeInfo';
import { shipIcon } from './icons';
import {
  collection, dropSourceLines, dropsInText, equippedId, filterLabel, framedTitle, HANGAR_FILTERS, HANGAR_SLOTS,
  hangarItems, rarityName, setDisplayName, SET_SHORT, shardsOf, SLOT_LABELS, tileState, type HangarFilter,
} from './lootInfo';
import { Modal } from './Overlays';

export interface HangarCallbacks {
  onUi(name: string): void;
}

/** Swatch index 8 = FFA (a per-player hue). */
const SWATCH_FFA = TEAM_COLORS.length;
const SEEN_FLUSH_MS = 600;

export class HangarModal extends Modal {
  private cls: ShipClassId = 'brute';
  private slot: CosmeticSlot = 'hull';
  private filter: HangarFilter = 'all';
  private selected: CosmeticId | null = null;
  private swatch = 0;
  private pendingSeen = new Set<CosmeticId>();
  private seenTimer: ReturnType<typeof setTimeout> | null = null;
  /** Item ids already reported seen this session (NEW badges clear once, not on every view). */
  private reported = new Set<CosmeticId>();

  constructor(private client: GameClient, private cb: HangarCallbacks) {
    super('hangar-modal');
    client.on('profile', () => { if (this.visible) this.render(); });
  }

  protected build(): void {
    const me = this.client.me;
    if (me?.shipClass && SHIP_CLASSES[me.shipClass]) this.cls = me.shipClass;
    this.swatch = me && me.team >= 0 ? me.team % TEAM_COLORS.length : me?.team === NO_TEAM ? SWATCH_FFA : this.swatch;
    this.selected = null;
    this.reported.clear();
    this.render();
  }

  override close(): void {
    this.flushSeen();
    super.close();
  }

  /** LB / RB (keyboard [ / ]): previous / next class tab. */
  cycleClass(dir: number): void {
    const i = SHIP_CLASS_IDS.indexOf(this.cls);
    const n = SHIP_CLASS_IDS.length;
    this.setClass(SHIP_CLASS_IDS[(((i + dir) % n) + n) % n]);
  }

  private setClass(c: ShipClassId): void {
    if (c === this.cls) return;
    this.cls = c;
    // A class-slot selection belongs to the old class's items.
    if (this.selected && COSMETICS[this.selected] && (this.slot === 'hull' || this.slot === 'weapon' || this.slot === 'turret')) this.selected = null;
    this.cb.onUi('select');
    this.render();
  }

  private teamColor(): string {
    return this.swatch >= SWATCH_FFA ? hexToCss(colorFor(NO_TEAM, this.client.playerId || 7)) : hexToCss(TEAM_COLORS[this.swatch]);
  }

  private render(): void {
    const c = this.client;
    const p = c.profile;
    const team = this.teamColor();

    // ---- header
    const notice = !p
      ? h('div', { class: 'hg-notice muted' }, 'Loading your profile…')
      : c.onDevice
        ? h('div', { class: 'hg-notice device' }, 'DEVICE PROFILE: items stay on this device',
          c.deviceReadOnly ? h('span', { class: 'hg-volatile' }, ' · from a newer version: read-only, loot won’t be saved')
            : c.deviceVolatile ? h('span', { class: 'hg-volatile' }, ' · storage blocked: loot won’t survive a reload') : null)
        : c.profileSource === 'server' && !c.profilePersisted
          ? h('div', { class: 'hg-notice warn-line' }, 'Loot won’t be saved this session')
          : null;
    const head = h('div', { class: 'hg-head' },
      h('button', { class: 'btn btn-ghost', 'data-nav': 'hg-back', onclick: () => this.close() }, '◀ Back'),
      h('h2', null, 'Hangar'),
      h('span', { class: 'hg-shards', title: 'Shards (spent on crafting in a later update)' }, `◆ ${shardsOf(p)}`),
      h('div', { class: 'hg-sets' }, LOOT_SETS.map((set) => {
        const col = collection(p, set);
        return h('span', { class: `hg-set${col.have >= col.total ? ' done' : ''}`, title: setDisplayName(set) },
          h('span', { class: 'hg-set-name' }, SET_SHORT[set]), ` ${col.have}/${col.total}`);
      })),
      notice);

    // ---- left: class tabs + slot rows
    const tabs = h('div', { class: 'hg-classes', role: 'tablist' },
      h('span', { class: 'glyph pad-only hg-lb' }, h('kbd', null, 'LB')),
      h('span', { class: 'glyph kbm-only hg-lb' }, h('kbd', null, '[')),
      SHIP_CLASS_IDS.map((id) => h('button', {
        class: `hg-class${id === this.cls ? ' on' : ''}`, role: 'tab', 'aria-selected': id === this.cls ? 'true' : 'false',
        'data-nav': `hg-class-${id}`, onclick: () => this.setClass(id),
      }, shipIcon(id, id === this.cls ? team : '#8fa0d8', 22), h('span', null, SHIP_CLASSES[id].name))),
      h('span', { class: 'glyph pad-only hg-rb' }, h('kbd', null, 'RB')),
      h('span', { class: 'glyph kbm-only hg-rb' }, h('kbd', null, ']')));
    const slots = h('div', { class: 'hg-slots' }, HANGAR_SLOTS.map((slot) => {
      const id = equippedId(p, slot, this.cls);
      const def = COSMETICS[id];
      return h('button', {
        class: `hg-slot${slot === this.slot ? ' on' : ''}`, 'data-nav': `hg-slot-${slot}`,
        onclick: () => { if (this.slot !== slot) { this.slot = slot; this.selected = null; this.cb.onUi('click'); this.render(); } },
      },
      h('span', { class: 'hg-slot-icon', 'aria-hidden': 'true' }, SLOT_GLYPHS[slot]),
      h('span', { class: 'hg-slot-body' },
        h('span', { class: 'hg-slot-name' }, SLOT_LABELS[slot]),
        h('span', { class: 'hg-slot-item' }, def?.name ?? id)),
      h('span', { class: 'hg-pip', style: `--rarity:${rarityCss(def?.rarity ?? 0)}`, title: rarityName(def?.rarity ?? 0) }));
    }));
    const left = h('div', { class: 'hg-left' }, tabs, slots);

    // ---- centre: preview + swatches
    const look = this.previewLook();
    const title = framedTitle(COSMETICS[equippedId(p, 'title', this.cls)]);
    const killicon = COSMETICS[equippedId(p, 'killicon', this.cls)];
    const death = COSMETICS[equippedId(p, 'death', this.cls)];
    const centre = h('div', { class: 'hg-centre' },
      h('div', { class: 'hg-preview' }, hangarPreview(this.cls, look, team)),
      h('div', { class: 'hg-nameplate', style: `color:${team}` },
        h('span', { class: 'strong' }, this.client.name || 'Pilot'),
        title ? h('span', { class: 'member-title' }, ` ${title}`) : null),
      h('div', { class: 'hg-vanity muted small' },
        killicon && killicon.slot === 'killicon' ? h('span', { title: 'Kill icon', style: `color:${team}` }, killicon.p.glyph) : null,
        ' · ', death ? death.name : ''),
      h('div', { class: 'hg-swatches', role: 'radiogroup', 'aria-label': 'Preview team colour' },
        [...TEAM_COLORS.map((col, i) => ({ i, col: hexToCss(col), name: TEAM_NAMES[i] })),
          { i: SWATCH_FFA, col: hexToCss(colorFor(NO_TEAM, this.client.playerId || 7)), name: 'FFA' }]
          .map(({ i, col, name }) => h('button', {
            class: `hg-swatch${i === this.swatch ? ' on' : ''}`, style: `--sw:${col}`, 'data-nav': `hg-sw-${i}`,
            title: name, 'aria-label': name, 'aria-pressed': i === this.swatch ? 'true' : 'false',
            onclick: () => { this.swatch = i; this.cb.onUi('click'); this.render(); },
          }, i === SWATCH_FFA ? 'FFA' : ''))));

    // ---- right: filters, grid, drawer
    const items = hangarItems(this.slot, this.cls, this.filter, p);
    const filters = h('div', { class: 'submode-chips hg-filters', role: 'toolbar', 'aria-label': 'Filter items' },
      HANGAR_FILTERS.map((f) => h('button', {
        class: `chip${f === this.filter ? ' on' : ''}`, 'data-nav': `hg-f-${f}`, 'aria-pressed': f === this.filter ? 'true' : 'false',
        onclick: () => { this.filter = f; this.cb.onUi('click'); this.render(); },
      }, filterLabel(f))));
    const grid = h('div', { class: 'hg-grid' }, items.map((def) => this.tile(def, team)));
    const right = h('div', { class: 'hg-right' },
      h('div', { class: 'hg-right-head' },
        h('span', { class: 'path-label' }, `${SLOT_LABELS[this.slot]}${this.slot === 'hull' || this.slot === 'weapon' || this.slot === 'turret' ? ` · ${SHIP_CLASSES[this.cls].name}` : ''}`),
        filters),
      items.length ? grid : h('div', { class: 'muted empty' }, this.filter === 'owned' ? 'Nothing owned here yet.' : 'No items match.'),
      this.drawer(team));

    replaceChildren(this.panel, head, h('div', { class: 'hg-body' }, left, centre, right));
  }

  /** Equipped look for the class, with the selected (viewed) item tried on when it is one of the preview slots. */
  private previewLook(): PreviewLook {
    const p = this.client.profile;
    const def = (slot: CosmeticSlot) => COSMETICS[equippedId(p, slot, this.cls)];
    const out: PreviewLook = {};
    const hull = def('hull'), weapon = def('weapon'), turret = def('turret'), engine = def('engine');
    if (hull?.slot === 'hull') out.hull = hull.p;
    if (weapon?.slot === 'weapon') out.weapon = weapon.p;
    if (turret?.slot === 'turret') out.turret = turret.p;
    if (engine?.slot === 'engine') out.engine = engine.p;
    const sel = this.selected ? COSMETICS[this.selected] : undefined;
    if (sel) {
      if (sel.slot === 'hull' && sel.shipClass === this.cls) out.hull = sel.p;
      else if (sel.slot === 'weapon' && sel.shipClass === this.cls) out.weapon = sel.p;
      else if (sel.slot === 'turret' && sel.kit === SHIP_CLASSES[this.cls].turret.id) out.turret = sel.p;
      else if (sel.slot === 'engine') out.engine = sel.p;
    }
    return out;
  }

  private tile(def: CosmeticDef, team: string): HTMLElement {
    const p = this.client.profile;
    const st = tileState(p, def, this.slot, this.cls);
    const on = this.selected === def.id;
    const cls = ['hg-tile', `r-${def.rarity}`, st.equipped ? 'equipped' : '', st.locked ? 'locked' : 'owned', st.fresh ? 'fresh' : '', on ? 'on' : '']
      .filter(Boolean).join(' ');
    return h('button', {
      class: cls, style: `--rarity:${rarityCss(def.rarity)}`, 'data-nav': `hg-item-${def.id}`,
      title: `${def.name} · ${rarityName(def.rarity)} · ${setDisplayName(def.set)}`,
      'aria-pressed': on ? 'true' : 'false',
      onclick: () => {
        // A second press on the selected, owned tile equips it (gamepad: A, A).
        if (on && st.owned && !st.equipped) { this.equip(def); return; }
        this.select(def.id);
      },
    },
    st.fresh ? h('span', { class: 'hg-new' }, 'NEW') : null,
    st.equipped ? h('span', { class: 'hg-eq', title: 'Equipped' }, '✔') : null,
    h('span', { class: 'hg-tile-icon' }, itemIcon(def, this.cls, st.locked ? '#8a93bd' : team, 40)),
    h('span', { class: 'hg-tile-name' }, def.name),
    st.locked ? h('span', { class: 'hg-tile-lock' }, dropsInText(def)) : h('span', { class: 'hg-tile-rar' }, rarityName(def.rarity)));
  }

  private drawer(team: string): HTMLElement {
    const def = this.selected ? COSMETICS[this.selected] : undefined;
    if (!def) {
      return h('div', { class: 'hg-drawer muted' },
        'Pick an item to see where it drops. Locked items show their game type; every set has its own look.');
    }
    const p = this.client.profile;
    const st = tileState(p, def, this.slot, this.cls);
    const canEquip = !!p && st.owned && !st.equipped;
    return h('div', { class: `hg-drawer r-${def.rarity}`, style: `--rarity:${rarityCss(def.rarity)}` },
      h('div', { class: 'hg-drawer-head' },
        h('span', { class: 'hg-drawer-icon' }, itemIcon(def, this.cls, st.locked ? '#8a93bd' : team, 48)),
        h('div', null,
          h('div', { class: 'hg-drawer-name' }, def.name),
          h('div', { class: 'hg-drawer-sub' }, `${rarityName(def.rarity)} · ${SLOT_LABELS[def.slot]} · ${setDisplayName(def.set)}`))),
      def.flavor ? h('div', { class: 'hg-flavor' }, `“${def.flavor}”`) : null,
      h('ul', { class: 'hg-sources' }, dropSourceLines(def).map((l) => h('li', null, l))),
      h('div', { class: 'modal-buttons' },
        h('button', {
          class: 'btn btn-primary', 'data-nav': 'hg-equip', disabled: !canEquip,
          onclick: () => this.equip(def),
        }, st.equipped ? 'Equipped' : st.locked ? 'Locked' : 'Equip')));
  }

  private select(id: CosmeticId): void {
    this.selected = id;
    const p = this.client.profile;
    if (p && Array.isArray(p.fresh) && p.fresh.includes(id) && !this.reported.has(id)) {
      this.reported.add(id);
      this.pendingSeen.add(id);
      if (!this.seenTimer) this.seenTimer = setTimeout(() => this.flushSeen(), SEEN_FLUSH_MS);
    }
    this.cb.onUi('click');
    this.render();
  }

  private flushSeen(): void {
    if (this.seenTimer) { clearTimeout(this.seenTimer); this.seenTimer = null; }
    if (!this.pendingSeen.size) return;
    const ids = [...this.pendingSeen];
    this.pendingSeen.clear();
    this.client.seenItems(ids);
  }

  private equip(def: CosmeticDef): void {
    const itemId = isStarter(def.id) ? '' : def.id;
    const classSlot = def.slot === 'hull' || def.slot === 'weapon' || def.slot === 'turret';
    if (this.client.equip(def.slot, itemId, classSlot ? this.cls : undefined)) this.cb.onUi('equip');
    else this.cb.onUi('error');
  }
}
