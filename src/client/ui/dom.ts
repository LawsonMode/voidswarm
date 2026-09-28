// Tiny framework-free DOM helpers.
import { NO_TEAM } from '../../shared/constants';
import { colorFor, hexToCss } from '../../shared/data/teams';
import type { PlayerId, TeamId } from '../../shared/types';

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, props?: Props | null, ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: (Child | Child[])[]): void {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c === null || c === undefined || c === false) continue;
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Replace children; keeps focus on the element with the same data-nav key when it is re-rendered. */
export function replaceChildren(el: Element, ...children: (Child | Child[])[]): void {
  const ae = document.activeElement as HTMLElement | null;
  const key = ae && el.contains(ae) ? ae.getAttribute('data-nav') : null;
  clear(el);
  append(el, children);
  if (key) {
    const again = el.querySelector<HTMLElement>(`[data-nav="${CSS.escape(key)}"]`);
    again?.focus({ preventScroll: true });
  }
}

const textCache = new WeakMap<Node, string>();
/** Set textContent only when it changes (cheap per-frame HUD updates). */
export function setText(el: HTMLElement, s: string): void {
  if (textCache.get(el) === s) return;
  textCache.set(el, s);
  el.textContent = s;
}

const styleCache = new WeakMap<HTMLElement, Map<string, string>>();
export function setStyle(el: HTMLElement, prop: string, v: string): void {
  let m = styleCache.get(el);
  if (!m) { m = new Map(); styleCache.set(el, m); }
  if (m.get(prop) === v) return;
  m.set(prop, v);
  el.style.setProperty(prop, v);
}

export function toggleClass(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

export function teamCss(team: TeamId, playerId: PlayerId): string {
  return hexToCss(colorFor(team < 0 && team !== NO_TEAM ? NO_TEAM : team, playerId));
}

export function fmtClock(sec: number): string {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function fmtTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

/** Glyph pair: shows the keyboard label or the gamepad label depending on the active device (CSS). */
export function glyph(kbm: string, pad: string): HTMLElement {
  return h('span', { class: 'glyph' },
    h('kbd', { class: 'kbm-only' }, kbm),
    h('kbd', { class: 'pad-only' }, pad));
}
