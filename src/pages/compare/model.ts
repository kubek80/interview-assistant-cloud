// Pure helpers for the Comparison screen (FLOW-30).
import type { ComparisonRow, PlanChoice } from '../../db';
import { interviewersLabel } from '../../domain/interviewers';
import { agreedScorecard } from '../../domain/decision';
import { median, type Scorecard } from '../../domain/scoring';
import type { InterviewPlan, PanelDecision } from '../../domain/types';


export type SortDir = 'desc' | 'asc';
export type SortKey = 'overall' | 'candidate';

/**
 * FLOW-30: sort rows by unrounded overall percentage (rows with no percentage last, whatever the
 * direction), ties broken by candidate key then interviewer so the order is stable.
 */
export function sortComparisonRows<R extends Pick<ComparisonRow, 'candidateKey' | 'session'> & { scorecard: { overallPct: number | null } }>(
  rows: readonly R[],
  key: SortKey,
  dir: SortDir,
): R[] {
  const sign = dir === 'asc' ? 1 : -1;
  const tie = (a: R, b: R) => a.candidateKey.localeCompare(b.candidateKey) || interviewersLabel(a.session).localeCompare(interviewersLabel(b.session));
  return [...rows].sort((a, b) => {
    if (key === 'candidate') return sign * tie(a, b);
    const pa = a.scorecard.overallPct;
    const pb = b.scorecard.overallPct;
    if (pa == null && pb == null) return tie(a, b);
    if (pa == null) return 1;
    if (pb == null) return -1;
    return sign * (pa - pb) || tie(a, b);
  });
}

/**
 * FLOW-27 applied by loadComparison: imported panelist sessions are left out until this device's
 * own session for that candidate is submitted. The count lets the screen say how many are held back.
 */
export function blindedCount(choice: Pick<PlanChoice, 'submittedCount'> | undefined, visibleRows: number): number {
  return choice ? Math.max(0, choice.submittedCount - visibleRows) : 0;
}

// ---------------------------------------------------------------------------------------------
// TEAM-12: one block per candidate, led by the figure that stands for the panel.


export type FigureSource = 'agreed' | 'median' | 'single';

export interface CandidateLine {
  source: FigureSource;
  /** "Agreed scores", "Panel median of 2", "One interviewer". */
  label: string;
  /** The judgement for 'single' rows. */
  row: ComparisonRow | null;
  pct: number | null;
  /** Category id → average (1–4). */
  averages: Map<string, number | null>;
  band: Scorecard['band'];
  insufficientEvidence: boolean;
  capped: boolean;
}

export interface CandidateBlock {
  candidateKey: string;
  decision: PanelDecision | null;
  /** First the figure that stands for the panel (agreed or median) when there is one, then each judgement. */
  lines: CandidateLine[];
  /** The panel's figure, for sorting. */
  main: number | null;
}

const single = (r: ComparisonRow): CandidateLine => ({
  source: 'single',
  label: 'One interviewer',
  row: r,
  pct: r.scorecard.overallPct,
  averages: new Map(r.scorecard.categories.map((c) => [c.category.id, c.average])),
  band: r.scorecard.band,
  insufficientEvidence: r.scorecard.insufficientEvidence,
  capped: r.scorecard.capApplied,
});

/**
 * TEAM-12: groups the comparison by candidate. A candidate's block starts with the agreed scores
 * (when the panel decision has them) or the panel's median (two or more judgements with question
 * scores), each labelled, followed by each interviewer's own figures.
 */
export function candidateBlocks(plan: InterviewPlan, rows: readonly ComparisonRow[], decisions: ReadonlyMap<string, PanelDecision>): CandidateBlock[] {
  const byKey = new Map<string, ComparisonRow[]>();
  for (const r of rows) byKey.set(r.candidateKey, [...(byKey.get(r.candidateKey) ?? []), r]);
  return [...byKey].map(([candidateKey, list]) => {
    const decision = decisions.get(candidateKey) ?? null;
    const scored = list.filter((r) => r.scorecard.answeredCount > 0);
    const lines = list.map(single);
    const agreed = agreedScorecard(plan, decision);
    let lead: CandidateLine | null = null;
    if (agreed) {
      lead = { source: 'agreed', label: 'Agreed scores', row: null, pct: agreed.overallPct, averages: new Map(agreed.categories.map((c) => [c.category.id, c.average])), band: agreed.band, insufficientEvidence: agreed.insufficientEvidence, capped: agreed.capApplied };
    } else if (scored.length >= 2) {
      const ids = plan.categories.map((c) => c.id);
      const m = median(scored.map((r) => r.scorecard.overallPct!).filter((p) => p != null));
      lead = {
        source: 'median',
        label: `Panel median of ${scored.length}`,
        row: null,
        pct: m,
        averages: new Map(ids.map((id) => [id, median(scored.map((r) => r.scorecard.categories.find((c) => c.category.id === id)?.average).filter((a): a is number => a != null))])),
        band: null,
        insufficientEvidence: false,
        capped: false,
      };
    }
    const all = lead ? [lead, ...lines] : lines;
    return { candidateKey, decision, lines: all, main: all[0]?.pct ?? null };
  });
}
