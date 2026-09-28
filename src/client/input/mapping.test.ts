import { describe, expect, it } from 'vitest';
import {
  AIM_DIST_MAX, keyboardMove, mouseAimDist, PAD, padActive, padGameplay, radialDeadzone, routeKeyDown, STICK_AIM_DIST,
  STICK_AIM_MIN, stickAimDist, type KeyInfo, type PadSnapshot,
} from './mapping';
import { sanitizeSettings } from '../settings';

const pad = (axes: number[], pressedIdx: number[] = []): PadSnapshot => {
  const pressed: boolean[] = new Array(17).fill(false);
  for (const i of pressedIdx) pressed[i] = true;
  return { connected: true, pressed, axes };
};

describe('radialDeadzone', () => {
  it('zeroes inside the deadzone', () => {
    expect(radialDeadzone(0.1, 0.1, 0.25).mag).toBe(0);
  });
  it('rescales dz..1 to 0..1 preserving direction', () => {
    const r = radialDeadzone(0.625, 0, 0.25);
    expect(r.mag).toBeCloseTo(0.5);
    expect(r.x).toBeCloseTo(0.5);
    expect(r.y).toBeCloseTo(0);
    const full = radialDeadzone(1, 1, 0.25);
    expect(full.mag).toBe(1);
    expect(Math.hypot(full.x, full.y)).toBeCloseTo(1);
  });
});

describe('keyboardMove', () => {
  it('normalizes diagonals', () => {
    const m = keyboardMove(new Set(['KeyW', 'KeyD']));
    expect(Math.hypot(m.x, m.y)).toBeCloseTo(1);
    expect(m.x).toBeGreaterThan(0);
    expect(m.y).toBeLessThan(0); // up is -y
  });
  it('cancels opposites', () => {
    expect(keyboardMove(new Set(['KeyA', 'KeyD']))).toEqual({ x: 0, y: 0 });
  });
});

describe('padGameplay', () => {
  it('maps buttons per the v0.2 controls table', () => {
    const g = padGameplay(pad([0, 0, 0, 0], [PAD.RT, PAD.RB, PAD.LB, PAD.LT, PAD.A, PAD.Y, PAD.B]), 0.25);
    expect(g).toMatchObject({ primary: true, secondary: true, utility: true, afterburner: true, mobility: true, attach: true, detach: true });
    const one = (i: number) => padGameplay(pad([0, 0, 0, 0], [i]), 0.25);
    expect(one(PAD.RT)).toMatchObject({ primary: true, secondary: false, mobility: false, utility: false });
    expect(one(PAD.RB)).toMatchObject({ primary: false, secondary: true });
    expect(one(PAD.A)).toMatchObject({ mobility: true, utility: false });
    expect(one(PAD.LB)).toMatchObject({ utility: true, mobility: false });
  });
  it('aims with RS, falls back to move direction, else null', () => {
    const rs = padGameplay(pad([0, 0, 0, 1]), 0.25);
    expect(rs.aim).toBeCloseTo(Math.PI / 2);
    expect(rs.aimStick).toBe(true);
    const mv = padGameplay(pad([-1, 0, 0.1, 0.1]), 0.25);
    expect(mv.aim).toBeCloseTo(Math.PI);
    expect(mv.aimStick).toBe(false);
    expect(mv.moveX).toBeCloseTo(-1);
    expect(padGameplay(pad([0, 0, 0, 0]), 0.25).aim).toBeNull();
  });
  it('derives aimDist from right-stick magnitude (min 120, idle 320)', () => {
    expect(padGameplay(pad([0, 0, 1, 0]), 0.25).aimDist).toBeCloseTo(STICK_AIM_DIST);
    expect(padGameplay(pad([0, 0, 0.625, 0]), 0.25).aimDist).toBeCloseTo(160); // mag 0.5 after rescale
    expect(padGameplay(pad([0, 0, 0.3, 0]), 0.25).aimDist).toBe(STICK_AIM_MIN); // tiny deflection floors at 120
    expect(padGameplay(pad([0, 0, 0, 0]), 0.25).aimDist).toBe(STICK_AIM_DIST); // idle
    expect(stickAimDist(0)).toBe(320);
    expect(stickAimDist(0.1)).toBe(120);
    expect(stickAimDist(2)).toBe(320);
  });

  it('clamps mouse aimDist to 0..2000', () => {
    expect(mouseAimDist(300, 400)).toBeCloseTo(500);
    expect(mouseAimDist(5000, 0)).toBe(AIM_DIST_MAX);
    expect(mouseAimDist(0, 0)).toBe(0);
    expect(mouseAimDist(NaN, 0)).toBe(STICK_AIM_DIST);
  });

  it('detects activity for device switching', () => {
    expect(padActive(pad([0.05, 0, 0, 0]), 0.25)).toBe(false);
    expect(padActive(pad([0.9, 0, 0, 0]), 0.25)).toBe(true);
    expect(padActive(pad([0, 0, 0, 0], [PAD.START]), 0.25)).toBe(true);
  });
});

