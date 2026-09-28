// Unified keyboard/mouse + gamepad input. Produces InputState for the fixed-rate loop plus discrete UI actions.
import type { InputState } from '../../shared/types';
import type { ClientSettings } from '../settings';
import {
  EMPTY_PAD, keyboardMove, mouseAimDist, PAD, padActive, padGameplay, readGamepad, routeKeyDown, STICK_AIM_DIST,
  type PadSnapshot, type UiAction,
} from './mapping';

export type { UiAction } from './mapping';

export type Device = 'kbm' | 'pad';

export interface AimContext {
  /** Local ship position (world px) or null when not piloting. */
  shipX: number; shipY: number; hasShip: boolean;
  screenToWorld(sx: number, sy: number): { x: number; y: number };
}

export interface SampledInput {
  input: Omit<InputState, 'seq'>;
  aimX: number;
  aimY: number;
}

const NAV_REPEAT_DELAY = 380;
const NAV_REPEAT_RATE = 140;

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) {
    const ty = t.type;
    return ty !== 'button' && ty !== 'checkbox' && ty !== 'radio' && ty !== 'range' && ty !== 'submit';
  }
  return false;
}

export class InputManager {
  device: Device = 'kbm';
  /** True while in a match with no menu open and not typing: gameplay input is live. */
  gameplayEnabled = false;
  /** True while in a match (affects which keys get preventDefault). */
  inMatch = false;
  /** A modal dialog is open: its buttons / sliders / selects keep native keyboard behaviour. */
  modalOpen = false;

  onAction: ((a: UiAction, device: Device) => void) | null = null;
  onDeviceChange: ((d: Device) => void) | null = null;

  private keys = new Set<string>();
  private lmb = false;
  private rmb = false;
  private mouseX = -1;
  private mouseY = -1;
  private hasMouse = false;
  private tabHeld = false;
  private pad: PadSnapshot = EMPTY_PAD;
  private prevPad: PadSnapshot = EMPTY_PAD;
  private lastAim = 0;
  /** Last InputState.aimDist (ship → aim point, px). */
  private lastAimDist = STICK_AIM_DIST;
  private navDir: UiAction | null = null;
  private navNext = 0;
  private host: HTMLElement | null = null;
  private padApi = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';

  constructor(private settings: () => ClientSettings) {}

  attach(host: HTMLElement): void {
    this.host = host;
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    window.addEventListener('keyup', this.onKeyUp, { capture: true });
    window.addEventListener('blur', this.clearAll);
    window.addEventListener('pointermove', this.onPointerMove, { passive: true });
    window.addEventListener('mouseup', this.onMouseUp);
    host.addEventListener('mousedown', this.onMouseDown);
    host.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('gamepadconnected', () => { /* polled each frame */ });
  }

  get scoreboardHeld(): boolean {
    return this.tabHeld || (!!this.pad.pressed[PAD.BACK] && this.pad.connected);
  }

  get padConnected(): boolean { return this.pad.connected; }

  private setDevice(d: Device): void {
    if (this.device === d) return;
    this.device = d;
    this.onDeviceChange?.(d);
  }

  private emit(a: UiAction, d: Device): void {
    this.onAction?.(a, d);
  }

  private clearAll = (): void => {
    this.keys.clear();
    this.lmb = this.rmb = false;
    this.tabHeld = false;
  };

  /** Drop held gameplay keys (e.g. when chat opens) so nothing sticks. */
  releaseAll(): void { this.clearAll(); }

