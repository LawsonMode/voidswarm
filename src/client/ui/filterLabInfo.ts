// Chat Filter Case Study content (docs/CHAT-FILTER-LAB.md): the case lines, the predict-and-check questions and the
// report text. Pure (no DOM) so it is unit tested. The case outcomes are computed by the REAL filter, never typed in,
// and filterLabInfo.test.ts pins them, so a change to the word lists that alters a case fails a test instead of
// silently teaching the wrong thing. Every case line is harmless on purpose: nothing here lists or decodes a blocked term.
import { filterChat, type FilterAction } from '../../shared/moderation';

export type Outcome = 'As typed' | 'Word starred' | 'Withheld';
export const OUTCOMES: readonly Outcome[] = ['As typed', 'Word starred', 'Withheld'];

export function outcomeOf(action: FilterAction): Outcome {
  return action === 'mask' ? 'Word starred' : action === 'block' ? 'Withheld' : 'As typed';
}

/** What the real filter does with `text`: the classroom default (strict) and the relaxed setting (standard). */
export function runFilter(text: string): { strict: Outcome; standard: Outcome } {
  return {
    strict: outcomeOf(filterChat(text, { strictness: 'strict', custom: null }).action),
    standard: outcomeOf(filterChat(text, { strictness: 'standard', custom: null }).action),
  };
}

export interface FilterCase {
  id: string;
  text: string;
  /** Shown after the student predicts. */
  note: string;
  /** Pinned by the unit test. */
  strict: Outcome;
  standard: Outcome;
}

export const FILTER_CASES: readonly FilterCase[] = [
  {
    id: 'plain', text: 'Good game everyone, nice flying!', strict: 'As typed', standard: 'As typed',
    note: 'Nearly all chat is ordinary, and the filter stays out of the way.',
  },
  {
    id: 'inside', text: 'Finish the class assignment first.', strict: 'As typed', standard: 'As typed',
    note: 'Ordinary words can hide a rude-looking string. The filter matches whole words with boundary rules and keeps a list of clean words, so this is not blocked.',
  },
  {
    id: 'place', text: 'My cousin lives in Scunthorpe.', strict: 'As typed', standard: 'As typed',
    note: 'In the 1990s a filter famously blocked people from a town called Scunthorpe because of a string inside its name. This is called the Scunthorpe problem: a false positive.',
  },
  {
    id: 'mild', text: 'this is crap', strict: 'Word starred', standard: 'As typed',
    note: 'A mild word. Strict (the classroom default) stars it. Standard lets it through. The same rule can be set differently for different rooms and ages.',
  },
  {
    id: 'insult', text: 'you are an idiot', strict: 'As typed', standard: 'As typed',
    note: 'An insult that is not on the lists passes. The filter knows words, not intent or tone, so this is a false negative.',
  },
  {
    id: 'exclude', text: 'nobody wants you on this team', strict: 'As typed', standard: 'As typed',
    note: 'No single word is bad, yet it can be bullying. Nothing in a word list can see that.',
  },
  {
    id: 'game', text: 'I will take you down in the next round', strict: 'As typed', standard: 'As typed',
    note: 'Aggressive-sounding but normal game talk. A filter that blocked it would be wrong.',
  },
  {
    id: 'context', text: 'I will find you after school.', strict: 'As typed', standard: 'As typed',
    note: 'The same sentence could be a joke between friends or a threat. Only context tells you, which is why people read reports and review the log.',
  },
];

export interface FilterQuestion { id: string; prompt: string; options: string[]; answer: number; why: string }

export const FILTER_QUESTIONS: readonly FilterQuestion[] = [
  {
    id: 'boundary',
    prompt: '"Finish the class assignment first" passes even though it contains a rude-looking string. How does Voidswarm avoid blocking it?',
    options: [
      'It never checks lines longer than ten words',
      'It matches whole words with boundary rules and keeps a list of clean words that are allowed',
      'A moderator reads every line before anyone sees it',
    ],
    answer: 1,
    why: 'Boundary-aware matching plus an allowlist is how a rule-based filter avoids the Scunthorpe problem.',
  },
  {
    id: 'meaning',
    prompt: '"you are an idiot" passes the filter. What does that show?',
    options: [
      'A word list only knows the words it contains, so it cannot judge intent or tone',
      'The filter has a bug that someone forgot to fix',
      'Insults are always allowed in games',
    ],
    answer: 0,
    why: 'A rule-based filter is predictable and easy to explain, but it only sees the listed words.',
  },
  {
    id: 'ml',
    prompt: 'A school wants a filter that notices bullying even when no bad word is used. Which statement about machine learning (ML) is true?',
    options: [
      'ML needs no examples to learn from',
      'ML is always more accurate than rules',
      'ML can learn patterns beyond word lists, but it needs many labeled chat examples (more collecting of student messages) and its mistakes are harder to explain',
    ],
    answer: 2,
    why: 'Data-driven methods catch more kinds of problems but bring a data-collection (privacy) cost and less explainability. Many systems use rules and ML together, with people deciding in hard cases.',
  },
  {
    id: 'log',
    prompt: 'The server keeps a log of chat lines so teachers can review problems. Which pair names a benefit and a matching privacy safeguard?',
    options: [
      'Benefit: students can read each other\'s logs. Safeguard: passwords',
      'Benefit: teachers can investigate a report. Safeguard: only moderators can read the log and old lines are deleted after a retention period (90 days by default)',
      'Benefit: proof for discipline. Safeguard: none is needed',
    ],
    answer: 1,
    why: 'A log helps safety and accountability but is personal data, so limit who can see it and how long it is kept.',
  },
];

export function quizScore(answers: readonly (number | null)[], qs: readonly FilterQuestion[] = FILTER_QUESTIONS): number {
  if (!qs.length) return 0;
  let right = 0;
  qs.forEach((q, i) => { if (answers[i] === q.answer) right++; });
  return right / qs.length;
}

export interface CaseNote { id: string; predicted: Outcome | null; judgement: 'OK in class chat' | 'Not OK' | 'It depends' | null }
export const JUDGEMENTS = ['OK in class chat', 'Not OK', 'It depends'] as const;

export const FILTER_REPORT_MIN = 150;
export const FILTER_REPORT_MAX = 3000;
export const FILTER_REPORT_PROMPT =
  'Case study report. (1) Give one case where the filter was right to stay quiet and one where it missed something a teacher would care about. '
  + '(2) To catch meaning, like bullying, would you use rules, machine learning or both? Justify it. '
  + '(3) The server logs chat so teachers can review it: name one benefit, one privacy risk and one safeguard.';

/** The text sent to the teacher (or copied): the student's case table plus their own analysis. Never includes a name. */
export function filterReportText(notes: readonly CaseNote[], analysis: string, score: number | null): string {
  const rows = FILTER_CASES.map((c, i) => {
    const n = notes.find((x) => x.id === c.id);
    return `${i + 1}. "${c.text}" | I predicted: ${n?.predicted ?? '–'} | strict filter: ${c.strict} | my call: ${n?.judgement ?? '–'}`;
  });
  const head = score === null ? 'Quiz: not taken' : `Quiz: ${Math.round(score * 100)}%`;
  return `${head}\nCases:\n${rows.join('\n')}\n\nAnalysis:\n${analysis.trim().slice(0, FILTER_REPORT_MAX)}`;
}
