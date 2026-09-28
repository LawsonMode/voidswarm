// Pure input mapping helpers (unit-tested). No DOM.

/** Standard-mapping gamepad button indices. */
export const PAD = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, LS: 10, RS: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
} as const;

export const TRIGGER_THRESHOLD = 0.3;
/** Aim point distance from the ship when aiming with a stick (full deflection / idle stick). */
export const STICK_AIM_DIST = 320;
/** Minimum stick aim distance when the right stick is deflected. */
export const STICK_AIM_MIN = 120;
/** InputState.aimDist range. */
export const AIM_DIST_MAX = 2000;

/** Gamepad aimDist: 320 × right-stick magnitude (after deadzone rescale), min 120; idle stick → 320. */
export function stickAimDist(rsMag: number): number {
  if (!(rsMag > 0)) return STICK_AIM_DIST;
  return Math.max(STICK_AIM_MIN, STICK_AIM_DIST * Math.min(1, rsMag));
}

/** Mouse aimDist: ship → cursor world distance, clamped to 0..AIM_DIST_MAX. */
export function mouseAimDist(dx: number, dy: number): number {
  const d = Math.hypot(dx, dy);
  return isFinite(d) ? Math.min(AIM_DIST_MAX, Math.max(0, d)) : STICK_AIM_DIST;
}

/** Radial deadzone with rescale: magnitude below dz maps to 0, dz..1 remaps to 0..1. */
export function radialDeadzone(x: number, y: number, dz: number): { x: number; y: number; mag: number } {
  const m = Math.hypot(x, y);
  if (!isFinite(m) || m <= dz || m === 0) return { x: 0, y: 0, mag: 0 };
  const scaled = Math.min(1, (m - dz) / (1 - dz));
  const k = scaled / m;
  return { x: x * k, y: y * k, mag: scaled };
}

/** WASD (plus arrow keys) -> world-relative move vector, magnitude <= 1. Keys are KeyboardEvent.code. */
export function keyboardMove(keys: ReadonlySet<string>): { x: number; y: number } {
  let x = 0, y = 0;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
  if (keys.has('KeyW') || keys.has('ArrowUp')) y -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) y += 1;
  const m = Math.hypot(x, y);
  return m > 1 ? { x: x / m, y: y / m } : { x, y };
}

export interface PadSnapshot {
  connected: boolean;
  /** pressed[] with analog triggers thresholded */
  pressed: boolean[];
  axes: number[];
}

export const EMPTY_PAD: PadSnapshot = { connected: false, pressed: [], axes: [0, 0, 0, 0] };

export interface PadGameplay {
  moveX: number; moveY: number;
  /** Aim angle, or null when neither stick gives a direction (keep last aim). */
  aim: number | null;
  /** True when the right stick is actively aiming. */
  aimStick: boolean;
  /** InputState.aimDist from the right stick (idle → STICK_AIM_DIST). */
  aimDist: number;
  /** RT — primary skill (as turret: offense). */
  primary: boolean;
  /** RB — secondary skill (as turret: defense, hold). */
  secondary: boolean;
  /** A — mobility skill. */
  mobility: boolean;
  /** LB — utility skill. */
  utility: boolean;
  afterburner: boolean; attach: boolean; detach: boolean;
}

/** Gamepad -> gameplay controls per the ARCHITECTURE §3 table. */
export function padGameplay(p: PadSnapshot, dz: number): PadGameplay {
  const b = (i: number) => !!p.pressed[i];
  const ls = radialDeadzone(p.axes[0] ?? 0, p.axes[1] ?? 0, dz);
  const rs = radialDeadzone(p.axes[2] ?? 0, p.axes[3] ?? 0, dz);
  let aim: number | null = null;
  const aimStick = rs.mag > 0;
  if (aimStick) aim = Math.atan2(rs.y, rs.x);
  else if (ls.mag > 0) aim = Math.atan2(ls.y, ls.x);
  return {
    moveX: ls.x, moveY: ls.y, aim, aimStick, aimDist: stickAimDist(rs.mag),
    primary: b(PAD.RT), secondary: b(PAD.RB), utility: b(PAD.LB), afterburner: b(PAD.LT),
    mobility: b(PAD.A), attach: b(PAD.Y), detach: b(PAD.B),
  };
}

