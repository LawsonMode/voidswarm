import { describe, expect, it } from 'vitest';
import { LAG_QUESTIONS, quizScore, reportText, trialLine, type LagTrial } from './lagLabInfo';

const trial: LagTrial = { settings: { rttMs: 200, jitterMs: 40, lossPct: 5 }, prediction: false, pingMs: 214.6, jitterMs: 18, interpMs: 133, stalls: 3, feel: 'Laggy' };

describe('lagLabInfo', () => {
  it('every question has a valid answer index', () => {
    for (const q of LAG_QUESTIONS) {
      expect(q.options.length).toBeGreaterThanOrEqual(2);
      expect(q.answer).toBeGreaterThanOrEqual(0);
      expect(q.answer).toBeLessThan(q.options.length);
    }
  });

  it('scores the fraction right; unanswered is wrong', () => {
    const all = LAG_QUESTIONS.map((q) => q.answer);
    expect(quizScore(all)).toBe(1);
    expect(quizScore(all.map(() => null))).toBe(0);
    expect(quizScore([all[0], all[1], null, null])).toBe(0.5);
  });

  it('formats a trial and a report without any identity', () => {
    expect(trialLine(trial)).toBe('+200 ms ping, 40 ms jitter, 5% loss, prediction OFF: measured 215 ms ping, 18 ms jitter, 133 ms buffer, 3 stalls; felt Laggy');
    const r = reportText([trial], '  ping delays my ship  ', 0.75);
    expect(r).toContain('Quiz: 75%');
    expect(r).toContain('1. +200 ms ping');
    expect(r.endsWith('ping delays my ship')).toBe(true);
    expect(reportText([], 'x', null)).toContain('Quiz: not taken');
  });
});
