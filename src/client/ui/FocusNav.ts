// Gamepad-driven spatial focus navigation for DOM menus.

const FOCUSABLE = 'button:not([disabled]), [data-nav]:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

function visible(el: HTMLElement): boolean {
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => visible(el) && !el.closest('[inert]'));
}

export type NavDir = 'up' | 'down' | 'left' | 'right';

/** Move focus within `root` in a direction; picks the nearest candidate in that half-plane. */
export function moveFocus(root: HTMLElement, dir: NavDir): void {
  const list = focusables(root);
  if (!list.length) return;
  const cur = document.activeElement as HTMLElement | null;
  if (!cur || !root.contains(cur) || !list.includes(cur)) {
    list[0].focus();
    return;
  }
  // Sliders / selects consume left/right.
  if ((dir === 'left' || dir === 'right') && adjustControl(cur, dir === 'right' ? 1 : -1)) return;

  const cr = cur.getBoundingClientRect();
  const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
  let best: HTMLElement | null = null, bestScore = Infinity;
  for (const el of list) {
    if (el === cur) continue;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const dx = x - cx, dy = y - cy;
    let primary: number, secondary: number;
    switch (dir) {
      case 'up': primary = -dy; secondary = Math.abs(dx); break;
      case 'down': primary = dy; secondary = Math.abs(dx); break;
      case 'left': primary = -dx; secondary = Math.abs(dy); break;
      default: primary = dx; secondary = Math.abs(dy); break;
    }
    if (primary <= 2) continue;
    const score = primary + secondary * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) {
    best.focus();
    best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function adjustControl(el: HTMLElement, delta: number): boolean {
  if (el instanceof HTMLSelectElement) {
    const n = el.options.length;
    if (!n) return false;
    el.selectedIndex = Math.max(0, Math.min(n - 1, el.selectedIndex + delta));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (el instanceof HTMLInputElement && (el.type === 'range' || el.type === 'number')) {
    if (delta > 0) el.stepUp(); else el.stepDown();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}

/** Gamepad A: click buttons, toggle checkboxes, focus text fields. */
export function activateFocused(root: HTMLElement): void {
  const el = document.activeElement as HTMLElement | null;
  if (!el || !root.contains(el)) {
    focusables(root)[0]?.focus();
    return;
  }
  if (el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'url')) {
    el.select();
    return;
  }
  el.click();
}
