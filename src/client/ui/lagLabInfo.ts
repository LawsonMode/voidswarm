// Lag Lab content (docs/LAG-LAB.md): the predict-and-check questions, the trial notebook rows and the lab report text.
// Pure data and helpers (no DOM) so they are unit tested. Student-facing wording is PG.
import type { LagSettings } from '../net/lagModel';

export interface LagQuestion {
  id: string;
  prompt: string;
  options: string[];
  /** Index into options. */
  answer: number;
  why: string;
}

export const LAG_QUESTIONS: readonly LagQuestion[] = [
  {
    id: 'predict-on',
    prompt: 'Your round trip is 300 ms and prediction is ON. You press a thrust key. When does your own ship start to move on your screen?',
    options: ['Right away: your computer moves it first and checks with the server later', 'After about 300 ms, once the server answers'],
    answer: 0,
    why: 'Prediction means your computer runs your own ship\'s movement immediately, then corrects it when the server\'s answer arrives.',
  },
  {
    id: 'predict-off',
    prompt: 'Now prediction is OFF with the same 300 ms round trip. When does your own ship start to move?',
    options: ['Right away', 'After about one round trip: the input has to reach the server and the answer has to come back'],
    answer: 1,
    why: 'Without prediction nothing moves until the server\'s snapshot returns. That is the round trip: there plus back.',
  },
  {
    id: 'jitter',
    prompt: 'Jitter is high (messages arrive at uneven times). The game draws other pilots a little in the past. Why?',
    options: ['To hide a bug', 'A short buffer lets it smooth out uneven arrivals, at the cost of seeing slightly old positions'],
    answer: 1,
    why: 'Interpolation needs two snapshots to draw between. Holding a small buffer keeps motion smooth, and more jitter needs a bigger buffer, so what you see gets older.',
  },
  {
    id: 'loss',
    prompt: 'A WebSocket runs on TCP. A message is lost on the way. What do you see?',
    options: ['That one update is skipped and the rest keep arriving on time', 'A stall: later messages wait for the lost one to be re-sent, then everything arrives in a burst'],
    answer: 1,
    why: 'TCP delivers everything in order, so one missing packet holds up the ones behind it (head-of-line blocking).',
  },
];

/** Fraction right, 0..1, over all questions (an unanswered question counts as wrong). */
export function quizScore(answers: readonly (number | null)[], qs: readonly LagQuestion[] = LAG_QUESTIONS): number {
  if (!qs.length) return 0;
  let right = 0;
  qs.forEach((q, i) => { if (answers[i] === q.answer) right++; });
  return right / qs.length;
}

export const FEEL_OPTIONS = ['Instant', 'Slight delay', 'Laggy', 'Hard to play'] as const;
export type Feel = (typeof FEEL_OPTIONS)[number];

export interface LagTrial {
  settings: LagSettings;
  prediction: boolean;
  /** Measured by the game, not typed in. */
  pingMs: number;
  jitterMs: number;
  interpMs: number;
  stalls: number;
  feel: Feel;
}
export const MAX_TRIALS = 8;

/** One notebook line, e.g. `+200 ms ping, 40 ms jitter, 5% loss, prediction ON: measured 215 ms ping, 18 ms jitter; felt Laggy`. */
export function trialLine(t: LagTrial): string {
  const s = t.settings;
  return `+${Math.round(s.rttMs)} ms ping, ${Math.round(s.jitterMs)} ms jitter, ${Math.round(s.lossPct)}% loss, prediction ${t.prediction ? 'ON' : 'OFF'}: `
    + `measured ${Math.round(t.pingMs)} ms ping, ${Math.round(t.jitterMs)} ms jitter, ${Math.round(t.interpMs)} ms buffer, ${t.stalls} stalls; felt ${t.feel}`;
}

export const REPORT_MIN = 60;
export const REPORT_MAX = 3000;
export const REPORT_PROMPT =
  'Lab report: using your trials, explain what ping, jitter and loss each did to the game and how you could tell. Why does prediction help? Use the words "round trip" and "buffer".';

/** The text sent to the teacher (or copied): the student's trial notebook plus their own explanation. Never includes a name. */
export function reportText(trials: readonly LagTrial[], explanation: string, score: number | null): string {
  const lines = trials.map((t, i) => `${i + 1}. ${trialLine(t)}`);
  const head = score === null ? 'Quiz: not taken' : `Quiz: ${Math.round(score * 100)}%`;
  return `${head}\nTrials:\n${lines.join('\n') || '(none)'}\n\nExplanation:\n${explanation.trim().slice(0, REPORT_MAX)}`;
}
