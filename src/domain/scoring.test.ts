import { describe, expect, it } from 'vitest';
import {
  bandFor,
  computePanel,
  computeScorecard,
  formatAverage,
  formatCoverage,
  formatPct,
  median,
  questionWeight,
  scoreValue,
  type Scorecard,
} from './scoring';
import { makeAnswer, makeCategory, makePlan, makeQuestion, scored, skipped, workedExamplePlan } from '../test/fixtures';

const base = () => computeScorecard(workedExamplePlan(), [scored('t-1', 4), scored('t-2', 3), scored('t-3', 2), skipped('t-4')]);
const cat = (sc: Scorecard, name: string) => sc.categories.find((c) => c.category.name === name)!;

describe('docs/04 worked example', () => {
  it('SCORE-1: values are (score - 1) / 3', () => {
    expect(scoreValue(1)).toBe(0);
    expect(scoreValue(2)).toBeCloseTo(0.333, 3);
    expect(scoreValue(3)).toBeCloseTo(0.667, 3);
    expect(scoreValue(4)).toBe(1);
  });

  it('SCORE-2: weights are difficulty weight × category weight (1.0, 1.8, 2.0, 1.5)', () => {
    const sc = base();
    expect(sc.questions.map((q) => q.weight)).toEqual([1.0, expect.closeTo(1.8, 10), 2.0, 1.5]);
    expect(questionWeight({ difficulty: 'expert', type: 'behavioural' }, { weight: 1 })).toBe(1);
  });

  it('SCORE-2: per-question w × v matches the table', () => {
    const wv = base().questions.map((q) => (q.value == null ? null : q.weight * q.value));
    expect(wv[0]).toBeCloseTo(1.0, 3);
    expect(wv[1]).toBeCloseTo(1.2, 3);
    expect(wv[2]).toBeCloseTo(0.667, 3);
    expect(wv[3]).toBeNull();
  });

  it('MVP-3, SCORE-3: overall is 59.72% from sum(w) = 4.8 and sum(w × v) = 2.8667, displayed as 60%', () => {
    const sc = base();
    expect(sc.sumWeightAnswered).toBeCloseTo(4.8, 10);
    expect(sc.sumWeightedValue).toBeCloseTo(2.8667, 4);
    expect(sc.overallPct).toBeCloseTo(59.72, 2);
    expect(formatPct(sc.overallPct)).toBe('60%');
  });

  it('SCORE-3: skipped questions are excluded and listed separately with their reasons', () => {
    const sc = base();
    expect(sc.skipped.map((q) => q.question.id)).toEqual(['t-4']);
    expect(sc.skipped[0].skipReason).toBe('Out of time');
    expect(sc.answeredCount).toBe(3);
  });

  it('SCORE-6: coverage is 4.8 / 6.3 = 76.2%, at least 70%, so a band is shown', () => {
    const sc = base();
    expect(sc.sumWeightPlanned).toBeCloseTo(6.3, 10);
    expect(sc.coverage).toBeCloseTo(0.762, 3);
    expect(formatCoverage(sc.coverage)).toBe('76%');
    expect(sc.insufficientEvidence).toBe(false);
    expect(sc.band).not.toBeNull();
  });

  it('SCORE-7: band is Lean no hire (50 to under 65)', () => {
    expect(base().band).toBe('lean_no_hire');
  });

  it('SCORE-4, SCORE-5: Strategy is 55.56% with average 3.0, a strength', () => {
    const s = cat(base(), 'Strategy');
    expect(s.pct).toBeCloseTo(55.56, 2);
    expect(s.average).toBe(3.0);
    expect(formatAverage(s.average)).toBe('3.0');
    expect(s.isStrength).toBe(true);
    expect(s.answeredCount).toBe(2);
    expect(s.plannedCount).toBe(3);
  });

  it('SCORE-4, SCORE-5: Networking is 66.67% with average 3.0, also a strength', () => {
    const sc = base();
    const n = cat(sc, 'Networking');
    expect(n.pct).toBeCloseTo(66.67, 2);
    expect(n.average).toBe(3.0);
    expect(sc.strengths.map((c) => c.category.name)).toEqual(['Strategy', 'Networking']);
    expect(sc.concerns).toEqual([]);
  });

  it('SCORE-6: if Q3 were also skipped, coverage would be 2.8 / 6.3 = 44.4%: Insufficient evidence', () => {
    const sc = computeScorecard(workedExamplePlan(), [scored('t-1', 4), scored('t-2', 3), skipped('t-3'), skipped('t-4')]);
    expect(sc.coverage).toBeCloseTo(0.444, 3);
    expect(sc.insufficientEvidence).toBe(true);
    expect(sc.band).toBeNull();
    expect(sc.overallPct).not.toBeNull(); // the percentage is still shown
  });

  it('SCORE-7: if Q1, Q2 and Q3 scored 4, the overall would be 100% (Strong hire)', () => {
    const sc = computeScorecard(workedExamplePlan(), [scored('t-1', 4), scored('t-2', 4), scored('t-3', 4), skipped('t-4')]);
    expect(sc.overallPct).toBeCloseTo(100, 10);
    expect(sc.band).toBe('strong_hire');
  });

  it('SCORE-8: Networking must-have with Q2 = 1, Q1 = Q3 = 4 gives 62.5% (Lean no hire already, cap changes nothing)', () => {
    const sc = computeScorecard(workedExamplePlan(true), [scored('t-1', 4), scored('t-2', 1), scored('t-3', 4), skipped('t-4')]);
    expect(sc.overallPct).toBeCloseTo(62.5, 10);
    expect(sc.uncappedBand).toBe('lean_no_hire');
    expect(sc.band).toBe('lean_no_hire');
    expect(sc.capApplied).toBe(false);
    expect(sc.capCategories.map((c) => c.name)).toEqual(['Networking']);
  });

  it('SCORE-8: Q1 = Q3 = Q4 = 4, Q2 = 1, Networking must-have: 71.43% → Hire, capped to Lean no hire by Networking (average 1.0)', () => {
    const sc = computeScorecard(workedExamplePlan(true), [scored('t-1', 4), scored('t-2', 1), scored('t-3', 4), scored('t-4', 4)]);
    expect(sc.sumWeightAnswered).toBeCloseTo(6.3, 10);
    expect(sc.sumWeightedValue).toBeCloseTo(4.5, 10);
    expect(sc.overallPct).toBeCloseTo(71.43, 2);
    expect(sc.uncappedBand).toBe('hire');
    expect(sc.band).toBe('lean_no_hire');
    expect(sc.capApplied).toBe(true);
    expect(sc.capCategories.map((c) => c.name)).toEqual(['Networking']);
    expect(cat(sc, 'Networking').average).toBe(1.0);
    expect(sc.concerns.map((c) => [c.category.name, c.reason])).toEqual([['Networking', 'low-average']]);
  });
});

