import { describe, expect, it } from 'vitest';
import {
  FILTER_CASES, FILTER_QUESTIONS, filterReportText, quizScore, runFilter, type CaseNote,
} from './filterLabInfo';

describe('filterLabInfo', () => {
  it('pins every case to what the real filter does (strict and standard)', () => {
    for (const c of FILTER_CASES) expect(runFilter(c.text), c.id).toEqual({ strict: c.strict, standard: c.standard });
  });

  it('keeps at least one case where strictness changes the result, and one the filter misses', () => {
    expect(FILTER_CASES.some((c) => c.strict !== c.standard)).toBe(true);
    expect(FILTER_CASES.some((c) => c.id === 'insult' && c.strict === 'As typed')).toBe(true);
  });

  it('questions are well formed and answers are not all in one position', () => {
    for (const q of FILTER_QUESTIONS) {
      expect(q.options.length).toBeGreaterThanOrEqual(2);
      expect(q.answer).toBeLessThan(q.options.length);
    }
    expect(new Set(FILTER_QUESTIONS.map((q) => q.answer)).size).toBeGreaterThan(1);
  });

  it('scores the fraction right', () => {
    const all = FILTER_QUESTIONS.map((q) => q.answer);
    expect(quizScore(all)).toBe(1);
    expect(quizScore(all.map(() => null))).toBe(0);
  });

  it('builds a report with the case table and no identity', () => {
    const notes: CaseNote[] = [{ id: 'plain', predicted: 'As typed', judgement: 'OK in class chat' }];
    const r = filterReportText(notes, '  my analysis  ', 0.5);
    expect(r).toContain('Quiz: 50%');
    expect(r).toContain('1. "Good game everyone, nice flying!" | I predicted: As typed | strict filter: As typed | my call: OK in class chat');
    expect(r).toContain('2. "Finish the class assignment first." | I predicted: –');
    expect(r.endsWith('my analysis')).toBe(true);
  });
});
