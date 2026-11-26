// SUM-1…SUM-3, TEAM-6, TEAM-12: one row per panel (candidate + question set) for the Summary screen,
// the candidate page and the round report. Pure; covered by round.test.ts.
import { BAND_LABELS, bandFor, computePanel, formatPct, median, PANEL_SPREAD_LIMIT, STRENGTH_AVERAGE, CONCERN_AVERAGE, type Band, type Scorecard } from './scoring';
import { agreedScorecard, hasQuestionScores } from './decision';
import { attendance, uniqueNames, type Attendance } from './team';
import { candidateKey, formatCandidateKey } from './plan';
import { formatNames, interviewersOf, nameKey } from './interviewers';
import type { Answer, InterviewPlan, PanelDecision, PanelRecord, Recommendation, Session } from './types';
import { RECOMMENDATIONS, RECOMMENDATION_LABELS } from './types';

/** What the db layer gathers for one panel (candidate key + fingerprint, FLOW-29). */
export interface RoundPanelData {
  /** Route id of the candidate page (a record of the panel, or the panel record when there is none). */
  ref: string;
  panelKey: string;
  candidate: { initials: string; requisitionId: string | null };
  plan: InterviewPlan;
  trackName: string;
  /** Every record of the panel on this device (local, imported, entered). */
  records: Session[];
  /** Records with their scorecards where they may be shown (FLOW-27: `hidden` ones carry none). */
  entries: Array<{ session: Session; hidden: boolean; answers: Answer[] | null; scorecard: Scorecard | null }>;
  /** Everyone expected (planned interviews here, or the panel file). */
  expected: string[];
  date: string | null;
  time: string | null;
  record: PanelRecord | null;
}

export type ScoreSource = 'agreed' | 'median' | 'single' | 'none';
export type RoundState = 'decided' | 'no-decision' | 'waiting' | 'in-progress' | 'not-interviewed';

export const STATE_LABELS: Record<RoundState, string> = {
  decided: 'Decided',
  'no-decision': 'No decision yet',
  waiting: 'Waiting for judgements',
  'in-progress': 'Interview in progress',
  'not-interviewed': 'Not interviewed yet',
};

export const SOURCE_LABELS: Record<ScoreSource, string> = {
  agreed: 'Agreed scores',
  median: 'Panel median',
  single: 'One interviewer',
  none: 'No scores',
};

export interface RoundScore {
  source: ScoreSource;
  /** Unrounded overall percentage. */
  pct: number | null;
  band: Band | null;
  insufficientEvidence: boolean;
  capped: boolean;
  /** Judgements with question scores behind the figure (median, single). */
  members: number;
  spread: number | null;
  spreadFlag: boolean;
  /** e.g. "Panel median of 3", "Agreed scores", "One interviewer (Ben Ng)". */
  label: string;
}

export interface RoundJudgement {
  session: Session;
  names: string[];
  recommendation: Recommendation | null;
  entered: boolean;
  hidden: boolean;
  scorecard: Scorecard | null;
}

export interface RoundOutcome {
  kind: 'decision' | 'recommendations' | 'none';
  recommendation: Recommendation | null;
  /** Recommendation counts, strongest first. */
  tally: Array<{ recommendation: Recommendation; count: number }>;
  split: boolean;
  /** e.g. "Hire ×2, Lean no hire ×1". */
  text: string;
  /** Recommendation rank 4 (strong hire) … 1 (no hire), averaged over a split; null when none. */
  rank: number | null;
}

export interface RoundRow {
  ref: string;
  panelKey: string;
  candidateKey: string;
  /** "Ana Diaz · REQ-1" */
  candidate: string;
  name: string;
  requisition: string;
  trackId: string;
  trackName: string;
  fingerprint: string;
  planName: string;
  questionCount: number;
  /** YYYY-MM-DD: planned day, else the day of the first interview, else when the panel was first seen. */
  date: string | null;
  time: string | null;
  interviewers: string[];
  attendance: Attendance;
  judgements: RoundJudgement[];
  decision: PanelDecision | null;
  outcome: RoundOutcome;
  score: RoundScore;
  strengths: string[];
  concerns: string[];
  state: RoundState;
  /** Plain sentences of what is still missing (empty when nothing is). */
  missing: string[];
  hidden: number;
  summaryText: string;
}

const RANK: Record<Recommendation, number> = { strong_hire: 4, hire: 3, lean_no_hire: 2, no_hire: 1 };

