// HUD skill bar: icon, key glyph, radial cooldown sweep + seconds, dimmed when unaffordable.
import { glyph, h, setStyle, setText, toggleClass } from './dom';

export interface SlotSpec {
  icon: string;
  name: string;
  /** [keyboard/mouse, gamepad] glyphs */
  keys: [string, string];
  /** "hold" skills (turret defense) get a small HOLD tag. */
  hold?: boolean;
  /** Small caption under the name, e.g. "host energy". */
  note?: string;
}

export interface SlotState {
  /** 0..1 remaining cooldown (0 = ready). */
  cd: number;
  /** Seconds remaining (shown when > 0), or null to hide the number. */
  cdSec: number | null;
  /** Not enough energy (or host energy) to use it. */
  dim: boolean;
  /** Effect currently running (Iron Hide, Ram Charge, laser firing...). */
  active: boolean;
}

interface SlotEls { root: HTMLElement; cdNum: HTMLElement }

export class SkillBar {
  readonly root = h('div', { class: 'skillbar' });
  private els: SlotEls[] = [];
  private key = '';

  /** Rebuild slots only when `key` changes (class / turret mode switch). */
  setSlots(key: string, specs: SlotSpec[]): void {
    if (key === this.key) return;
    this.key = key;
    this.root.textContent = '';
    this.els = specs.map((s) => {
      const cdNum = h('span', { class: 'sk-cd' });
      const root = h('div', { class: 'skill', title: s.name },
        h('div', { class: 'sk-face' },
          h('span', { class: 'sk-icon' }, s.icon),
          h('span', { class: 'sk-sweep' }),
          cdNum,
          h('span', { class: 'sk-key' }, glyph(s.keys[0], s.keys[1])),
          s.hold ? h('span', { class: 'sk-hold' }, 'HOLD') : null),
        h('div', { class: 'sk-name' }, s.name),
        s.note ? h('div', { class: 'sk-note' }, s.note) : null);
      this.root.appendChild(root);
      return { root, cdNum };
    });
  }

  update(i: number, st: SlotState): void {
    const e = this.els[i];
    if (!e) return;
    const cd = Math.max(0, Math.min(1, st.cd));
    setStyle(e.root, '--p', cd.toFixed(3));
    toggleClass(e.root, 'ready', cd <= 0 && !st.dim);
    toggleClass(e.root, 'cooling', cd > 0);
    toggleClass(e.root, 'dim', st.dim);
    toggleClass(e.root, 'active', st.active);
    const sec = st.cdSec !== null && st.cdSec > 0.05 ? (st.cdSec >= 10 ? st.cdSec.toFixed(0) : st.cdSec.toFixed(1)) : '';
    setText(e.cdNum, sec);
  }
}
