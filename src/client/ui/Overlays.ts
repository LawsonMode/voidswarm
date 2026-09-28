// Modal overlays: Esc menu, settings, controls (F1), Create Game dialog, notices, toasts.
import { GAME_TYPES } from '../../shared/data/gameTypes';
import type { RoomSettings } from '../../shared/protocol';
import type { GameType } from '../../shared/types';
import type { ClientSettings } from '../settings';
import { h, replaceChildren } from './dom';
import { createDefaults, defaultCommandType, normalizeDraft, typeAccentCss } from './gameTypeInfo';
import { GameSettingsForm } from './GameSettingsForm';
import { riftRulesLine } from './riftInfo';

export abstract class Modal {
  readonly root: HTMLElement;
  protected panel: HTMLElement;
  visible = false;
  onClose: (() => void) | null = null;

  constructor(cls: string) {
    this.panel = h('div', { class: 'panel overlay-panel', role: 'dialog' });
    this.root = h('div', { class: `overlay modal ${cls} hidden` }, this.panel);
    this.root.addEventListener('mousedown', (e) => { if (e.target === this.root) this.close(); });
  }

  open(): void {
    this.visible = true;
    this.root.classList.remove('hidden');
    this.build();
    const first = this.panel.querySelector<HTMLElement>('[data-autofocus]') ?? this.panel.querySelector<HTMLElement>('button, input, select');
    first?.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.classList.add('hidden');
    this.onClose?.();
  }

  protected abstract build(): void;
}

export class MenuModal extends Modal {
  constructor(private items: () => { label: string; action: () => void; danger?: boolean }[]) { super('menu'); }
  protected build(): void {
    this.panel.replaceChildren(
      h('h2', null, 'Menu'),
      h('div', { class: 'menu-buttons' }, this.items().map((it, i) => h('button', {
        class: `btn btn-big ${it.danger ? 'btn-danger' : i === 0 ? 'btn-primary' : ''}`, 'data-nav': `menu-${i}`,
        onclick: () => it.action(), 'data-autofocus': i === 0 ? true : undefined,
      }, it.label))));
  }
}

export class SettingsModal extends Modal {
  constructor(private get: () => ClientSettings, private set: (s: ClientSettings) => void) { super('settings-modal'); }
  protected build(): void {
    const s = { ...this.get() };
    const commit = () => this.set({ ...s });
    const range = (key: 'deadzone' | 'volume' | 'musicVolume' | 'screenShake', min: number, max: number, step: number, fmt: (v: number) => string) => {
      const out = h('output', { class: 'range-out' }, fmt(s[key]));
      const inp = h('input', { type: 'range', min, max, step, value: String(s[key]), 'data-nav': `s-${key}` });
      inp.addEventListener('input', () => { s[key] = Number(inp.value); out.textContent = fmt(s[key]); commit(); });
      return [inp, out];
    };
    const aim = h('select', { 'data-nav': 's-aim' },
      h('option', { value: 'auto' }, 'Auto (last used device)'), h('option', { value: 'mouse' }, 'Mouse'), h('option', { value: 'stick' }, 'Right stick'));
    aim.value = s.aimMode;
    aim.addEventListener('change', () => { s.aimMode = aim.value as ClientSettings['aimMode']; commit(); });
    const fps = h('input', { type: 'checkbox', checked: s.showFps, 'data-nav': 's-fps' });
    fps.addEventListener('change', () => { s.showFps = fps.checked; commit(); });
    const musicMute = h('input', { type: 'checkbox', checked: s.musicMuted, 'data-nav': 's-music-mute', 'aria-label': 'Mute music' });
    musicMute.addEventListener('change', () => { s.musicMuted = musicMute.checked; commit(); });
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const row = (label: string, ...els: HTMLElement[]) => h('label', { class: 'set-row' }, h('span', null, label), h('span', { class: 'set-ctl' }, els));
    this.panel.replaceChildren(
      h('h2', null, 'Settings'),
      h('div', { class: 'settings-grid' },
        row('Aim with', aim),
        row('Stick deadzone', ...range('deadzone', 0.05, 0.5, 0.01, (v) => v.toFixed(2))),
        row('Sound effects', ...range('volume', 0, 1, 0.05, pct)),
        row('Music', ...range('musicVolume', 0, 1, 0.05, (v) => String(Math.round(v * 100)))),
        row('Mute music', musicMute),
        row('Screen shake', ...range('screenShake', 0, 1, 0.05, pct)),
        row('Show FPS / net', fps)),
      h('div', { class: 'modal-buttons' }, h('button', { class: 'btn btn-primary', 'data-nav': 's-done', onclick: () => this.close() }, 'Done')));
  }
}

const CONTROLS: [string, string, string][] = [
  ['Move (thrust)', 'W A S D', 'Left stick'],
  ['Aim', 'Mouse', 'Right stick'],
  ['Primary skill  (turret: offense)', 'Left mouse', 'RT'],
  ['Secondary skill  (turret: defense, hold)', 'Right mouse', 'RB'],
  ['Mobility skill', 'Space', 'A'],
  ['Utility skill', 'E', 'LB'],
  ['Afterburner', 'Shift', 'LT'],
  ['Attach as turret', 'F (teammate under cursor)', 'Y'],
  ['Detach / shake turrets', 'X', 'B'],
  ['Upgrade pick 1 / 2 / 3', '1 / 2 / 3', 'D-pad ◀ ▲ ▶'],
  ['Scoreboard (hold)', 'Tab', 'View / Back'],
  ['Big map', 'M', 'D-pad ▼'],
  ['Chat / team chat', 'Enter / T  (or //)', '—'],
  ['Menu', 'Esc', 'Start'],
  ['Controls', 'F1', '—'],
];

