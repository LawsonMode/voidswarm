// Shrink-to-fit for one-line labels that end in a long value (a server host). The text first shrinks toward
// FIT_MIN_SCALE of its CSS font size until it fits its box. Only past that does it end in an ellipsis, which comes
// from the element's own CSS (overflow: hidden; text-overflow: ellipsis; white-space: nowrap).
// Used by the title screen's "Stay on / Connect to <host>" buttons and its "Server: <host>…" link.

/** Class that marks an element for fitTextIn. */
export const FIT_CLASS = 'fit-text';
/** Smallest font scale a fitted label shrinks to before it ellipsizes (below this a host gets hard to read)... */
export const FIT_MIN_SCALE = 0.62;
/** ...and never below this many CSS px. */
export const FIT_MIN_PX = 8.5;

/**
 * Font scale that makes a line `textW` px wide fit a box `boxW` px wide: 1 when it already fits, never below `min`.
 * A 1 px margin keeps sub-pixel rounding from turning a fitted line into an ellipsis.
 */
export function fitScale(textW: number, boxW: number, min = FIT_MIN_SCALE): number {
  if (!(textW > 0) || !(boxW > 0) || textW <= boxW) return 1;
  const k = Math.floor(((boxW - 1) / textW) * 1000) / 1000;
  return Math.max(min, Math.min(1, k));
}

/** The scale floor for a label whose CSS font size is `basePx`: FIT_MIN_SCALE, or FIT_MIN_PX if that is larger. */
export function fitFloor(basePx: number, min = FIT_MIN_SCALE, minPx = FIT_MIN_PX): number {
  return basePx > 0 ? Math.min(1, Math.max(min, minPx / basePx)) : min;
}

/** Fit one element (after layout). A box that is not laid out (a hidden screen) is left alone until it shows. */
export function fitText(el: HTMLElement, min = FIT_MIN_SCALE): void {
  el.style.fontSize = '';
  const box = el.clientWidth;
  if (box <= 0) return;
  const text = el.scrollWidth;
  if (text <= box) return;
  const base = parseFloat(getComputedStyle(el).fontSize);
  if (!(base > 0)) return;
  const k = fitScale(text, box, fitFloor(base, min));
  if (k < 1) el.style.fontSize = `${(base * k).toFixed(2)}px`;
}

/** Fit every FIT_CLASS element under `root`. Call it after render, on resize and once the fonts have loaded. */
export function fitTextIn(root: ParentNode, min = FIT_MIN_SCALE): void {
  for (const el of root.querySelectorAll<HTMLElement>(`.${FIT_CLASS}`)) fitText(el, min);
}
