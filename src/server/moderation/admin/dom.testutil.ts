// OWNER: ADMIN UI (B9). A minimal DOM for the panel's tests (no jsdom in this tree): enough of Node / Element / Document
// to parse admin.html and display.html (our own well-formed markup) and boot admin.js / display.js under node, plus
// fake storage, fetch routing and a window. It is not a general DOM: only what the pages use.

// ------------------------------------------------------------------------------------------ events

export class FakeEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  target: FakeNode | null = null;
  currentTarget: FakeNode | FakeDocument | null = null;
  defaultPrevented = false;
  stopped = false;
  key?: string;
  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean; key?: string } = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? true;
    this.cancelable = init.cancelable ?? true;
    if (init.key !== undefined) this.key = init.key;
  }
  preventDefault(): void { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation(): void { this.stopped = true; }
}

type Listener = (e: FakeEvent) => unknown;

class Emitter {
  private readonly ls = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener): void {
    if (!this.ls.has(type)) this.ls.set(type, new Set());
    this.ls.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void { this.ls.get(type)?.delete(fn); }
  protected fire(e: FakeEvent): void {
    for (const fn of [...(this.ls.get(e.type) ?? [])]) fn.call(this, e);
  }
}

// ------------------------------------------------------------------------------------------ nodes

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

export class FakeNode extends Emitter {
  nodeType = 0;
  parentNode: FakeElement | null = null;
  constructor(readonly ownerDocument: FakeDocument) { super(); }
  get parentElement(): FakeElement | null { return this.parentNode; }
  get textContent(): string { return ''; }
  set textContent(_v: string) { /* overridden */ }
  remove(): void { this.parentNode?.removeChild(this); }
  get nextSibling(): FakeNode | null {
    const p = this.parentNode;
    if (!p) return null;
    const i = p.childNodes.indexOf(this);
    return p.childNodes[i + 1] ?? null;
  }
  get isConnected(): boolean {
    let n: FakeNode | null = this;
    while (n) { if (n === this.ownerDocument.documentElement) return true; n = n.parentNode; }
    return false;
  }
  dispatchEvent(e: FakeEvent): boolean {
    e.target = e.target ?? this;
    let n: FakeNode | null = this;
    while (n) {
      e.currentTarget = n;
      (n as FakeNode).fire(e);
      if (e.stopped || !e.bubbles) break;
      n = n.parentNode;
    }
    if (!e.stopped && e.bubbles && this.isConnected) { e.currentTarget = this.ownerDocument; this.ownerDocument.fireDoc(e); }
    return !e.defaultPrevented;
  }
}

export class FakeText extends FakeNode {
  override nodeType = 3;
  constructor(doc: FakeDocument, public data: string) { super(doc); }
  override get textContent(): string { return this.data; }
  override set textContent(v: string) { this.data = String(v); }
}

class ClassList {
  constructor(private readonly el: FakeElement) {}
  private list(): string[] { return (this.el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean); }
  private write(l: string[]): void { this.el.setAttribute('class', l.join(' ')); }
  contains(c: string): boolean { return this.list().includes(c); }
  add(...cs: string[]): void { const l = this.list(); for (const c of cs) if (!l.includes(c)) l.push(c); this.write(l); }
  remove(...cs: string[]): void { this.write(this.list().filter((c) => !cs.includes(c))); }
  toggle(c: string, force?: boolean): boolean {
    const on = force === undefined ? !this.contains(c) : force;
    if (on) this.add(c); else this.remove(c);
    return on;
  }
}

export class FakeElement extends FakeNode {
  override nodeType = 1;
  readonly tagName: string;
  readonly localName: string;
  readonly attrs = new Map<string, string>();
  childNodes: FakeNode[] = [];
  readonly classList = new ClassList(this);
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string>;
  private curValue: string | null = null;
  private curChecked: boolean | null = null;
  selectedFlag: boolean | null = null;
  open = false;
  width = 300;
  height = 150;
  href = '';
  download = '';