export class ControlsModal extends Modal {
  constructor() { super('controls-modal'); }
  protected build(): void {
    this.panel.replaceChildren(
      h('h2', null, 'Controls'),
      h('table', { class: 'table controls-table' },
        h('thead', null, h('tr', null, h('th', null, 'Action'), h('th', null, 'Mouse + keyboard'), h('th', null, 'Gamepad'))),
        h('tbody', null, CONTROLS.map(([a, k, p]) => h('tr', null, h('td', null, a), h('td', null, h('kbd', null, k)), h('td', null, h('kbd', null, p)))))),
      h('p', { class: 'muted small' }, 'Energy is health AND ammo: skills drain it, so does damage. Attach to a teammate to ride as a turret — your offense then burns the HOST’s energy. Pick your build path at level 3; level-up cards are picked live — the game never pauses.'),
      h('div', { class: 'modal-buttons' }, h('button', { class: 'btn btn-primary', 'data-nav': 'c-close', onclick: () => this.close() }, 'Close')));
  }
}

/** v0.3 Create Game (replaces Create Room): type-aware rows for the card's game type (§9 CLIENT M1). */
export class CreateGameModal extends Modal {
  private type: GameType = defaultCommandType();
  private draft: RoomSettings = createDefaults(this.type, '');
  private nameEdited = false;
  private head = h('div', { class: 'create-head' });
  private nameInput: HTMLInputElement | null = null;
  private form: GameSettingsForm;

  constructor(private onCreate: (s: RoomSettings) => void, private defaultName: (t: GameType) => string) {
    super('create-room');
    this.form = new GameSettingsForm({
      nav: 'cr', includeType: true,
      onChange: (patch) => {
        const prevType = this.draft.gameType;
        this.draft = normalizeDraft(this.draft, patch);
        if (this.draft.gameType !== prevType && !this.nameEdited) this.draft.name = this.defaultName(this.draft.gameType).slice(0, 32);
        this.sync();
      },
    });
  }

  /** Pick the game type the next open() starts from (the card's Create button). Returns this for openModal(). */
  openFor(t: GameType): this {
    this.type = t;
    return this;
  }

  protected build(): void {
    this.nameEdited = false;
    this.draft = createDefaults(this.type, this.defaultName(this.type));
    const name = h('input', { type: 'text', class: 'field', value: this.draft.name, maxlength: 32, 'data-nav': 'cr-name', 'data-autofocus': true });
    name.addEventListener('input', () => { this.nameEdited = true; this.draft.name = name.value; });
    const create = () => {
      const n = name.value.trim().slice(0, 32);
      this.onCreate({ ...this.draft, name: n || this.defaultName(this.draft.gameType).slice(0, 32) });
      this.close();
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
    this.nameInput = name;
    this.panel.replaceChildren(
      this.head,
      h('div', { class: 'settings-grid' }, h('label', { class: 'set-row' }, h('span', null, 'Name'), h('span', { class: 'set-ctl' }, name))),
      this.form.root,
      h('div', { class: 'modal-buttons' },
        h('button', { class: 'btn btn-ghost', 'data-nav': 'cr-cancel', onclick: () => this.close() }, 'Cancel'),
        h('button', { class: 'btn btn-primary', 'data-nav': 'cr-create', onclick: create }, 'Create')));
    this.sync();
  }

  private sync(): void {
    const t = this.draft.gameType;
    const T = GAME_TYPES[t];
    this.panel.style.setProperty('--accent', typeAccentCss(t));
    replaceChildren(this.head,
      h('h2', null, 'Create Game'),
      h('div', { class: 'create-type' },
        h('span', { class: 'gt-icon' }, T.icon), h('span', { class: 'strong' }, T.name),
        h('span', { class: 'badge kind' }, T.kind)),
      // v0.3 M4: a Dungeon Run states its floors, boss floors and the extraction rule.
      t === 'dungeon' ? h('div', { class: 'create-rules muted small' }, riftRulesLine(this.draft.floors)) : null);
    if (this.nameInput && !this.nameEdited) this.nameInput.value = this.draft.name;
    this.form.render(this.draft, false);
  }
}

/** A simple informational modal (title, lines, OK). */
export class NoticeModal extends Modal {
  constructor(cls: string, private title: string, private lines: () => string[]) { super(cls); }
  protected build(): void {
    this.panel.replaceChildren(
      h('h2', null, this.title),
      ...this.lines().map((l) => h('p', { class: 'notice-line' }, l)),
      h('div', { class: 'modal-buttons' }, h('button', { class: 'btn btn-primary', 'data-nav': 'notice-ok', 'data-autofocus': true, onclick: () => this.close() }, 'OK')));
  }
}

export class Toasts {
  readonly root = h('div', { class: 'toasts', 'aria-live': 'assertive' });
  show(text: string, kind: 'info' | 'error' = 'info', ms = 4000): void {
    const el = h('div', { class: `toast ${kind}` }, text);
    this.root.appendChild(el);
    while (this.root.childElementCount > 4) this.root.firstElementChild?.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, ms);
  }
}
