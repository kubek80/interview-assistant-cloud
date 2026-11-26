// All score maths (docs/04-scoring.md). Pure; covered by scoring.test.ts.
import { effectiveDifficulty } from './rubric';
import type { Answer, Difficulty, InterviewPlan, PlanCategory, QuestionSnapshot, Recommendation, Score } from './types';

/** Guards band/coverage comparisons against floating-point noise (e.g. 79.99999999 for an exact 80). */
const EPS = 1e-9;

export const DIFFICULTY_WEIGHTS: Record<Difficulty, number> = { core: 1.0, advanced: 1.5, expert: 2.0 };
export const COVERAGE_THRESHOLD = 0.7;
export const STRENGTH_AVERAGE = 3.0;
export const CONCERN_AVERAGE = 2.0;
export const MUST_HAVE_CAP_AVERAGE = 2.0;
export const PANEL_SPREAD_LIMIT = 20;

export type Band = Recommendation;
export const BAND_LABELS: Record<Band, string> = {
  strong_hire: 'Strong hire',
  hire: 'Hire',
  lean_no_hire: 'Lean no hire',
  no_hire: 'No hire',
};

/** SCORE-1 */
export function scoreValue(score: Score): number {
  return (score - 1) / 3;
}

/** SCORE-2 */
export function questionWeight(question: Pick<QuestionSnapshot, 'difficulty' | 'type'>, category: Pick<PlanCategory, 'weight'> | undefined): number {
  return DIFFICULTY_WEIGHTS[effectiveDifficulty(question)] * (category?.weight ?? 1);
}

/** SCORE-7, applied to the unrounded percentage. */
export function bandFor(pct: number): Band {
  if (pct >= 80 - EPS) return 'strong_hire';
  if (pct >= 65 - EPS) return 'hire';
  if (pct >= 50 - EPS) return 'lean_no_hire';
  return 'no_hire';
}

export function isAnswered(answer: Pick<Answer, 'score' | 'skipped'> | undefined): answer is Answer & { score: Score } {
  return !!answer && !answer.skipped && answer.score != null;
}

export interface QuestionResult {
  index: number;
  question: QuestionSnapshot;
  category: PlanCategory | undefined;
  answer: Answer | undefined;
  weight: number;
  score: Score | null;
  /** SCORE-1 value, null unless answered. */
  value: number | null;
  answered: boolean;
  skipped: boolean;
  skipReason: string | null;
  flagged: boolean;
}

export interface CategoryResult {
  category: PlanCategory;
  plannedCount: number;
  answeredCount: number;
  /** SCORE-4: null when the category has no answered questions. */
  pct: number | null;
  average: number | null;
  sumWeight: number;
  sumWeightedValue: number;
  /** SCORE-5 */
  isStrength: boolean;
  isConcern: boolean;
  /** SCORE-8: must-have category with no answered questions. */
  noEvidence: boolean;
}

export interface Concern {
  category: PlanCategory;
  reason: 'low-average' | 'no-evidence';
  average: number | null;
}

export interface Scorecard {
  questions: QuestionResult[];
  sumWeightAnswered: number;
  sumWeightPlanned: number;
  sumWeightedValue: number;
  /** SCORE-3: unrounded; null when nothing is answered. */
  overallPct: number | null;
  /** SCORE-6: 0..1 */
  coverage: number;
  insufficientEvidence: boolean;
  categories: CategoryResult[];
  strengths: CategoryResult[];
  concerns: Concern[];
  /** Band before the must-have cap; null when nothing is answered. */
  uncappedBand: Band | null;
  /** SCORE-8: must-have categories averaging below 2.0. */
  capCategories: PlanCategory[];
  capApplied: boolean;
  /** Band after the cap; null when nothing is answered or evidence is insufficient (SCORE-6). */
  band: Band | null;
  skipped: QuestionResult[];
  flagged: QuestionResult[];
  answeredCount: number;
  plannedCount: number;
}

