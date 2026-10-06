// School sign-in (Quark) modal: sign in / out, the after-action note, and Quark's class chat. Plus the blocking notice
// shown while a teacher has limited this student. Only reachable when a Quark hub is present (quark.ts).
import { AFTER_ACTION_MAX, AFTER_ACTION_MIN, type QuarkLink } from '../quark';
import { h } from './dom';
import { Modal } from './Overlays';

export const AFTER_ACTION_PROMPT =
  'After-action note: how did you and your squad work together and talk to each other? What would you do differently to be a good teammate online?';

export class QuarkModal extends Modal {
  private unmountChat: (() => void) | null = null;
  private sent = false;
  private error = '';

  constructor(private quark: QuarkLink) {
    super('quark-modal');
    quark.onChange(() => { if (this.visible) this.build(); });
  }

  override close(): void {
    this.unmountChat?.();
    this.unmountChat = null;
    super.close();
  }

  protected build(): void {
    this.unmountChat?.();
    this.unmountChat = null;
    const q = this.quark;
    const body: (HTMLElement | null)[] = [h('h2', null, 'School sign-in')];
    if (q.notice) body.push(h('p', { class: 'muted', role: 'status' }, q.notice));
    if (this.error) body.push(h('p', { class: 'form-error', role: 'alert' }, this.error));
    if (!q.user) {
      body.push(
        h('p', { class: 'muted' }, 'Sign in with your school account. Your teacher can then see your after-action notes, and you can use the class chat. Playing never needs it.'),
        h('div', { class: 'modal-buttons' },
          h('button', {
            class: 'btn btn-primary', 'data-autofocus': true,
            onclick: () => { this.error = ''; q.signIn().catch((e: { code?: string }) => { this.error = e?.code === 'login_cancelled' ? '' : `Sign-in didn't finish (${e?.code ?? 'error'}).`; this.build(); }); },
          }, 'Sign in'),
          h('button', { class: 'btn', onclick: () => this.close() }, 'Close')));
    } else {
      const note = h('textarea', { rows: 5, maxlength: AFTER_ACTION_MAX, 'aria-label': 'After-action note', placeholder: 'Write in your own words…' });
      const send = h('button', { class: 'btn btn-primary', disabled: true }, 'Send to my teacher');
      const count = h('span', { class: 'muted small' }, `at least ${AFTER_ACTION_MIN} characters`);
      note.addEventListener('input', () => { send.disabled = note.value.trim().length < AFTER_ACTION_MIN; });
      send.addEventListener('click', () => {
        if (!q.submitAfterAction(note.value)) return;
        this.sent = true;
        this.build();
      });
      const chat = h('div', { class: 'quark-chat' });
      body.push(
        h('p', null, 'Signed in as ', h('strong', null, q.user.name)),
        this.sent
          ? h('p', { class: 'muted', role: 'status' }, 'Note sent to your teacher. You can write another any time.')
          : null,
        h('label', { class: 'set-row' }, h('span', null, AFTER_ACTION_PROMPT)),
        note, count,
        h('div', { class: 'modal-buttons' },
          send,
          h('button', { class: 'btn', onclick: () => { this.sent = false; q.signOut().catch(() => {}); } }, 'Sign out'),
          h('button', { class: 'btn', 'data-autofocus': true, onclick: () => this.close() }, 'Close')),
        h('h3', null, 'Class chat'), chat);
      this.panel.replaceChildren(...body.filter((x): x is HTMLElement => !!x));
      this.unmountChat = q.mountChat(chat);
      return;
    }
    this.panel.replaceChildren(...body.filter((x): x is HTMLElement => !!x));
  }
}

/** Full-screen notice while a teacher's limit is on (the server enforces it; this just stops play and says why). */
export class QuarkLimitNotice {
  readonly root = h('div', { class: 'overlay modal quark-limit hidden', role: 'alertdialog', 'aria-live': 'assertive' });
  constructor(private quark: QuarkLink) {
    quark.onChange(() => this.sync());
  }
  private sync(): void {
    const l = this.quark.limit;
    const show = this.quark.blocked && !!l;
    this.root.classList.toggle('hidden', !show);
    if (!show || !l) { this.root.replaceChildren(); return; }
    const until = l.until == null ? '' : new Date(l.until).toLocaleTimeString();
    this.root.replaceChildren(h('div', { class: 'panel overlay-panel' },
      h('h2', null, 'Paused by your teacher'),
      h('p', null, l.message),
      until && until !== 'Invalid Date' ? h('p', { class: 'muted' }, `Until ${until}`) : null));
  }
}
