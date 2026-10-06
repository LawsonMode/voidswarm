// Chat Filter Case Study (docs/CHAT-FILTER-LAB.md): how a rule-based chat filter decides, where it is wrong, and the
// privacy trade-off of logging chat. Works anywhere (offline, online, command screen): it only runs the shared filter
// on fixed, harmless case lines. Student work: predictions, judgements, a quiz and a written report.
import { h, replaceChildren } from './dom';
import {
  FILTER_CASES, FILTER_QUESTIONS, FILTER_REPORT_MAX, FILTER_REPORT_MIN, FILTER_REPORT_PROMPT, JUDGEMENTS, OUTCOMES,
  filterReportText, quizScore, type CaseNote, type Outcome,
} from './filterLabInfo';
import { Modal } from './Overlays';

export interface FilterLabHooks {
  onQuiz?: (score: number) => void;
  onReport?: (text: string) => boolean;
  canSend?: () => boolean;
}

export class FilterLabModal extends Modal {
  private notes: CaseNote[] = FILTER_CASES.map((c) => ({ id: c.id, predicted: null, judgement: null }));
  private revealed = new Set<string>();
  private answers: (number | null)[] = FILTER_QUESTIONS.map(() => null);
  private score: number | null = null;
  private scoreReported = false;
  private analysis = '';
  private reportNote = '';

  constructor(private hooks: FilterLabHooks = {}) { super('filterlab-modal'); }

  protected build(): void {
    this.panel.replaceChildren(
      h('h2', null, 'Chat Filter Case Study'),
      h('p', { class: 'muted small' }, 'Voidswarm\'s chat filter is a rule-based program. Test your predictions against the real thing, then think about what it can and cannot do.'),
      this.howItWorks(), this.cases(), this.quiz(), this.report(),
      h('div', { class: 'modal-buttons' }, h('button', { class: 'btn', 'data-autofocus': true, onclick: () => this.close() }, 'Close')));
  }

  private howItWorks(): HTMLElement {
    return h('details', { open: true }, h('summary', null, '1 · How the filter works'),
      h('ul', { class: 'fl-facts' },
        h('li', null, 'Every chat line and every player name is checked, online and offline.'),
        h('li', null, 'It compares words to built-in lists. A listed word is starred (mask) or the whole line is withheld (block). Unlisted words pass.'),
        h('li', null, 'It matches whole words and keeps a list of clean words, so innocent text is not caught by accident.'),
        h('li', null, 'Strict is the classroom default. Standard lets the mildest words through.'),
        h('li', null, 'A server with accounts also logs chat lines for teachers (the original and what others saw), and deletes old lines after a retention period (90 days by default).'),
        h('li', null, 'Serious worries, like a student who may be in danger, always go to a human adult.')));
  }

  private cases(): HTMLElement {
    const box = h('details', null, h('summary', null, '2 · Predict the filter'));
    const draw = () => {
      const seen = this.revealed.size;
      let match = 0;
      for (const c of FILTER_CASES) { const n = this.notes.find((x) => x.id === c.id); if (this.revealed.has(c.id) && n?.predicted === c.strict) match++; }
      replaceChildren(box, h('summary', null, '2 · Predict the filter'),
        h('p', { class: 'muted small' }, 'For each message, predict what the strict filter does, then reveal the real result.'),
        FILTER_CASES.map((c) => this.caseCard(c, draw)),
        seen ? h('p', null, `You matched the filter on ${match} of ${seen} revealed.`) : null);
    };
    draw();
    return box;
  }