describe('scoring rules beyond the worked example', () => {
  it('SCORE-8: a must-have category with no answered questions is a "no evidence" concern but does not cap', () => {
    const sc = computeScorecard(workedExamplePlan(true), [scored('t-1', 4), skipped('t-2'), scored('t-3', 4), scored('t-4', 4)]);
    expect(sc.uncappedBand).toBe('strong_hire');
    expect(sc.capApplied).toBe(false);
    expect(sc.band).toBe('strong_hire');
    const n = cat(sc, 'Networking');
    expect(n.noEvidence).toBe(true);
    expect(n.pct).toBeNull();
    expect(n.average).toBeNull();
    expect(sc.concerns).toEqual([expect.objectContaining({ reason: 'no-evidence', average: null })]);
  });

  it('SCORE-8: lower bands are unchanged by the cap', () => {
    const sc = computeScorecard(workedExamplePlan(true), [scored('t-1', 1), scored('t-2', 1), scored('t-3', 2), scored('t-4', 2)]);
    expect(sc.uncappedBand).toBe('no_hire');
    expect(sc.band).toBe('no_hire');
    expect(sc.capApplied).toBe(false);
  });

  it('SCORE-5: a category averaging 2.0 or less is a concern', () => {
    const sc = computeScorecard(workedExamplePlan(), [scored('t-1', 2), scored('t-2', 3), scored('t-3', 2), skipped('t-4')]);
    expect(sc.concerns.map((c) => c.category.name)).toEqual(['Strategy']);
    expect(sc.strengths.map((c) => c.category.name)).toEqual(['Networking']);
  });

  it('SCORE-7: band thresholds use the unrounded percentage (79.6% is Hire even though it displays as 80%)', () => {
    expect(bandFor(80)).toBe('strong_hire');
    expect(bandFor(79.6)).toBe('hire');
    expect(formatPct(79.6)).toBe('80%');
    expect(bandFor(65)).toBe('hire');
    expect(bandFor(64.99)).toBe('lean_no_hire');
    expect(bandFor(50)).toBe('lean_no_hire');
    expect(bandFor(49.99)).toBe('no_hire');
  });

  it('SCORE-6: coverage of exactly 70% is sufficient; just under is not', () => {
    const cats = [makeCategory({ id: 'c' })];
    const qs = Array.from({ length: 10 }, (_, i) => makeQuestion({ id: `t-${i + 1}`, categoryId: 'c' }));
    const plan = makePlan(qs, cats);
    const answers = qs.map((q, i) => (i < 7 ? scored(q.id, 3) : skipped(q.id)));
    expect(computeScorecard(plan, answers).insufficientEvidence).toBe(false);
    const fewer = qs.map((q, i) => (i < 6 ? scored(q.id, 3) : skipped(q.id)));
    expect(computeScorecard(plan, fewer).insufficientEvidence).toBe(true);
  });

  it('SCORE-3: nothing answered gives no percentage and no band; unanswered questions count as planned only', () => {
    const sc = computeScorecard(workedExamplePlan(), [makeAnswer('t-1')]);
    expect(sc.overallPct).toBeNull();
    expect(sc.band).toBeNull();
    expect(sc.coverage).toBe(0);
    expect(formatPct(sc.overallPct)).toBe('–');
  });

  it('FLOW-24: flagged questions are listed', () => {
    const sc = computeScorecard(workedExamplePlan(), [scored('t-1', 4, { flagged: true }), scored('t-2', 3)]);
    expect(sc.flagged.map((q) => q.question.id)).toEqual(['t-1']);
  });

  it('SCORE-10: averages display with one decimal place', () => {
    expect(formatAverage(2.25)).toBe('2.3');
    expect(formatAverage(3)).toBe('3.0');
    expect(formatAverage(null)).toBe('–');
  });
});