/** SUM-1: "Hire ×2, Lean no hire ×1", strongest first. */
export function tallyText(tally: ReadonlyArray<{ recommendation: Recommendation; count: number }>): string {
  return tally.map((t) => `${RECOMMENDATION_LABELS[t.recommendation]} ×${t.count}`).join(', ');
}

/** TEAM-12, SUM-1: the panel decision where there is one, otherwise the recorded recommendations. */
export function outcomeOf(decision: PanelDecision | null, recommendations: ReadonlyArray<Recommendation | null>): RoundOutcome {
  const given = recommendations.filter((r): r is Recommendation => !!r);
  const tally = RECOMMENDATIONS.map((recommendation) => ({ recommendation, count: given.filter((g) => g === recommendation).length })).filter((t) => t.count > 0);
  const split = tally.length > 1;
  if (decision) {
    return { kind: 'decision', recommendation: decision.recommendation, tally, split, text: RECOMMENDATION_LABELS[decision.recommendation], rank: RANK[decision.recommendation] };
  }
  if (!given.length) return { kind: 'none', recommendation: null, tally, split: false, text: 'No recommendation yet', rank: null };
  const rank = given.reduce((a, r) => a + RANK[r], 0) / given.length;
  return { kind: 'recommendations', recommendation: split ? null : given[0], tally, split, text: tallyText(tally), rank };
}

/**
 * TEAM-12, SUM-1: which figure stands for the panel: the agreed scores when the decision has them,
 * else the panel's median (two or more judgements with question scores), else the one judgement,
 * else none. Judgements without question scores never count (TEAM-7).
 */
export function scoreOf(plan: Pick<InterviewPlan, 'questions' | 'categories'>, decision: PanelDecision | null, scorecards: ReadonlyArray<{ names: string[]; scorecard: Scorecard }>): { score: RoundScore; categories: Scorecard['categories'] | null; categoryMedians: Array<{ name: string; average: number | null }> | null } {
  const agreed = agreedScorecard(plan, decision);
  const members = scorecards.filter((m) => hasQuestionScores(m.scorecard));
  const panel = computePanel(members.map((m) => ({ ref: m.names, scorecard: m.scorecard })));
  const base = { members: members.length, spread: panel.spread, spreadFlag: panel.spreadFlag };
  if (agreed) {
    return {
      score: { ...base, source: 'agreed', pct: agreed.overallPct, band: agreed.band, insufficientEvidence: agreed.insufficientEvidence, capped: agreed.capApplied, label: SOURCE_LABELS.agreed },
      categories: agreed.categories,
      categoryMedians: null,
    };
  }
  if (members.length >= 2) {
    const m = panel.median;
    const categoryMedians = panel.categoryAverages.map((c) => ({ name: c.category.name, average: median(c.averages.filter((a): a is number => a != null)) }));
    return {
      score: { ...base, source: 'median', pct: m, band: m == null ? null : bandFor(m), insufficientEvidence: false, capped: false, label: `Panel median of ${members.length}` },
      categories: null,
      categoryMedians,
    };
  }
  if (members.length === 1) {
    const sc = members[0].scorecard;
    return {
      score: { ...base, source: 'single', pct: sc.overallPct, band: sc.band, insufficientEvidence: sc.insufficientEvidence, capped: sc.capApplied, label: `One interviewer (${formatNames(members[0].names)})` },
      categories: sc.categories,
      categoryMedians: null,
    };
  }
  return { score: { ...base, source: 'none', pct: null, band: null, insufficientEvidence: false, capped: false, label: SOURCE_LABELS.none }, categories: null, categoryMedians: null };
}

/** SCORE-5 applied to the figure that stands for the panel: strengths and concerns by category name. */
export function strengthsAndConcerns(
  categories: Scorecard['categories'] | null,
  categoryMedians: Array<{ name: string; average: number | null }> | null,
): { strengths: string[]; concerns: string[] } {
  if (categories) {
    return {
      strengths: categories.filter((c) => c.isStrength).sort((a, b) => (b.average ?? 0) - (a.average ?? 0)).map((c) => c.category.name),
      concerns: categories.filter((c) => c.isConcern || c.noEvidence).sort((a, b) => (a.average ?? -1) - (b.average ?? -1)).map((c) => (c.noEvidence ? `${c.category.name} (no evidence)` : c.category.name)),
    };
  }
  if (categoryMedians) {
    const known = categoryMedians.filter((c): c is { name: string; average: number } => c.average != null);
    return {
      strengths: known.filter((c) => c.average >= STRENGTH_AVERAGE - 1e-9).sort((a, b) => b.average - a.average).map((c) => c.name),
      concerns: known.filter((c) => c.average <= CONCERN_AVERAGE + 1e-9).sort((a, b) => a.average - b.average).map((c) => c.name),
    };
  }
  return { strengths: [], concerns: [] };
}