  private caseCard(c: (typeof FILTER_CASES)[number], redraw: () => void): HTMLElement {
    const n = this.notes.find((x) => x.id === c.id)!;
    const shown = this.revealed.has(c.id);
    const pick = h('select', { 'aria-label': `Prediction for: ${c.text}`, disabled: shown },
      h('option', { value: '' }, 'I predict…'), OUTCOMES.map((o) => h('option', { value: o }, o)));
    pick.value = n.predicted ?? '';
    pick.addEventListener('change', () => { n.predicted = (pick.value || null) as Outcome | null; redraw(); });
    const reveal = h('button', { class: 'btn', disabled: !n.predicted || shown }, 'Reveal');
    reveal.addEventListener('click', () => { this.revealed.add(c.id); redraw(); });
    const judge = h('select', { 'aria-label': `Your call on: ${c.text}` },
      h('option', { value: '' }, 'My call…'), JUDGEMENTS.map((j) => h('option', { value: j }, j)));
    judge.value = n.judgement ?? '';
    judge.addEventListener('change', () => { n.judgement = (judge.value || null) as CaseNote['judgement']; });
    return h('div', { class: 'fl-case' },
      h('div', { class: 'fl-msg' }, `"${c.text}"`),
      h('div', { class: 'fl-ctl' }, pick, reveal),
      shown ? h('div', { class: 'fl-result', role: 'status' },
        h('div', null, 'Strict: ', h('b', null, c.strict), n.predicted === c.strict ? ' ✓ you matched it' : ' (you predicted ' + n.predicted + ')',
          ' · Standard: ', h('b', null, c.standard)),
        h('p', { class: 'muted small' }, c.note),
        h('div', { class: 'fl-ctl' }, judge)) : null);
  }

  private quiz(): HTMLElement {
    const box = h('details', null, h('summary', null, '3 · Check your thinking'));
    const draw = () => {
      const done = this.score !== null;
      const qs = FILTER_QUESTIONS.map((q, i) => h('fieldset', { class: 'lablab-q' },
        h('legend', null, `${i + 1}. ${q.prompt}`),
        q.options.map((opt, j) => {
          const id = `fl-${q.id}-${j}`;
          const radio = h('input', { type: 'radio', name: `fl-${q.id}`, id, checked: this.answers[i] === j, disabled: done });
          radio.addEventListener('change', () => { this.answers[i] = j; });
          return h('label', { class: `lablab-opt${done && j === q.answer ? ' right' : ''}`, for: id }, radio, ` ${opt}`);
        }),
        done ? h('p', { class: 'muted small' }, (this.answers[i] === q.answer ? 'Correct. ' : 'Not quite. ') + q.why) : null));
      const submit = h('button', { class: 'btn btn-primary' }, 'Check my answers');
      submit.addEventListener('click', () => {
        this.score = quizScore(this.answers);
        if (!this.scoreReported) { this.scoreReported = true; this.hooks.onQuiz?.(this.score); }
        draw();
      });
      const retry = h('button', { class: 'btn' }, 'Try again (not re-scored)');
      retry.addEventListener('click', () => { this.score = null; this.answers = FILTER_QUESTIONS.map(() => null); draw(); });
      replaceChildren(box, h('summary', null, '3 · Check your thinking'), qs,
        done ? [h('p', null, `Score: ${Math.round((this.score ?? 0) * 100)}%`), retry] : submit);
    };
    draw();
    return box;
  }

  private report(): HTMLElement {
    const text = h('textarea', { rows: 8, maxlength: FILTER_REPORT_MAX, 'aria-label': 'Case study report', placeholder: 'Write in your own words…' });
    text.value = this.analysis;
    const note = h('p', { class: 'muted small', role: 'status' }, this.reportNote);
    const send = h('button', { class: 'btn btn-primary', disabled: true }, 'Submit report');
    const copy = h('button', { class: 'btn', disabled: true }, 'Copy report');
    const full = () => filterReportText(this.notes, text.value, this.score);
    const sync = () => {
      this.analysis = text.value;
      const ok = text.value.trim().length >= FILTER_REPORT_MIN;
      send.disabled = !ok || !this.hooks.canSend?.();
      copy.disabled = !ok;
    };
    text.addEventListener('input', sync);
    sync();
    send.addEventListener('click', () => {
      this.reportNote = (this.hooks.onReport?.(full()) ?? false) ? 'Report sent to your teacher.' : 'Could not send. Use Copy report instead.';
      note.textContent = this.reportNote;
    });
    copy.addEventListener('click', () => {
      navigator.clipboard?.writeText(full()).then(() => { note.textContent = 'Copied.'; }, () => { note.textContent = 'Copy is blocked here; select the text yourself.'; });
    });
    return h('details', null, h('summary', null, '4 · Case study report'),
      h('p', { class: 'small' }, FILTER_REPORT_PROMPT), text,
      h('div', { class: 'modal-buttons' }, copy, send),
      this.hooks.canSend?.() ? null : h('p', { class: 'muted small' }, 'Sign in through School sign-in in the menu to send it to your teacher.'),
      note);
  }
}