describe('panel', () => {
  const sc = (pct: number) => ({ overallPct: pct, categories: [] }) as unknown as Scorecard;

  it('SCORE-11: panel score is the median; for an even count, the mean of the middle two', () => {
    expect(median([60, 70, 90])).toBe(70);
    expect(median([60, 70, 80, 90])).toBe(75);
    expect(computePanel([60, 90, 70].map((p) => ({ ref: p, scorecard: sc(p) }))).median).toBe(70);
  });

  it('SCORE-11, FLOW-28: a spread above 20 points is flagged; exactly 20 is not', () => {
    const a = computePanel([50, 70].map((p) => ({ ref: p, scorecard: sc(p) })));
    expect(a.spread).toBe(20);
    expect(a.spreadFlag).toBe(false);
    const b = computePanel([50, 70.5].map((p) => ({ ref: p, scorecard: sc(p) })));
    expect(b.spreadFlag).toBe(true);
  });

  it('FLOW-28: per-category averages are given side by side', () => {
    const plan = workedExamplePlan();
    const a = computeScorecard(plan, [scored('t-1', 4), scored('t-2', 3), scored('t-3', 2), skipped('t-4')]);
    const b = computeScorecard(plan, [scored('t-1', 2), skipped('t-2'), scored('t-3', 2), skipped('t-4')]);
    const panel = computePanel([{ ref: 'a', scorecard: a }, { ref: 'b', scorecard: b }]);
    const networking = panel.categoryAverages.find((c) => c.category.name === 'Networking')!;
    expect(networking.averages).toEqual([3, null]);
  });
});
