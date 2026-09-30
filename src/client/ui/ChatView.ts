// Reusable chat log + input (zone lobby, room lobby, in-match overlay).
import { CHAT_MAX_LEN } from '../../shared/constants';
import type { ChatLine } from '../../shared/protocol';
import { chatNoticeText } from '../net/serverInfo';
import { fmtTime, h, teamCss } from './dom';

export interface ChatViewOpts {
  placeholder: string;
  channelToggle: boolean;
  /** Overlay mode: lines fade out after a while unless the input is open. */
  fading: boolean;
  onSend(channel: 'all' | 'team', text: string): void;
  onNameClick?(name: string): void;
  /** Called when the input gains/loses focus (for gameplay input suppression). */
  onFocusChange?(focused: boolean): void;
  onCancel?(): void;
  maxLines?: number;
}

const FADE_MS = 9000;

export class ChatView {
  readonly root: HTMLElement;
  readonly log: HTMLElement;
  readonly input: HTMLInputElement;
  /**
   * LAN edition §4.15 / §8.2: who can read this chat and for how long (GET /api/info → notice), pinned above the log.
   * Hidden while there is none (offline play, an older server).
   */
  readonly notice: HTMLElement;
  private channelBtn: HTMLButtonElement | null = null;
  channel: 'all' | 'team' = 'all';

  constructor(private opts: ChatViewOpts) {
    this.log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite' });
    this.notice = h('div', { class: 'chat-notice hidden', role: 'note' });
    this.input = h('input', {
      class: 'chat-input', type: 'text', maxlength: CHAT_MAX_LEN, placeholder: opts.placeholder,
      autocomplete: 'off', spellcheck: 'false', 'data-nav': 'chat-input',
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const text = this.input.value.trim();
        this.input.value = '';
        if (text) this.opts.onSend(this.channel, text);
        if (this.opts.fading) this.input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.input.value = '';
        this.input.blur();
        this.opts.onCancel?.();
      } else if (e.key === 'Tab' && this.opts.channelToggle) {
        e.preventDefault();
        this.setChannel(this.channel === 'all' ? 'team' : 'all');
      }
      e.stopPropagation();
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
    this.input.addEventListener('focus', () => { this.root.classList.add('open'); this.opts.onFocusChange?.(true); });
    this.input.addEventListener('blur', () => { this.root.classList.remove('open'); this.opts.onFocusChange?.(false); });

    const row: HTMLElement[] = [];
    if (opts.channelToggle) {
      this.channelBtn = h('button', {
        class: 'chat-channel', type: 'button', title: 'Toggle all / team chat (Tab while typing)',
        // Don't steal focus from the input: in-match the row is only clickable while chat is open.
        onmousedown: (e: MouseEvent) => e.preventDefault(),
        onclick: () => this.setChannel(this.channel === 'all' ? 'team' : 'all'),
      }, 'ALL');
      row.push(this.channelBtn);
    }
    row.push(this.input);
    this.root = h('div', { class: `chat${opts.fading ? ' chat-fading' : ''}` }, this.notice, this.log, h('div', { class: 'chat-row' }, row));
  }

  /** The server's chat notice ('' hides the line). Plain text only: the server's words are never parsed as HTML. */
  setNotice(notice: string): void {
    const t = chatNoticeText(notice);
    this.notice.textContent = t;
    this.notice.title = t;
    this.notice.classList.toggle('hidden', !t);
  }

  setChannel(c: 'all' | 'team'): void {
    this.channel = c;
    if (this.channelBtn) {
      this.channelBtn.textContent = c === 'team' ? 'TEAM' : 'ALL';
      this.channelBtn.classList.toggle('team', c === 'team');
    }
    this.input.placeholder = c === 'team' ? 'Team chat…' : this.opts.placeholder;
  }

  open(channel: 'all' | 'team'): void {
    this.setChannel(channel);
    this.input.focus();
  }

  get isOpen(): boolean { return document.activeElement === this.input; }

  setLines(lines: readonly ChatLine[]): void {
    this.log.textContent = '';
    const max = this.opts.maxLines ?? 100;
    for (const l of lines.slice(-max)) this.log.appendChild(this.lineEl(l, true));
    this.log.scrollTop = this.log.scrollHeight;
  }

  add(line: ChatLine): void {
    const nearBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 60;
    this.log.appendChild(this.lineEl(line, false));
    const max = this.opts.maxLines ?? 100;
    while (this.log.childElementCount > max) this.log.firstElementChild?.remove();
    if (nearBottom || this.opts.fading) this.log.scrollTop = this.log.scrollHeight;
  }

  private lineEl(l: ChatLine, old: boolean): HTMLElement {
    const cls = ['chat-line', `ch-${l.channel}`];
    const el = h('div', { class: cls.join(' ') },
      h('span', { class: 'chat-time' }, fmtTime(l.time)),
      l.channel === 'team' ? h('span', { class: 'chat-tag' }, '[TEAM]') : null,
      l.channel === 'system'
        ? h('span', { class: 'chat-sys' }, '◆ ')
        : h('span', {
          class: 'chat-name', style: `color:${teamCss(l.team, l.fromPlayerId)}`,
          onclick: () => this.opts.onNameClick?.(l.fromName),
        }, l.fromName, ':'),
      h('span', { class: 'chat-text' }, ' ', l.text));
    if (this.opts.fading) {
      if (old) el.classList.add('faded');
      else setTimeout(() => el.classList.add('faded'), FADE_MS);
    }
    return el;
  }
}