const dayOf = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * SUM-1, TEAM-6: the state of a panel and what is still missing. Only expected people count as
 * missing: an organiser's own "ready to start" record (made when planning for others) is not a
 * judgement anyone is waiting for unless the organiser is expected too.
 */
export function stateOf(args: { decision: PanelDecision | null; att: Attendance; records: readonly Session[]; submittedCount: number; date: string | null }): { state: RoundState; missing: string[] } {
  const { decision, att, records, submittedCount } = args;
  const expectedKeys = new Set(att.expected.map(nameKey));
  const counts = (s: Session) => !att.expected.length || interviewersOf(s).some((n) => expectedKeys.has(nameKey(n)));
  const running = records.some((s) => s.origin === 'local' && (s.state === 'in_progress' || s.state === 'paused') && counts(s));
  const missing: string[] = [];
  const waitText = att.toCome.length ? `Waiting for ${plural(att.toCome.length, 'judgement')}: ${formatNames(att.toCome)}` : null;
  if (decision) {
    if (waitText) missing.push(`${waitText} (decided anyway)`);
    return { state: 'decided', missing };
  }
  if (running) return { state: 'in-progress', missing: ['Interview in progress', ...(waitText && submittedCount ? [waitText] : [])] };
  if (!submittedCount) return { state: 'not-interviewed', missing: ['Not interviewed yet'] };
  if (waitText) return { state: 'waiting', missing: [waitText, 'No panel decision yet'] };
  return { state: 'no-decision', missing: ['No panel decision yet'] };
}

/** SUM-1, SUM-2, TEAM-12: everything one Summary row shows. */
export function roundRow(p: RoundPanelData): RoundRow {
  const decision = p.record?.decision ?? null;
  const submitted = p.entries.filter((e) => e.session.state === 'submitted');
  const visible = submitted.filter((e) => !e.hidden);
  const judgements: RoundJudgement[] = submitted.map((e) => ({
    session: e.session,
    names: interviewersOf(e.session),
    recommendation: e.hidden ? null : e.session.overall.recommendation,
    entered: e.session.origin === 'entered',
    hidden: e.hidden,
    scorecard: e.hidden ? null : e.scorecard,
  }));
  const outcome = outcomeOf(decision, visible.map((e) => e.session.overall.recommendation));
  const { score, categories, categoryMedians } = scoreOf(
    p.plan,
    decision,
    visible.filter((e) => e.scorecard).map((e) => ({ names: interviewersOf(e.session), scorecard: e.scorecard! })),
  );
  const { strengths, concerns } = strengthsAndConcerns(categories, categoryMedians);
  const att = attendance(p.expected, p.records);
  const { state, missing } = stateOf({ decision, att, records: p.records, submittedCount: submitted.length, date: p.date });
  const firstDay = [...p.records].map((s) => dayOf(s.startedAt) ?? dayOf(s.submittedAt)).filter((d): d is string => !!d).sort()[0] ?? null;
  const interviewers = uniqueNames([...p.expected, ...submitted.flatMap((e) => interviewersOf(e.session))]);
  return {
    ref: p.ref,
    panelKey: p.panelKey,
    candidateKey: candidateKey(p.candidate),
    candidate: formatCandidateKey(p.candidate),
    name: p.candidate.initials,
    requisition: (p.candidate.requisitionId ?? '').trim().toUpperCase(),
    trackId: p.plan.trackId,
    trackName: p.trackName,
    fingerprint: p.plan.fingerprint ?? '',
    planName: p.plan.name,
    questionCount: p.plan.questions.length,
    date: p.date ?? firstDay ?? dayOf(p.record?.createdAt) ?? dayOf(p.records[0]?.createdAt),
    time: p.date ? p.time : null,
    interviewers,
    attendance: att,
    judgements,
    decision,
    outcome,
    score,
    strengths,
    concerns,
    state,
    missing,
    hidden: submitted.filter((e) => e.hidden).length,
    summaryText: p.record?.summary?.text ?? '',
  };
}

/** "62% · Advisory: Lean no hire" style text for exports. */
export function scoreText(s: RoundScore): string {
  if (s.pct == null) return s.source === 'none' ? 'No scores' : '–';
  const band = s.insufficientEvidence ? 'insufficient evidence' : s.band ? BAND_LABELS[s.band] + (s.capped ? ' (capped)' : '') : 'no band';
  return `${formatPct(s.pct)} (${s.label}; advisory band: ${band}${s.spreadFlag ? `; spread above ${PANEL_SPREAD_LIMIT} points` : ''})`;
}

