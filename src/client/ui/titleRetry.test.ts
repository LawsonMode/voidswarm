// T-CL-6 (LAN edition §3.7): the Title's auto-reconnect line is updated every second. The announced part (the notice
// and "Reconnecting…", inside a polite live region) must be written only when it changes: replacing its text node
// with the same words each second can make a screen reader read it again. Only the aria-hidden countdown ticks.
import { describe, expect, it } from 'vitest';
import { HOST_LOST_TEXT, retryStatusParts } from '../net/reconnect';
import { TitleScreen } from './TitleScreen';

/** Just enough of an element for setRetryStatus: counts textContent writes, tracks classes. */
function fakeEl() {
  let text = '';
  const classes = new Set<string>();
  const el = {
    writes: 0,
    classes,
    get textContent(): string { return text; },
    set textContent(v: string) { text = v; el.writes++; },
    classList: { toggle(c: string, on: boolean): boolean { if (on) classes.add(c); else classes.delete(c); return on; } },
  };
  return el;
}

describe('T-CL-6: the Title retry line', () => {
  it('rewrites the announced text only when it changes; the countdown ticks on its own', () => {
    const view = { retryText: fakeEl(), retryCount: fakeEl(), retryLine: fakeEl() };
    const set = (text: string, countdown?: string, error?: boolean) =>
      TitleScreen.prototype.setRetryStatus.call(view as unknown as TitleScreen, text, countdown, error);

    for (let left = 60; left >= 45; left--) {
      const p = retryStatusParts(HOST_LOST_TEXT, left);
      set(p.text, p.countdown);
    }
    expect(view.retryText.textContent).toBe(`${HOST_LOST_TEXT} · Reconnecting…`);
    expect(view.retryText.writes).toBe(1);
    expect(view.retryCount.textContent).toBe(' 45 s');
    expect(view.retryCount.writes).toBe(16);
    expect(view.retryLine.classes.has('hidden')).toBe(false);
    expect(view.retryLine.classes.has('error')).toBe(false);

    // gave up: the bare notice, once, as an error; the countdown goes
    set(HOST_LOST_TEXT, '', true);
    set(HOST_LOST_TEXT, '', true);
    expect(view.retryText.textContent).toBe(HOST_LOST_TEXT);
    expect(view.retryText.writes).toBe(2);
    expect(view.retryCount.textContent).toBe('');
    expect(view.retryLine.classes.has('error')).toBe(true);

    // connected / stopped: hidden
    set('');
    expect(view.retryText.textContent).toBe('');
    expect(view.retryLine.classes.has('hidden')).toBe(true);
    expect(view.retryLine.classes.has('error')).toBe(false);
  });
});