export function computeScorecard(plan: Pick<InterviewPlan, 'questions' | 'categories'>, answers: readonly Answer[]): Scorecard {
  const byQuestion = new Map(answers.map((a) => [a.questionId, a]));
  const catById = new Map(plan.categories.map((c) => [c.id, c]));

  const questions: QuestionResult[] = plan.questions.map((question, index) => {
    const answer = byQuestion.get(question.id);
    const category = catById.get(question.categoryId);
    const answered = isAnswered(answer);
    const score = answered ? answer.score : null;
    return {
      index,
      question,
      category,
      answer,
      weight: questionWeight(question, category),
      score,
      value: score == null ? null : scoreValue(score),
      answered,
      skipped: !!answer?.skipped,
      skipReason: answer?.skipped ? answer.skipReason : null,
      flagged: !!answer?.flagged,
    };
  });

  const answeredQs = questions.filter((q) => q.answered);
  const sumWeightPlanned = sum(questions.map((q) => q.weight));
  const sumWeightAnswered = sum(answeredQs.map((q) => q.weight));
  const sumWeightedValue = sum(answeredQs.map((q) => q.weight * (q.value as number)));
  const overallPct = sumWeightAnswered > 0 ? (sumWeightedValue / sumWeightAnswered) * 100 : null;
  const coverage = sumWeightPlanned > 0 ? sumWeightAnswered / sumWeightPlanned : 0;
  const insufficientEvidence = coverage < COVERAGE_THRESHOLD - EPS;

  // Categories in plan order; categories with no planned questions are omitted.
  const categories: CategoryResult[] = plan.categories
    .map((category) => {
      const inCat = questions.filter((q) => q.question.categoryId === category.id);
      const answeredInCat = inCat.filter((q) => q.answered);
      const sw = sum(answeredInCat.map((q) => q.weight));
      const swv = sum(answeredInCat.map((q) => q.weight * (q.value as number)));
      const average = answeredInCat.length ? sum(answeredInCat.map((q) => q.score as number)) / answeredInCat.length : null;
      return {
        category,
        plannedCount: inCat.length,
        answeredCount: answeredInCat.length,
        pct: sw > 0 ? (swv / sw) * 100 : null,
        average,
        sumWeight: sw,
        sumWeightedValue: swv,
        isStrength: average != null && average >= STRENGTH_AVERAGE - EPS,
        isConcern: average != null && average <= CONCERN_AVERAGE + EPS,
        noEvidence: category.mustHave && answeredInCat.length === 0,
      };
    })
    .filter((c) => c.plannedCount > 0);

  const strengths = categories.filter((c) => c.isStrength);
  const concerns: Concern[] = categories
    .filter((c) => c.isConcern || c.noEvidence)
    .map((c) => ({ category: c.category, reason: c.isConcern ? 'low-average' : 'no-evidence', average: c.average }));

  const capCategories = categories
    .filter((c) => c.category.mustHave && c.average != null && c.average < MUST_HAVE_CAP_AVERAGE - EPS)
    .map((c) => c.category);
  const uncappedBand = overallPct == null ? null : bandFor(overallPct);
  const capApplied = capCategories.length > 0 && (uncappedBand === 'strong_hire' || uncappedBand === 'hire');
  const cappedBand = capApplied ? 'lean_no_hire' : uncappedBand;

  return {
    questions,
    sumWeightAnswered,
    sumWeightPlanned,
    sumWeightedValue,
    overallPct,
    coverage,
    insufficientEvidence,
    categories,
    strengths,
    concerns,
    uncappedBand,
    capCategories,
    capApplied,
    band: insufficientEvidence ? null : cappedBand,
    skipped: questions.filter((q) => q.skipped),
    flagged: questions.filter((q) => q.flagged),
    answeredCount: answeredQs.length,
    plannedCount: questions.length,
  };
}

export interface PanelMember<T = unknown> {
  /** Anything the screen needs to identify the panelist (e.g. the session). */
  ref: T;
  scorecard: Scorecard;
}

export interface PanelResult<T = unknown> {
  members: PanelMember<T>[];
  /** SCORE-11: median of members' overall percentages (members with no percentage are ignored). */
  median: number | null;
  min: number | null;
  max: number | null;
  spread: number | null;
  spreadFlag: boolean;
  /** Per category id: each member's average (null if none), in member order (FLOW-28). */
  categoryAverages: Array<{ category: PlanCategory; averages: Array<number | null>; pcts: Array<number | null> }>;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function computePanel<T>(members: PanelMember<T>[]): PanelResult<T> {
  const pcts = members.map((m) => m.scorecard.overallPct).filter((p): p is number => p != null);
  const min = pcts.length ? Math.min(...pcts) : null;
  const max = pcts.length ? Math.max(...pcts) : null;
  const spread = min == null || max == null ? null : max - min;

  const seen = new Map<string, PlanCategory>();
  for (const m of members) for (const c of m.scorecard.categories) if (!seen.has(c.category.id)) seen.set(c.category.id, c.category);
  const categoryAverages = [...seen.values()].map((category) => ({
    category,
    averages: members.map((m) => m.scorecard.categories.find((c) => c.category.id === category.id)?.average ?? null),
    pcts: members.map((m) => m.scorecard.categories.find((c) => c.category.id === category.id)?.pct ?? null),
  }));

  return {
    members,
    median: median(pcts),
    min,
    max,
    spread,
    spreadFlag: spread != null && spread > PANEL_SPREAD_LIMIT + EPS,
    categoryAverages,
  };
}

/** SCORE-10: whole-number percentage, e.g. "60%". */
export function formatPct(pct: number | null | undefined, empty = '–'): string {
  return pct == null || Number.isNaN(pct) ? empty : `${Math.round(pct)}%`;
}

/** SCORE-10: one decimal place, e.g. "3.0". */
export function formatAverage(avg: number | null | undefined, empty = '–'): string {
  return avg == null || Number.isNaN(avg) ? empty : (Math.round(avg * 10) / 10).toFixed(1);
}

/** Coverage (0..1) as a whole-number percentage. */
export function formatCoverage(coverage: number): string {
  return formatPct(coverage * 100);
}

function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