/** Read a Gamepad into a plain snapshot (triggers thresholded). */
export function readGamepad(gp: Gamepad | null | undefined): PadSnapshot {
  if (!gp || !gp.connected) return EMPTY_PAD;
  const pressed: boolean[] = [];
  for (let i = 0; i < gp.buttons.length; i++) {
    const btn = gp.buttons[i];
    pressed.push(!!btn && (btn.pressed || btn.value > TRIGGER_THRESHOLD));
  }
  const axes: number[] = [];
  for (let i = 0; i < Math.max(4, gp.axes.length); i++) axes.push(gp.axes[i] ?? 0);
  return { connected: true, pressed, axes };
}

/** Did the pad show any deliberate activity (for last-active-device switching)? */
export function padActive(p: PadSnapshot, dz: number): boolean {
  if (!p.connected) return false;
  if (p.pressed.some(Boolean)) return true;
  return Math.hypot(p.axes[0] ?? 0, p.axes[1] ?? 0) > dz + 0.1 || Math.hypot(p.axes[2] ?? 0, p.axes[3] ?? 0) > dz + 0.1;
}

// ---------------------------------------------------------------------------------------------
// Keyboard routing (which keydowns become UI actions / get preventDefault'ed)
// ---------------------------------------------------------------------------------------------

export type UiAction =
  | 'upgrade1' | 'upgrade2' | 'upgrade3' | 'bigMap' | 'chat' | 'teamChat' | 'menu' | 'controls'
  | 'navUp' | 'navDown' | 'navLeft' | 'navRight' | 'confirm' | 'back' | 'spectateNext'
  /** v0.3 menus: gamepad LB / RB (keyboard [ / ] in a dialog) switch tabs (Hangar class tabs). */
  | 'tabPrev' | 'tabNext';

export interface KeyInfo {
  code: string;
  repeat: boolean;
  /** Focus is in a text field, select or contenteditable (it handles its own keys). */
  typing: boolean;
  /** A modal dialog (menu, settings, controls, create room) is open or holds focus. */
  modal: boolean;
  /** In a match (gameplay keys are captured). */
  inMatch: boolean;
  /** Gameplay input is live (no modal, chat or results). */
  gameplay: boolean;
  /** The focused element is a button (lobby Enter activates it natively). */
  onButton: boolean;
}

export interface KeyRoute {
  action: UiAction | null;
  /** Call preventDefault(). */
  prevent: boolean;
  /** Track the key as held (gameplay sampling). */
  hold: boolean;
  /** Tab is the scoreboard key (held). */
  scoreboard: boolean;
}

/**
 * Decide what a keydown does. Dialogs keep native keyboard behaviour even mid-match (Tab / Enter /
 * Space / arrows work on their buttons, sliders and selects), and Esc closes a dialog even when focus
 * is in one of its fields.
 */
export function routeKeyDown(k: KeyInfo): KeyRoute {
  const r: KeyRoute = { action: null, prevent: false, hold: false, scoreboard: false };
  if (k.code === 'F1') {
    r.prevent = true;
    if (!k.repeat) r.action = 'controls';
    return r;
  }
  if (k.code === 'Escape' && (k.modal || !k.typing)) {
    if (!k.repeat) r.action = 'menu';
    return r;
  }
  if (k.typing) return r; // chat / forms handle their own keys
  // v0.3 dialog tabs (the Hangar's class tabs): [ / ] do what LB / RB do on a pad.
  if (k.modal && (k.code === 'BracketLeft' || k.code === 'BracketRight')) {
    if (!k.repeat) r.action = k.code === 'BracketLeft' ? 'tabPrev' : 'tabNext';
    return r;
  }
  const match = k.inMatch && !k.modal;
  if (k.code === 'Tab') {
    if (match) { r.prevent = true; r.scoreboard = true; }
    return r;
  }
  r.hold = true;
  if (match) {
    if (k.code === 'Space' || k.code.startsWith('Arrow')) r.prevent = true;
    if (!k.repeat) {
      switch (k.code) {
        case 'Digit1': case 'Numpad1': r.action = 'upgrade1'; break;
        case 'Digit2': case 'Numpad2': r.action = 'upgrade2'; break;
        case 'Digit3': case 'Numpad3': r.action = 'upgrade3'; break;
        case 'KeyM': r.action = 'bigMap'; break;
        case 'Enter': case 'NumpadEnter': r.prevent = true; r.action = 'chat'; break;
        case 'KeyT': if (k.gameplay) { r.prevent = true; r.action = 'teamChat'; } break;
      }
    }
  } else if ((k.code === 'Enter' || k.code === 'NumpadEnter') && !k.repeat && !k.onButton) {
    // In lobbies / dialogs Enter on a focused button activates it natively; otherwise focus chat.
    r.action = 'chat';
  }
  return r;
}
