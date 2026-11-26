// Presentation helpers for the Scorecard screen. Pure: all score maths comes from
// computeScorecard (domain/scoring); these only turn its results into display facts.
import { BAND_LABELS, formatAverage, type CategoryResult, type QuestionResult, type Scorecard } from '../../domain/scoring';

/** SCORE-5, SCORE-8: the text signal shown next to a category (never colour alone, A11Y-3). */
export type CategorySignal = 'strength' | 'concern' | 'no-evidence' | 'no-answers' | 'none';

export function categorySignal(c: Pick<CategoryResult, 'isStrength' | 'isConcern' | 'noEvidence' | 'answeredCount'>): CategorySignal {
  if (c.isStrength) return 'strength';
  if (c.isConcern) return 'concern';
  if (c.noEvidence) return 'no-evidence';
  if (c.answeredCount === 0) return 'no-answers';
  return 'none';
}

export const SIGNAL_LABELS: Record<CategorySignal, string> = {
  strength: 'Strength',
  concern: 'Concern',
  'no-evidence': 'Concern: no evidence',
  'no-answers': 'No answered questions',
  none: '',
};

/** Width of a chart bar in percent, clamped to 0..100 (null → 0). */
export function barWidth(pct: number | null): number {
  if (pct == null || Number.isNaN(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

/** FLOW-24 per-question table: key points covered as "n of m". */
export function keyPointsCovered(r: Pick<QuestionResult, 'answer' | 'question'>): { covered: number; total: number } {
  const total = r.question.lookFor.length;
  const covered = new Set((r.answer?.coveredKeyPoints ?? []).filter((i) => i >= 0 && i < total)).size;
  return { covered, total };
}

/** FLOW-24 per-question table: the text of each red flag ticked. */
export function redFlagsSeen(r: Pick<QuestionResult, 'answer' | 'question'>): string[] {
  return (r.answer?.redFlagsSeen ?? []).map((i) => r.question.redFlags[i]).filter((s): s is string => typeof s === 'string');
}

/**
 * SCORE-8: a plain-language note about the must-have cap, or null when no must-have category
 * averages below 2.0. Says whether the cap changed the band and which categories caused it.
 */
export function capNote(sc: Pick<Scorecard, 'capCategories' | 'capApplied' | 'uncappedBand' | 'categories' | 'insufficientEvidence'>): string | null {
  if (!sc.capCategories.length) return null;
  const names = sc.capCategories
    .map((cat) => {
      const avg = sc.categories.find((c) => c.category.id === cat.id)?.average ?? null;
      return `${cat.name} (average ${formatAverage(avg)})`;
    })
    .join(', ');
  const plural = sc.capCategories.length > 1;
  const cause = `Must-have ${plural ? 'categories' : 'category'} ${names} ${plural ? 'average' : 'averages'} below 2.0.`;
  if (sc.capApplied && sc.uncappedBand) {
    const text = `${cause} The band is capped at Lean no hire (it would otherwise be ${BAND_LABELS[sc.uncappedBand]}).`;
    return sc.insufficientEvidence ? `${text} No band is shown because evidence is insufficient.` : text;
  }
  return `${cause} The cap allows at most Lean no hire; the band is already ${sc.uncappedBand ? BAND_LABELS[sc.uncappedBand] : 'not set'}, so it is unchanged.`;
}
