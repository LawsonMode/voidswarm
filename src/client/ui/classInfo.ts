// Shared class / skill / path presentation helpers (room lobby class picker, HUD, level-up cards).
import { PATH_LEVEL, TALENT_LEVELS } from '../../shared/constants';
import { SHIP_CLASS_IDS, SHIP_CLASSES } from '../../shared/data/ships';
import { hexToCss } from '../../shared/data/teams';
import type { PathDef, ShipStats, SkillSlot } from '../../shared/types';
import { glyph, h } from './dom';

export const SLOT_ORDER: readonly SkillSlot[] = ['primary', 'secondary', 'mobility', 'utility'];

/** Key glyphs per slot: [mouse+keyboard, gamepad]. */
export const SLOT_KEYS: Record<SkillSlot, [string, string]> = {
  primary: ['LMB', 'RT'],
  secondary: ['RMB', 'RB'],
  mobility: ['Space', 'A'],
  utility: ['E', 'LB'],
};

export function slotGlyph(slot: SkillSlot): HTMLElement {
  const [k, p] = SLOT_KEYS[slot];
  return glyph(k, p);
}

/** Energy cost of using a slot's skill. */
export function slotCost(stats: ShipStats, slot: SkillSlot): number {
  switch (slot) {
    case 'primary': return stats.gunCost;
    case 'secondary': return stats.secondaryCost;
    case 'mobility': return stats.mobilityCost;
    default: return stats.utilityCost;
  }
}

export function accentCss(p: PathDef): string {
  return hexToCss(p.accent);
}

interface StatDef { label: string; get(s: ShipStats): number }

export const CLASS_STATS: StatDef[] = [
  { label: 'Energy', get: (s) => s.maxEnergy },
  { label: 'Recharge', get: (s) => s.rechargePerSec },
  { label: 'Speed', get: (s) => s.maxSpeed },
  { label: 'Agility', get: (s) => s.turnRate * s.thrust },
  { label: 'Primary DPS', get: (s) => (s.gunDamage * s.gunCount) / Math.max(0.01, s.gunCooldown) },
  { label: 'Armor', get: (s) => 0.1 + s.armor },
  { label: 'Turret slots', get: (s) => s.maxTurrets },
];

const STAT_MAX = CLASS_STATS.map((d) => Math.max(...SHIP_CLASS_IDS.map((id) => d.get(SHIP_CLASSES[id].base))));

export function statBars(stats: ShipStats): HTMLElement {
  return h('div', { class: 'stat-bars' }, CLASS_STATS.map((sd, i) => {
    const v = sd.get(stats) / (STAT_MAX[i] || 1);
    return h('div', { class: 'stat' }, h('span', null, sd.label),
      h('span', { class: 'bar' }, h('span', { class: 'fill', style: `width:${Math.round(Math.max(0.08, Math.min(1, v)) * 100)}%` })));
  }));
}

/** Path details: header (icon/name/tagline), bonus, and the four talents. */
export function pathBlock(p: PathDef, opts: { talentsHeader?: boolean } = {}): HTMLElement {
  return h('div', { class: 'path-block', style: `--accent:${accentCss(p)}` },
    h('div', { class: 'path-head' },
      h('span', { class: 'path-icon' }, p.icon),
      h('span', { class: 'path-name' }, p.name),
      h('span', { class: 'path-tagline' }, p.tagline)),
    h('div', { class: 'path-bonus' }, h('span', { class: 'path-label' }, 'Path bonus'), ' ', p.description),
    opts.talentsHeader !== false
      ? h('div', { class: 'path-label' }, `Talents — offered at levels ${TALENT_LEVELS.join(' · ')}`)
      : null,
    h('ul', { class: 'talent-list' }, p.talents.map((t) => h('li', { class: 'talent' },
      h('span', { class: 'talent-icon' }, t.icon),
      h('span', { class: 'talent-body' }, h('span', { class: 'talent-name' }, t.name), ' ', h('span', { class: 'talent-desc' }, t.description))))));
}

export const PATH_HINT = `Paths are chosen in-match when you reach level ${PATH_LEVEL}.`;