  constructor(doc: FakeDocument, tag: string) {
    super(doc);
    this.localName = tag.toLowerCase();
    this.tagName = tag.toUpperCase();
    const el = this;
    const toAttr = (k: string): string => `data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
    this.dataset = new Proxy({} as Record<string, string>, {
      get: (_t, k) => (typeof k === 'string' ? el.getAttribute(toAttr(k)) ?? undefined : undefined),
      set: (_t, k, v) => { if (typeof k === 'string') el.setAttribute(toAttr(k), String(v)); return true; },
      has: (_t, k) => typeof k === 'string' && el.hasAttribute(toAttr(k)),
    });
  }

  // attributes
  getAttribute(k: string): string | null { return this.attrs.has(k.toLowerCase()) ? this.attrs.get(k.toLowerCase())! : null; }
  setAttribute(k: string, v: string): void { this.attrs.set(k.toLowerCase(), String(v)); }
  removeAttribute(k: string): void { this.attrs.delete(k.toLowerCase()); }
  hasAttribute(k: string): boolean { return this.attrs.has(k.toLowerCase()); }
  toggleAttribute(k: string, force?: boolean): boolean {
    const on = force === undefined ? !this.hasAttribute(k) : force;
    if (on) this.setAttribute(k, ''); else this.removeAttribute(k);
    return on;
  }
  private boolAttr(k: string, v: boolean): void { if (v) this.setAttribute(k, ''); else this.removeAttribute(k); }

  get id(): string { return this.getAttribute('id') ?? ''; }
  set id(v: string) { this.setAttribute('id', v); }
  get className(): string { return this.getAttribute('class') ?? ''; }
  set className(v: string) { this.setAttribute('class', v); }
  get hidden(): boolean { return this.hasAttribute('hidden'); }
  set hidden(v: boolean) { this.boolAttr('hidden', !!v); }
  get disabled(): boolean { return this.hasAttribute('disabled'); }
  set disabled(v: boolean) { this.boolAttr('disabled', !!v); }
  get title(): string { return this.getAttribute('title') ?? ''; }
  set title(v: string) { this.setAttribute('title', v); }
  get type(): string { return this.getAttribute('type') ?? (this.localName === 'button' ? 'submit' : this.localName === 'input' ? 'text' : ''); }
  set type(v: string) { this.setAttribute('type', v); }
  get name(): string { return this.getAttribute('name') ?? ''; }
  get tabIndex(): number { return Number(this.getAttribute('tabindex') ?? 0); }
  set tabIndex(v: number) { this.setAttribute('tabindex', String(v)); }

  get checked(): boolean { return this.curChecked ?? this.hasAttribute('checked'); }
  set checked(v: boolean) {
    this.curChecked = !!v;
    if (v && this.type === 'radio' && this.name) {
      for (const other of this.ownerDocument.querySelectorAll(`input[name="${this.name}"]`)) if (other !== this) (other as FakeElement).curChecked = false;
    }
  }
  get selected(): boolean { return this.selectedFlag ?? this.hasAttribute('selected'); }
  set selected(v: boolean) { this.selectedFlag = !!v; }

  get options(): FakeElement[] { return this.localName === 'select' ? this.descendants().filter((e) => e.localName === 'option') : []; }
  get selectedIndex(): number {
    const o = this.options;
    if (!o.length) return -1;
    const i = o.findIndex((x) => x.selected);
    return i >= 0 ? i : 0;
  }
  get value(): string {
    if (this.localName === 'select') {
      const o = this.options[this.selectedIndex];
      return o ? o.value : '';
    }
    if (this.localName === 'option') return this.getAttribute('value') ?? this.textContent;
    return this.curValue ?? this.getAttribute('value') ?? '';
  }
  set value(v: string) {
    if (this.localName === 'select') {
      for (const o of this.options) o.selectedFlag = false;
      const hit = this.options.find((o) => o.value === String(v));
      if (hit) hit.selectedFlag = true;
      return;
    }
    this.curValue = String(v);
  }

  // tree
  get children(): FakeElement[] { return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement); }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): FakeNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get firstElementChild(): FakeElement | null { return this.children[0] ?? null; }
  get childElementCount(): number { return this.children.length; }
  private adopt(n: FakeNode): void {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
  }
  appendChild<T extends FakeNode>(n: T): T { this.adopt(n); this.childNodes.push(n); return n; }
  append(...ns: (FakeNode | string)[]): void { for (const n of ns) this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n); }
  prepend(...ns: (FakeNode | string)[]): void {
    const nodes = ns.map((n) => (typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n));
    for (const n of nodes) this.adopt(n);
    this.childNodes.unshift(...nodes);
  }
  insertBefore<T extends FakeNode>(n: T, ref: FakeNode | null): T {
    if (!ref) return this.appendChild(n);
    this.adopt(n);
    const i = this.childNodes.indexOf(ref);
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n);
    return n;
  }
  removeChild<T extends FakeNode>(n: T): T {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  replaceChildren(...ns: (FakeNode | string)[]): void {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...ns);
  }
  contains(n: FakeNode | null): boolean {
    for (let x: FakeNode | null = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  override get textContent(): string { return this.childNodes.map((c) => c.textContent).join(''); }
  override set textContent(v: string) {
    this.replaceChildren();
    if (v !== '' && v !== null && v !== undefined) this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
  descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (e: FakeElement): void => { for (const c of e.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelectorAll(sel: string): FakeElement[] { return matchAll(this.descendants(), sel); }
  querySelector(sel: string): FakeElement | null { return this.querySelectorAll(sel)[0] ?? null; }
  closest(sel: string): FakeElement | null {
    for (let e: FakeElement | null = this; e; e = e.parentNode) if (matches(e, sel)) return e;
    return null;
  }

  // behaviour
  focus(): void { this.ownerDocument.activeElement = this; }
  blur(): void { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  scrollIntoView(): void { /* no layout */ }
  click(): void {
    if (this.disabled) return;
    if (this.localName === 'input' && (this.type === 'checkbox' || this.type === 'radio')) {
      this.checked = this.type === 'radio' ? true : !this.checked;
    }
    const ok = this.dispatchEvent(new FakeEvent('click'));
    if (this.localName === 'input' && (this.type === 'checkbox' || this.type === 'radio')) this.dispatchEvent(new FakeEvent('change'));
    if (ok && this.localName === 'button' && this.type === 'submit') {
      const form = this.closest('form');
      if (form) form.dispatchEvent(new FakeEvent('submit'));
    }
  }
  showModal(): void { this.open = true; }
  show(): void { this.open = true; }
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new FakeEvent('close', { bubbles: false }));
  }
}

export class FakeDocument extends Emitter {
  readonly documentElement: FakeElement;
  head: FakeElement;
  body: FakeElement;
  activeElement: FakeElement | null = null;
  hidden = false;
  title = '';
  constructor() {
    super();
    this.documentElement = new FakeElement(this, 'html');
    this.head = new FakeElement(this, 'head');
    this.body = new FakeElement(this, 'body');
    this.documentElement.append(this.head, this.body);
  }
  createElement(tag: string): FakeElement { return new FakeElement(this, tag); }
  createTextNode(text: string): FakeText { return new FakeText(this, String(text)); }
  getElementById(id: string): FakeElement | null {
    for (const e of this.documentElement.descendants()) if (e.getAttribute('id') === id) return e;
    return null;
  }
  querySelectorAll(sel: string): FakeElement[] { return matchAll(this.documentElement.descendants(), sel); }
  querySelector(sel: string): FakeElement | null { return this.querySelectorAll(sel)[0] ?? null; }
  fireDoc(e: FakeEvent): void { this.fire(e); }
  dispatchEvent(e: FakeEvent): boolean { e.target = e.target ?? null; this.fire(e); return !e.defaultPrevented; }
}

// ------------------------------------------------------------------------------------------ selectors (simple)

interface Compound { tag: string | null; id: string | null; classes: string[]; attrs: { k: string; v: string | null }[] }

function parseCompound(s: string): Compound {
  const c: Compound = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([a-zA-Z][a-zA-Z0-9-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[1]) c.tag = m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ k: m[4].toLowerCase(), v: m[5] ?? null });
  }
  return c;
}
function matchesCompound(e: FakeElement, c: Compound): boolean {
  if (c.tag && e.localName !== c.tag) return false;
  if (c.id && e.getAttribute('id') !== c.id) return false;
  for (const cl of c.classes) if (!e.classList.contains(cl)) return false;
  for (const a of c.attrs) {
    if (!e.hasAttribute(a.k)) return false;
    if (a.v !== null && e.getAttribute(a.k) !== a.v) return false;
  }
  return true;
}
function matches(e: FakeElement, sel: string): boolean {
  return sel.split(',').some((group) => {
    const parts = group.trim().split(/\s+/).map(parseCompound);
    if (!parts.length || !matchesCompound(e, parts[parts.length - 1]!)) return false;
    let i = parts.length - 2;
    for (let a = e.parentNode; a && i >= 0; a = a.parentNode) if (matchesCompound(a, parts[i]!)) i--;
    return i < 0;
  });
}
function matchAll(list: FakeElement[], sel: string): FakeElement[] { return list.filter((e) => matches(e, sel)); }

// ------------------------------------------------------------------------------------------ HTML

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', middot: '·' };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Parse our own well-formed page markup into a FakeDocument (head and body children; comments dropped). */
export function parseHtml(html: string): FakeDocument {
  const doc = new FakeDocument();
  const root = doc.createElement('#root');
  const stack: FakeElement[] = [root];
  const top = (): FakeElement => stack[stack.length - 1]!;
  let i = 0;
  const attrRe = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) { const e = html.indexOf('-->', i + 4); i = e < 0 ? html.length : e + 3; continue; }
    if (html.startsWith('<!', i)) { const e = html.indexOf('>', i); i = e < 0 ? html.length : e + 1; continue; }
    if (html[i] === '<' && html[i + 1] === '/') {
      const e = html.indexOf('>', i);
      const name = html.slice(i + 2, e).trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) if (stack[k]!.localName === name) { stack.length = k; break; }
      i = e + 1;
      continue;
    }
    if (html[i] === '<' && /[a-zA-Z]/.test(html[i + 1] ?? '')) {
      const e = html.indexOf('>', i);
      let inner = html.slice(i + 1, e);
      const selfClose = inner.endsWith('/');
      if (selfClose) inner = inner.slice(0, -1);
      const name = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(inner)![0].toLowerCase();
      const el = doc.createElement(name);
      attrRe.lastIndex = name.length;
      let m: RegExpExecArray | null;
      const rest = inner.slice(name.length);
      attrRe.lastIndex = 0;
      while ((m = attrRe.exec(rest))) el.setAttribute(m[1]!, decode(m[2] ?? m[3] ?? m[4] ?? ''));
      top().appendChild(el);
      i = e + 1;
      if (name === 'script' || name === 'style') {
        const close = html.toLowerCase().indexOf(`</${name}>`, i);
        const body = html.slice(i, close < 0 ? html.length : close);
        if (body) el.appendChild(doc.createTextNode(body));
        i = close < 0 ? html.length : close + name.length + 3;
        continue;
      }
      if (!VOID.has(name) && !selfClose) stack.push(el);
      continue;
    }
    const next = html.indexOf('<', i);
    const text = html.slice(i, next < 0 ? html.length : next);
    if (text.trim()) top().appendChild(doc.createTextNode(decode(text)));
    else if (text && top().localName !== '#root' && top().localName !== 'html' && top().localName !== 'head') top().appendChild(doc.createTextNode(' '));
    i = next < 0 ? html.length : next;
  }
  // Graft <head> / <body> contents into the document's own.
  const html0 = root.children.find((c) => c.localName === 'html') ?? root;
  for (const part of html0.children) {
    if (part.localName === 'head') doc.head.append(...part.childNodes.slice());
    else if (part.localName === 'body') {
      for (const [k, v] of part.attrs) doc.body.setAttribute(k, v);
      doc.body.append(...part.childNodes.slice());
    }
  }
  return doc;
}

// ------------------------------------------------------------------------------------------ window pieces

export interface FakeStorage { data: Map<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
export function fakeStorage(init: Record<string, string> = {}): FakeStorage {
  const data = new Map(Object.entries(init));
  return { data, getItem: (k) => (data.has(k) ? data.get(k)! : null), setItem: (k, v) => void data.set(k, String(v)), removeItem: (k) => void data.delete(k) };
}

export interface FetchCall { url: string; endpoint: string; body: Record<string, unknown>; headers: Record<string, string>; signal?: AbortSignal }
export interface FakeReply { status?: number; body?: unknown; headers?: Record<string, string>; blob?: unknown }
/** A route: a reply, or a function of the call (may return a promise: a long-poll that hangs until the test resolves it). */
export type Route = FakeReply | ((c: FetchCall) => FakeReply | Promise<FakeReply>);

/** A fetch that answers POST /api/admin/<endpoint> (and /api/login, /api/logout) from `routes`; records every call. */
export function fakeFetch(routes: Record<string, Route>) {
  const calls: FetchCall[] = [];
  const fn = async (url: string, init: { body?: string; headers?: Record<string, string>; signal?: AbortSignal }): Promise<unknown> => {
    const endpoint = url.startsWith('/api/admin/') ? url.slice('/api/admin/'.length) : url;
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(init.body ?? '{}') as Record<string, unknown>; } catch { /* not JSON */ }
    const call: FetchCall = { url, endpoint, body, headers: init.headers ?? {}, signal: init.signal };
    calls.push(call);
    const route = routes[endpoint] ?? routes[url];
    if (!route) return reply({ status: 404, body: { error: 'Not found' } });
    const pending = Promise.resolve(typeof route === 'function' ? route(call) : route);
    const aborted = new Promise<never>((_, reject) => {
      if (!init.signal) return;
      const fail = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (init.signal.aborted) fail(); else init.signal.addEventListener('abort', fail, { once: true });
    });
    return reply(await Promise.race([pending, aborted]));
  };
  const reply = (r: FakeReply) => {
    const status = r.status ?? 200;
    const headers = { 'content-type': r.blob !== undefined ? 'text/csv' : 'application/json', ...Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) };
    return {
      ok: status >= 200 && status < 300, status,
      headers: { get: (k: string) => headers[k.toLowerCase() as keyof typeof headers] ?? null },
      json: async () => { if (r.body === undefined) throw new SyntaxError('no json'); return JSON.parse(JSON.stringify(r.body)); },
      blob: async () => r.blob,
    };
  };
  return { fn, calls, of: (endpoint: string) => calls.filter((c) => c.endpoint === endpoint) };
}

export interface FakeWin {
  fetch: (url: string, init: never) => Promise<unknown>;
  sessionStorage: FakeStorage;
  localStorage: FakeStorage;
  location: { hash: string; pathname: string; search: string; host: string; origin: string };
  history: { replaced: string[]; replaceState(_s: unknown, _t: string, url: string): void };
  AbortController: typeof AbortController;
  URL: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void };
  navigator: Record<string, unknown>;
  opened: string[];
  open(url: string): null;
  console: { warn(...a: unknown[]): void; error(...a: unknown[]): void };
  isSecureContext: boolean;
}

export function fakeWindow(o: { fetch: (url: string, init: never) => Promise<unknown>; session?: Record<string, string>; local?: Record<string, string>; hash?: string }): FakeWin {
  const w: FakeWin = {
    fetch: o.fetch,
    sessionStorage: fakeStorage(o.session),
    localStorage: fakeStorage(o.local),
    location: { hash: o.hash ?? '', pathname: '/', search: '', host: 'localhost:7778', origin: 'http://localhost:7778' },
    history: { replaced: [], replaceState(_s, _t, url) { w.history.replaced.push(url); w.location.hash = ''; } },
    AbortController,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => undefined },
    navigator: {},
    opened: [],
    open(url) { w.opened.push(url); return null; },
    console: { warn: () => undefined, error: () => undefined },
    isSecureContext: true,
  };
  return w;
}

/** Let pending promise chains run (several macrotask turns). */
export async function settle(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Everything a person or a screen reader could get from the page: text plus attribute values (title, aria-*, value). */
export function pageText(doc: FakeDocument): string {
  const parts: string[] = [];
  const walk = (n: FakeNode): void => {
    if (n instanceof FakeText) { parts.push(n.data); return; }
    if (n instanceof FakeElement) {
      if (n.localName === 'script' || n.localName === 'style') return;
      for (const [k, v] of n.attrs) if (k !== 'class' && k !== 'id') parts.push(v);
      for (const c of n.childNodes) walk(c);
    }
  };
  walk(doc.documentElement);
  return parts.join(' ');
}