/** Recommendation rank used for sorting (4 strong hire … 1 no hire). */
export const recommendationRank = (r: Recommendation) => RANK[r];

// ---------------------------------------------------------------------------------------------
// SUM-3: the candidate page (and each candidate's part of the round report)

export interface AnswerHighlight {
  index: number;
  questionId: string;
  text: string;
  category: string;
  /** The panel's score for the question: agreed, else the median of the scores given. */
  score: number;
  /** Each interviewer's score and notes. */
  by: Array<{ names: string[]; score: number | null; notes: string[] }>;
}

export interface CandidateDetail {
  /** One column per judgement with question scores (agreed scores first, when there are any). */
  columns: Array<{ label: string; source: 'agreed' | 'judgement' }>;
  categories: Array<{ name: string; mustHave: boolean; averages: Array<number | null>; figure: number | null }>;
  strongest: AnswerHighlight[];
  weakest: AnswerHighlight[];
  flagged: Array<{ index: number; text: string; by: string[] }>;
  skipped: Array<{ index: number; text: string; by: string; reason: string }>;
}

/** SUM-3: strongest and weakest answers (3.0 or more, 2.0 or less; three each), flags, skips, categories. */
export function candidateDetail(p: Pick<RoundPanelData, 'plan' | 'entries' | 'record'>, max = 3): CandidateDetail {
  const decision = p.record?.decision ?? null;
  const agreed = agreedScorecard(p.plan, decision);
  const members = p.entries.filter((e) => !e.hidden && e.session.state === 'submitted' && e.scorecard && e.answers);
  const scored = members.filter((m) => hasQuestionScores(m.scorecard));
  const columns = [...(agreed ? [{ label: 'Agreed', source: 'agreed' as const }] : []), ...scored.map((m) => ({ label: formatNames(interviewersOf(m.session)), source: 'judgement' as const }))];
  const catNames = new Map(p.plan.categories.map((c) => [c.id, c]));
  const categories = p.plan.categories
    .filter((c) => p.plan.questions.some((q) => q.categoryId === c.id))
    .map((c) => {
      const avg = (sc: Scorecard | null) => sc?.categories.find((x) => x.category.id === c.id)?.average ?? null;
      const averages = [...(agreed ? [avg(agreed)] : []), ...scored.map((m) => avg(m.scorecard))];
      const memberAvgs = scored.map((m) => avg(m.scorecard)).filter((a): a is number => a != null);
      return { name: c.name, mustHave: c.mustHave, averages, figure: agreed ? avg(agreed) : median(memberAvgs) };
    });
  const highlights: AnswerHighlight[] = p.plan.questions.flatMap((q, index) => {
    const by = members.map((m) => {
      const a = m.answers!.find((x) => x.questionId === q.id);
      return { names: interviewersOf(m.session), score: (a && !a.skipped && a.score != null ? a.score : null) as number | null, notes: (a?.notes ?? []).map((n) => n.text.trim()).filter(Boolean) };
    });
    const given = by.map((b) => b.score).filter((s): s is number => s != null);
    const score = decision?.scores[q.id] ?? median(given);
    if (score == null) return [];
    return [{ index, questionId: q.id, text: q.text, category: catNames.get(q.categoryId)?.name ?? '', score, by: by.filter((b) => b.score != null || b.notes.length) }];
  });
  const strongest = highlights.filter((h) => h.score >= STRENGTH_AVERAGE - 1e-9).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, max);
  const weakest = highlights.filter((h) => h.score <= CONCERN_AVERAGE + 1e-9).sort((a, b) => a.score - b.score || a.index - b.index).slice(0, max);
  const flagged = p.plan.questions.flatMap((q, index) => {
    const by = members.filter((m) => m.answers!.some((a) => a.questionId === q.id && a.flagged)).map((m) => formatNames(interviewersOf(m.session)));
    return by.length ? [{ index, text: q.text, by }] : [];
  });
  const skipped = p.plan.questions.flatMap((q, index) =>
    members.flatMap((m) => {
      const a = m.answers!.find((x) => x.questionId === q.id && x.skipped);
      return a ? [{ index, text: q.text, by: formatNames(interviewersOf(m.session)), reason: a.skipReason ?? '' }] : [];
    }),
  );
  return { columns, categories, strongest, weakest, flagged, skipped };
}
