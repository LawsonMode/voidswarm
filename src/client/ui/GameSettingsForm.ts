// Type-aware match settings rows, shared by CreateGameModal and the RoomLobby host panel.
// Which rows exist (and their options) comes from gameTypeInfo.settingsFields; this only draws them.
import type { RoomSettings } from '../../shared/protocol';
import { h, replaceChildren } from './dom';
import { fieldPatch, settingsFields, type FieldSpec, type SettingsKey } from './gameTypeInfo';

export interface GameSettingsFormOpts {
  /** data-nav prefix (FocusNav keys must be unique per screen). */
  nav: string;
  /** Show the Game type row (host type switch / Create). */
  includeType: boolean;
  onChange(patch: Partial<RoomSettings>): void;
}

type Control = HTMLSelectElement | HTMLInputElement;

export class GameSettingsForm {
  readonly root: HTMLElement;
  private sig = '';
  private controls = new Map<SettingsKey, Control>();

  constructor(private opts: GameSettingsFormOpts) {
    this.root = h('div', { class: 'settings-grid game-settings' });
  }

  /** Draw `s`. Rows are rebuilt only when the set of rows / options changes; otherwise values update in place. */
  render(s: RoomSettings, locked: boolean): void {
    const fields = settingsFields(s, this.opts.includeType);
    const sig = fields.map(signature).join('|');
    if (sig !== this.sig) {
      this.sig = sig;
      this.controls.clear();
      replaceChildren(this.root, fields.map((f) => this.row(f)));
    }
    for (const f of fields) {
      const el = this.controls.get(f.key);
      if (!el) continue;
      if (document.activeElement !== el) setValue(el, f.value);
      el.disabled = locked;
    }
    this.root.classList.toggle('locked', locked);
  }

  private row(f: FieldSpec): HTMLElement {
    const nav = `${this.opts.nav}-${f.key}`;
    let el: Control;
    if (f.kind === 'select') {
      const sel = h('select', { 'data-nav': nav },
        (f.options ?? []).map((o) => h('option', { value: o.value, disabled: o.disabled }, o.label)));
      sel.addEventListener('change', () => this.opts.onChange(fieldPatch(f.key, sel.value)));
      el = sel;
    } else if (f.kind === 'check') {
      const cb = h('input', { type: 'checkbox', 'data-nav': nav });
      cb.addEventListener('change', () => this.opts.onChange(fieldPatch(f.key, cb.checked)));
      el = cb;
    } else {
      const num = h('input', { type: 'number', class: 'field small', min: f.min, max: f.max, step: 1, 'data-nav': nav });
      num.addEventListener('change', () => {
        const n = Math.round(Number(num.value));
        const v = Number.isFinite(n) ? Math.max(f.min ?? 0, Math.min(f.max ?? 32, n)) : Number(f.value);
        num.value = String(v);
        this.opts.onChange(fieldPatch(f.key, String(v)));
      });
      el = num;
    }
    setValue(el, f.value);
    this.controls.set(f.key, el);
    return h('label', { class: `set-row set-${f.key}` }, h('span', null, f.label), h('span', { class: 'set-ctl' }, el));
  }
}

function signature(f: FieldSpec): string {
  const opts = (f.options ?? []).map((o) => `${o.value}=${o.label}${o.disabled ? '!' : ''}`).join(',');
  return `${f.key}:${f.kind}:${f.label}:${f.min ?? ''}-${f.max ?? ''}:${opts}`;
}

function setValue(el: Control, v: string | boolean): void {
  if (el instanceof HTMLInputElement && el.type === 'checkbox') {
    el.checked = v === true;
  } else if (el.value !== String(v)) {
    el.value = String(v);
  }
}