  private onKeyDown = (e: KeyboardEvent): void => {
    this.setDevice('kbm');
    const t = e.target;
    const r = routeKeyDown({
      code: e.code, repeat: e.repeat,
      typing: isTypingTarget(t),
      modal: this.modalOpen || (t instanceof Element && !!t.closest('.overlay.modal')),
      inMatch: this.inMatch,
      gameplay: this.gameplayEnabled,
      onButton: document.activeElement instanceof HTMLButtonElement,
    });
    if (r.prevent) e.preventDefault();
    if (r.scoreboard) this.tabHeld = true;
    if (r.hold) this.keys.add(e.code);
    if (r.action) this.emit(r.action, 'kbm');
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
    if (e.code === 'Tab') this.tabHeld = false;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { this.keys.delete('ShiftLeft'); this.keys.delete('ShiftRight'); }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' || e.pointerType === 'pen' || !e.pointerType) {
      const r = this.host?.getBoundingClientRect();
      const nx = e.clientX - (r?.left ?? 0), ny = e.clientY - (r?.top ?? 0);
      if (this.hasMouse && Math.hypot(nx - this.mouseX, ny - this.mouseY) > 3) this.setDevice('kbm');
      this.mouseX = nx;
      this.mouseY = ny;
      this.hasMouse = true;
    }
  };

  private onMouseDown = (e: MouseEvent): void => {
    this.setDevice('kbm');
    if (e.button === 0) { this.lmb = true; if (this.inMatch) this.emit('spectateNext', 'kbm'); }
    else if (e.button === 2) this.rmb = true;
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.lmb = false;
    else if (e.button === 2) this.rmb = false;
  };

  /** Poll the gamepad (call once per animation frame) and emit edge-triggered UI actions. */
  poll(nowMs: number): void {
    let gp: Gamepad | null = null;
    if (this.padApi) {
      try {
        const pads = navigator.getGamepads();
        for (const p of pads) {
          if (p && p.connected) { gp = p; break; }
        }
      } catch { gp = null; }
    }
    this.prevPad = this.pad;
    this.pad = readGamepad(gp);
    const dz = this.settings().deadzone;
    if (padActive(this.pad, dz)) this.setDevice('pad');
    if (!this.pad.connected) { this.navDir = null; return; }

    const edge = (i: number) => !!this.pad.pressed[i] && !this.prevPad.pressed[i];
    if (edge(PAD.START)) this.emit('menu', 'pad');

    if (this.gameplayEnabled) {
      this.navDir = null;
      if (edge(PAD.LEFT)) this.emit('upgrade1', 'pad');
      if (edge(PAD.UP)) this.emit('upgrade2', 'pad');
      if (edge(PAD.RIGHT)) this.emit('upgrade3', 'pad');
      if (edge(PAD.DOWN)) this.emit('bigMap', 'pad');
      if (edge(PAD.A)) this.emit('spectateNext', 'pad');
      return;
    }

    // Menu navigation: D-pad / left stick with key-repeat, A = confirm, B = back.
    if (edge(PAD.A)) this.emit('confirm', 'pad');
    if (edge(PAD.B)) this.emit('back', 'pad');
    if (edge(PAD.LB)) this.emit('tabPrev', 'pad');
    if (edge(PAD.RB)) this.emit('tabNext', 'pad');
    let dir: UiAction | null = null;
    const ax = this.pad.axes[0] ?? 0, ay = this.pad.axes[1] ?? 0;
    if (this.pad.pressed[PAD.UP] || ay < -0.6) dir = 'navUp';
    else if (this.pad.pressed[PAD.DOWN] || ay > 0.6) dir = 'navDown';
    else if (this.pad.pressed[PAD.LEFT] || ax < -0.6) dir = 'navLeft';
    else if (this.pad.pressed[PAD.RIGHT] || ax > 0.6) dir = 'navRight';
    if (!dir) { this.navDir = null; return; }
    if (dir !== this.navDir) {
      this.navDir = dir;
      this.navNext = nowMs + NAV_REPEAT_DELAY;
      this.emit(dir, 'pad');
    } else if (nowMs >= this.navNext) {
      this.navNext = nowMs + NAV_REPEAT_RATE;
      this.emit(dir, 'pad');
    }
  }

  /** Sample the current gameplay input. Neutral (aim kept) when gameplay is disabled. */
  sample(ctx: AimContext): SampledInput {
    const st = this.settings();
    const neutral: Omit<InputState, 'seq'> = {
      moveX: 0, moveY: 0, aim: this.lastAim, aimDist: this.lastAimDist, primary: false, secondary: false, mobility: false, utility: false,
      afterburner: false, attach: false, attachTarget: 0, detach: false,
    };
    if (!this.gameplayEnabled || isTypingTarget(document.activeElement)) {
      return {
        input: neutral,
        aimX: ctx.shipX + Math.cos(this.lastAim) * this.lastAimDist,
        aimY: ctx.shipY + Math.sin(this.lastAim) * this.lastAimDist,
      };
    }
    const pg = this.pad.connected ? padGameplay(this.pad, st.deadzone) : null;
    const km = keyboardMove(this.keys);
    let moveX = km.x, moveY = km.y;
    if (pg && (pg.moveX !== 0 || pg.moveY !== 0)) { moveX = pg.moveX; moveY = pg.moveY; }

    const useMouse = st.aimMode === 'mouse' || !pg || (st.aimMode === 'auto' && this.device === 'kbm');
    let aimX: number, aimY: number;
    if (useMouse && this.hasMouse) {
      const w = ctx.screenToWorld(this.mouseX, this.mouseY);
      aimX = w.x; aimY = w.y;
      if (ctx.hasShip) {
        const dx = aimX - ctx.shipX, dy = aimY - ctx.shipY;
        if (dx * dx + dy * dy > 1) this.lastAim = Math.atan2(dy, dx);
        this.lastAimDist = mouseAimDist(dx, dy);
      }
    } else {
      if (pg && pg.aim !== null) this.lastAim = pg.aim;
      this.lastAimDist = pg ? pg.aimDist : STICK_AIM_DIST;
      aimX = ctx.shipX + Math.cos(this.lastAim) * this.lastAimDist;
      aimY = ctx.shipY + Math.sin(this.lastAim) * this.lastAimDist;
    }

    const k = this.keys;
    const input: Omit<InputState, 'seq'> = {
      moveX, moveY, aim: this.lastAim, aimDist: this.lastAimDist,
      // As a turret the same buttons drive the turret kit (LMB offense, RMB defense) — the sim decides.
      primary: this.lmb || !!pg?.primary,
      secondary: this.rmb || !!pg?.secondary,
      mobility: k.has('Space') || !!pg?.mobility,
      utility: k.has('KeyE') || !!pg?.utility,
      afterburner: k.has('ShiftLeft') || k.has('ShiftRight') || !!pg?.afterburner,
      attach: k.has('KeyF') || !!pg?.attach,
      attachTarget: 0,
      detach: k.has('KeyX') || !!pg?.detach,
    };
    return { input, aimX, aimY };
  }
}
