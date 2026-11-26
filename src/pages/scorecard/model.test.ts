import { describe, expect, it } from 'vitest';
import { computeScorecard } from '../../domain/scoring';
import { makeAnswer, scored, skipped, workedExamplePlan } from '../../test/fixtures';
import { barWidth, capNote, categorySignal, keyPointsCovered, redFlagsSeen, SIGNAL_LABELS } from './model';

describe('Scorecard presentation helpers', () => {
  it('SCORE-5: strengths and concerns are labelled in text, not colour only (A11Y-3)', () => {
    const sc = computeScorecard(workedExamplePlan(), [scored('t-1', 4), scored('t-2', 2), scored('t-3', 4), skipped('t-4')]);
    const byName = Object.fromEntries(sc.categories.map((c) => [c.category.name, categorySignal(c)]));
    expect(byName).toEqual({ Strategy: 'strength', Networking: 'concern' });
    expect(SIGNAL_LABELS.strength).toBe('Strength');
  });

  it('SCORE-8: a must-have category with no answers is a "no evidence" concern', () => {
    const sc = computeScorecard(workedExamplePlan(true), [scored('t-1', 3), skipped('t-2'), scored('t-3', 3), scored('t-4', 3)]);
    const net = sc.categories.find((c) => c.category.name === 'Networking')!;
    expect(categorySignal(net)).toBe('no-evidence');
    expect(SIGNAL_LABELS['no-evidence']).toMatch(/no evidence/);
  });

  it('SCORE-8: the cap note names the category and the uncapped band (worked example: Hire capped to Lean no hire)', () => {
    const sc = computeScorecard(workedExamplePlan(true), [scored('t-1', 4), scored('t-2', 1), scored('t-3', 4), scored('t-4', 4)]);
    expect(sc.capApplied).toBe(true);
    const note = capNote(sc)!;
    expect(note).toContain('Networking (average 1.0)');
    expect(note).toContain('capped at Lean no hire');
    expect(note).toContain('otherwise be Hire');
  });

  it('SCORE-8: when the band is already Lean no hire or lower, the note says the cap changed nothing', () => {
    const sc = computeScorecard(workedExamplePlan(true), [scored('t-1', 4), scored('t-2', 1), scored('t-3', 4), skipped('t-4')]);
    expect(sc.capApplied).toBe(false);
    expect(capNote(sc)).toMatch(/already Lean no hire, so it is unchanged/);
  });

  it('SCORE-8: no note when no must-have category averages below 2.0', () => {
    const sc = computeScorecard(workedExamplePlan(true), [scored('t-1', 4), scored('t-2', 3), scored('t-3', 4), scored('t-4', 4)]);
    expect(capNote(sc)).toBeNull();
  });

  it('FLOW-24: key points covered are counted as n of m; red flags are listed by text', () => {
    const plan = workedExamplePlan();
    const sc = computeScorecard(plan, [makeAnswer('t-1', { score: 1, coveredKeyPoints: [0, 2, 2, 9], redFlagsSeen: [0, 5] })]);
    const r = sc.questions[0];
    expect(keyPointsCovered(r)).toEqual({ covered: 2, total: 4 });
    expect(redFlagsSeen(r)).toEqual(['x']);
    expect(keyPointsCovered(sc.questions[1])).toEqual({ covered: 0, total: 4 });
  });

  it('A11Y-5: bar widths are clamped to 0..100 and empty for categories with no percentage', () => {
    expect(barWidth(null)).toBe(0);
    expect(barWidth(55.56)).toBeCloseTo(55.56);
    expect(barWidth(120)).toBe(100);
    expect(barWidth(-1)).toBe(0);
  });
});