describe('settings', () => {
  it('sanitizes out-of-range values', () => {
    const s = sanitizeSettings({ deadzone: 9, volume: -1, aimMode: 'bogus' as never });
    expect(s.deadzone).toBe(0.5);
    expect(s.volume).toBe(0);
    expect(s.aimMode).toBe('auto');
  });
});

describe('routeKeyDown (F6 / F7: dialogs keep the keyboard)', () => {
  const key = (code: string, o: Partial<KeyInfo> = {}): KeyInfo => ({
    code, repeat: false, typing: false, modal: false, inMatch: false, gameplay: false, onButton: false, ...o,
  });
  const match = { inMatch: true, gameplay: true };

  it('Esc closes a dialog even when focus is in its select / text field', () => {
    expect(routeKeyDown(key('Escape', { typing: true, modal: true })).action).toBe('menu'); // Settings: Aim-with select
    expect(routeKeyDown(key('Escape', { typing: true, modal: true, inMatch: true })).action).toBe('menu');
    // the chat input (not a dialog) handles its own Esc
    expect(routeKeyDown(key('Escape', { typing: true })).action).toBeNull();
    expect(routeKeyDown(key('Escape')).action).toBe('menu');
    expect(routeKeyDown(key('Escape', { repeat: true })).action).toBeNull();
  });

  it('mid-match with a dialog open, Tab / Enter / Space / arrows stay native', () => {
    const inDialog = { inMatch: true, gameplay: false, modal: true };
    for (const code of ['Tab', 'Space', 'ArrowLeft', 'ArrowDown']) {
      const r = routeKeyDown(key(code, inDialog));
      expect(r.prevent, code).toBe(false);
      expect(r.scoreboard, code).toBe(false);
    }
    const enter = routeKeyDown(key('Enter', { ...inDialog, onButton: true }));
    expect(enter).toMatchObject({ prevent: false, action: null }); // activates the focused button natively
    expect(routeKeyDown(key('Digit1', inDialog)).action).toBeNull();
  });

  it('in a match without a dialog, gameplay keys are still captured', () => {
    expect(routeKeyDown(key('Tab', match))).toMatchObject({ prevent: true, scoreboard: true, hold: false });
    expect(routeKeyDown(key('Space', match))).toMatchObject({ prevent: true, hold: true });
    expect(routeKeyDown(key('Enter', match))).toMatchObject({ prevent: true, action: 'chat' });
    expect(routeKeyDown(key('Digit2', match)).action).toBe('upgrade2');
    expect(routeKeyDown(key('Digit2', { ...match, repeat: true })).action).toBeNull();
    expect(routeKeyDown(key('KeyT', match)).action).toBe('teamChat');
    expect(routeKeyDown(key('KeyT', { inMatch: true, gameplay: false })).action).toBeNull();
    expect(routeKeyDown(key('KeyW', { ...match, typing: true })).hold).toBe(false); // typing in chat
  });

  it('in a dialog, [ / ] switch tabs like LB / RB (the Hangar class tabs); never while typing or outside a dialog', () => {
    expect(routeKeyDown(key('BracketLeft', { modal: true })).action).toBe('tabPrev');
    expect(routeKeyDown(key('BracketRight', { modal: true, inMatch: true })).action).toBe('tabNext');
    expect(routeKeyDown(key('BracketRight', { modal: true, repeat: true })).action).toBeNull();
    expect(routeKeyDown(key('BracketRight', { modal: true, typing: true })).action).toBeNull();
    expect(routeKeyDown(key('BracketLeft')).action).toBeNull();
  });

  it('lobby Enter focuses chat unless a button has focus; F1 always opens controls', () => {
    expect(routeKeyDown(key('Enter')).action).toBe('chat');
    expect(routeKeyDown(key('Enter', { onButton: true })).action).toBeNull();
    expect(routeKeyDown(key('F1', { typing: true, modal: true }))).toMatchObject({ prevent: true, action: 'controls' });
    expect(routeKeyDown(key('Tab')).prevent).toBe(false);
  });
});
