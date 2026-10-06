// Lag Lab panel (docs/LAG-LAB.md): a docked panel (not a modal, so the match keeps running while you change the network)
// with the network conditions, live measurements, a trial notebook, a predict-and-check quiz and a lab report.
// Works in offline play only: that is where the game can make the network worse on purpose.
import { LAG_LIMITS, NO_LAG, type LagSettings } from '../net/lagModel';
import type { GameClient } from '../net/GameClient';
import { h, replaceChildren } from './dom';
import {
  FEEL_OPTIONS, LAG_QUESTIONS, MAX_TRIALS, REPORT_MAX, REPORT_MIN, REPORT_PROMPT, quizScore, reportText, trialLine,
  type Feel, type LagTrial,
} from './lagLabInfo';

export interface LagLabHooks {
  /** First quiz submit: score 0..1 (reported to Quark when it is connected). */
  onQuiz?: (score: number) => void;
  /** Lab report submitted: the full text. Returns true when it was sent to a teacher. */
  onReport?: (text: string) => boolean;
  /** True while a school sign-in is active (the report can be sent). */
  canSend?: () => boolean;
}

const READOUT_MS = 250;

export class LagLabPanel {
  readonly root = h('div', { class: 'lablab hidden', role: 'region', 'aria-label': 'Lag Lab' });
  visible = false;
  private body = h('div', { class: 'lablab-body' });
  private readouts: Record<'ping' | 'jitter' | 'buffer' | 'stalls' | 'status', HTMLElement> = {
    ping: h('b', null, '–'), jitter: h('b', null, '–'), buffer: h('b', null, '–'), stalls: h('b', null, '–'), status: h('span', { class: 'muted' }),
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private trials: LagTrial[] = [];
  private answers: (number | null)[] = LAG_QUESTIONS.map(() => null);
  private score: number | null = null;
  private scoreReported = false;
  private reportNote = '';
  private feel: Feel = 'Instant';

  constructor(private client: GameClient, private hooks: LagLabHooks = {}, private onUi: (n: string) => void = () => {}) {
    this.root.append(
      h('div', { class: 'lablab-head' }, h('h2', null, 'Lag Lab'),
        h('button', { class: 'btn', onclick: () => this.hide(), 'aria-label': 'Close Lag Lab' }, '×')),
      this.body);
  }

  toggle(): void { if (this.visible) this.hide(); else this.show(); }

  show(): void {
    this.visible = true;
    this.root.classList.remove('hidden');
    this.build();
    this.timer ??= setInterval(() => this.tick(), READOUT_MS);
    this.tick();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.classList.add('hidden');
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.onUi('click');
  }

  /** Reset the conditions (and prediction) to normal, e.g. when a new offline session starts. */
  resetConditions(): void {
    this.client.lagTransport?.setLag({ ...NO_LAG });
    this.client.predictionEnabled = true;
    if (this.visible) this.build();
  }

  private get transport() { return this.client.lagTransport; }

  private tick(): void {
    const t = this.transport;
    const r = this.readouts;
    if (!t) { r.status.textContent = 'Lag Lab needs offline play: choose "Play offline" on the title screen.'; return; }
    r.status.textContent = '';
    const playing = this.client.matchActive;
    r.ping.textContent = this.client.pingMs ? `${this.client.pingMs} ms` : '–';
    r.jitter.textContent = playing ? `${Math.round(this.client.netJitterMs)} ms` : '–';
    r.buffer.textContent = playing ? `${Math.round(this.client.interpDelayMs)} ms` : '–';
    r.stalls.textContent = String(t.lagStalls);
  }

  private build(): void {
    const t = this.transport;
    const lag: LagSettings = t ? { ...t.lag } : { ...NO_LAG };
    const slider = (key: keyof LagSettings, label: string, unit: string, hint: string) => {
      const lim = LAG_LIMITS[key];
      const out = h('output', { class: 'range-out' }, `${lag[key]}${unit}`);
      const inp = h('input', { type: 'range', min: lim.min, max: lim.max, step: lim.step, value: String(lag[key]), disabled: !t, 'aria-label': label });
      inp.addEventListener('input', () => { out.textContent = `${inp.value}${unit}`; this.transport?.setLag({ [key]: Number(inp.value) }); });
      // Arrow keys on a focused slider would also steer the ship: hand focus back as soon as the drag ends.
      inp.addEventListener('change', () => inp.blur());
      return h('label', { class: 'set-row' }, h('span', null, label, h('span', { class: 'muted small lablab-hint' }, hint)), h('span', { class: 'set-ctl' }, inp, out));
    };
    const pred = h('input', { type: 'checkbox', checked: this.client.predictionEnabled, disabled: !t, 'aria-label': 'Prediction' });
    pred.addEventListener('change', () => { this.client.predictionEnabled = pred.checked; pred.blur(); });
    const feel = h('select', { 'aria-label': 'How did it feel?' }, FEEL_OPTIONS.map((f) => h('option', { value: f }, f)));
    feel.value = this.feel;
    feel.addEventListener('change', () => { this.feel = feel.value as Feel; feel.blur(); });

    const trialRows = h('ol', { class: 'lablab-trials' });
    const drawTrials = () => replaceChildren(trialRows, this.trials.length
      ? this.trials.map((tr) => h('li', null, trialLine(tr)))
      : h('li', { class: 'muted' }, 'No trials yet: set the conditions, play a few seconds, then record.'));
    drawTrials();
    const record = h('button', { class: 'btn', disabled: !t }, 'Record this trial');
    record.addEventListener('click', () => {
      const tr = this.transport;
      if (!tr) return;
      if (this.trials.length >= MAX_TRIALS) { this.trials.shift(); }
      this.trials.push({
        settings: { ...tr.lag }, prediction: this.client.predictionEnabled, pingMs: this.client.pingMs,
        jitterMs: this.client.netJitterMs, interpMs: this.client.interpDelayMs, stalls: tr.lagStalls, feel: this.feel,
      });
      drawTrials();
      record.blur();
    });

    this.body.replaceChildren(
      h('p', { class: 'muted small' }, 'Make the network worse on purpose, keep playing, and watch what changes. Offline play only.'),
      this.readouts.status,
      h('details', { open: true }, h('summary', null, '1 · Conditions'),
        slider('rttMs', 'Added ping', ' ms', 'round trip, split between each direction'),
        slider('jitterMs', 'Jitter', ' ms', 'random extra delay per message'),
        slider('lossPct', 'Packet loss', '%', 'on TCP a loss means a re-send and a stall'),
        h('label', { class: 'set-row' }, h('span', null, 'Prediction', h('span', { class: 'muted small lablab-hint' }, 'your ship moves before the server answers')), h('span', { class: 'set-ctl' }, pred)),
        h('button', { class: 'btn', disabled: !t, onclick: () => this.resetConditions() }, 'Back to normal')),
      h('div', { class: 'lablab-read' },
        h('span', null, 'Ping ', this.readouts.ping), h('span', null, 'Jitter ', this.readouts.jitter),
        h('span', null, 'Buffer ', this.readouts.buffer), h('span', null, 'Stalls ', this.readouts.stalls)),
      h('details', null, h('summary', null, '2 · Notebook'),
        h('label', { class: 'set-row' }, h('span', null, 'How did your ship feel?'), h('span', { class: 'set-ctl' }, feel)),
        record, trialRows,
        h('button', { class: 'btn', onclick: () => { this.trials = []; drawTrials(); } }, 'Clear trials')),
      this.buildQuiz(),
      this.buildReport());
    this.tick();
  }

  private buildQuiz(): HTMLElement {
    const box = h('details', null, h('summary', null, '3 · Predict and check'));
    const draw = () => {
      const done = this.score !== null;
      const qs = LAG_QUESTIONS.map((q, i) => h('fieldset', { class: 'lablab-q' },
        h('legend', null, `${i + 1}. ${q.prompt}`),
        q.options.map((opt, j) => {
          const id = `lablab-${q.id}-${j}`;
          const radio = h('input', { type: 'radio', name: `lablab-${q.id}`, id, checked: this.answers[i] === j, disabled: done });
          radio.addEventListener('change', () => { this.answers[i] = j; radio.blur(); });
          const right = done && j === q.answer;
          return h('label', { class: `lablab-opt${right ? ' right' : ''}`, for: id }, radio, ` ${opt}`);
        }),
        done ? h('p', { class: 'muted small' }, (this.answers[i] === q.answer ? 'Correct. ' : 'Not quite. ') + q.why) : null));
      const submit = h('button', { class: 'btn btn-primary' }, 'Check my answers');
      submit.addEventListener('click', () => {
        this.score = quizScore(this.answers);
        if (!this.scoreReported) { this.scoreReported = true; this.hooks.onQuiz?.(this.score); }
        draw();
      });
      const retry = h('button', { class: 'btn' }, 'Try again (not re-scored)');
      retry.addEventListener('click', () => { this.score = null; this.answers = LAG_QUESTIONS.map(() => null); draw(); });
      replaceChildren(box, h('summary', null, '3 · Predict and check'), qs,
        done ? [h('p', null, `Score: ${Math.round((this.score ?? 0) * 100)}%`), retry] : submit);
    };
    draw();
    return box;
  }

  private buildReport(): HTMLElement {
    const text = h('textarea', { rows: 6, maxlength: REPORT_MAX, 'aria-label': 'Lab report', placeholder: 'Write in your own words…' });
    const note = h('p', { class: 'muted small', role: 'status' }, this.reportNote);
    const send = h('button', { class: 'btn btn-primary', disabled: true }, 'Submit report');
    const copy = h('button', { class: 'btn', disabled: true }, 'Copy report');
    const full = () => reportText(this.trials, text.value, this.score);
    text.addEventListener('input', () => {
      const ok = text.value.trim().length >= REPORT_MIN;
      send.disabled = !ok || !this.hooks.canSend?.();
      copy.disabled = !ok;
    });
    send.addEventListener('click', () => {
      const ok = this.hooks.onReport?.(full()) ?? false;
      this.reportNote = ok ? 'Report sent to your teacher.' : 'Could not send. Use Copy report instead.';
      note.textContent = this.reportNote;
    });
    copy.addEventListener('click', () => {
      navigator.clipboard?.writeText(full()).then(() => { note.textContent = 'Copied.'; }, () => { note.textContent = 'Copy is blocked here; select the text yourself.'; });
    });
    return h('details', null, h('summary', null, '4 · Lab report'),
      h('p', { class: 'small' }, REPORT_PROMPT), text,
      h('div', { class: 'modal-buttons' }, copy, send),
      this.hooks.canSend?.() ? null : h('p', { class: 'muted small' }, 'Sign in through School sign-in in the menu to send it to your teacher.'),
      note);
  }
}
