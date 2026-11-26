// TEAM-7…TEAM-12: judgements entered by hand and the panel decision. Pure; covered by decision.test.ts.
import { computeScorecard, median, type Scorecard } from './scoring';
import { MAX_INTERVIEWERS, cleanName, interviewersOf, nameKey } from './interviewers';
import type { Answer, InterviewPlan, PanelDecision, Recommendation, Score, Session } from './types';
import { RECOMMENDATIONS, RECOMMENDATION_LABELS, SCORES } from './types';

/** Longest rationale (decision or judgement) and written summary accepted. */
export const MAX_RATIONALE = 5000;
export const MAX_SUMMARY = 10_000;
/** Longest note per question in a judgement entered by hand. */
export const MAX_ENTERED_NOTE = 2000;

const isScore = (v: unknown): v is Score => SCORES.includes(v as Score);

// ---------------------------------------------------------------------------------------------
// Judgements entered by hand (TEAM-7, TEAM-8)

export interface EnteredJudgementInput {
  /** The interviewer on whose behalf it is entered. */
  name: string;
  rating: Score | null;
  recommendation: Recommendation | null;
  rationale: string;
  /** Question id → score; questions left out (or null) are not scored, like skipped ones (SCORE-3, SCORE-6). */
  scores: Record<string, Score | null | undefined>;
  /** Question id → what they noted (optional). */
  notes: Record<string, string | undefined>;
}

export type JudgementErrors = Partial<Record<'name' | 'rating' | 'recommendation' | 'rationale' | 'scores', string>>;

/**
 * TEAM-7: what must be filled in: the name, overall rating, recommendation and rationale (as for a
 * judgement made in the app, FLOW-22). Question scores and notes are optional. `taken` are the names
 * that already have a judgement in this panel (compared ignoring case and spaces).
 */
export function judgementProblems(input: EnteredJudgementInput, plan: Pick<InterviewPlan, 'questions'>, taken: readonly string[] = []): JudgementErrors {
  const e: JudgementErrors = {};
  const name = cleanName(input.name);
  if (!name) e.name = 'Enter the interviewer’s name.';
  else if (name.length > 200) e.name = 'The name is too long.';
  else if (taken.some((t) => nameKey(t) === nameKey(name))) e.name = `${name} already has a judgement for this interview. Correct that one instead.`;
  if (!isScore(input.rating)) e.rating = 'Choose their overall rating.';
  if (!input.recommendation || !RECOMMENDATIONS.includes(input.recommendation)) e.recommendation = 'Choose their recommendation.';
  if (!input.rationale.trim()) e.rationale = 'Write their rationale, even one sentence.';
  else if (input.rationale.length > MAX_RATIONALE) e.rationale = `Keep it under ${MAX_RATIONALE} characters.`;
  const ids = new Set(plan.questions.map((q) => q.id));
  const bad = Object.entries(input.scores).some(([id, v]) => !ids.has(id) || (v != null && !isScore(v)));
  const badNote = Object.entries(input.notes).some(([id, v]) => !ids.has(id) || (v ?? '').length > MAX_ENTERED_NOTE);
  if (bad || badNote) e.scores = 'Some question scores or notes are not valid.';
  return e;
}

/** TEAM-7: the answers stored for a judgement entered by hand: only questions with a score or a note. */
export function enteredAnswers(sessionId: string, plan: Pick<InterviewPlan, 'questions'>, input: Pick<EnteredJudgementInput, 'scores' | 'notes'>): Answer[] {
  return plan.questions.flatMap((q) => {
    const score = input.scores[q.id];
    const note = (input.notes[q.id] ?? '').trim();
    if (!isScore(score) && !note) return [];
    return [
      {
        sessionId,
        questionId: q.id,
        score: isScore(score) ? score : null,
        coveredKeyPoints: [],
        redFlagsSeen: [],
        probeHandled: false,
        notes: note ? [{ atSec: 0, text: note }] : [],
        flagged: false,
        skipped: false,
        skipReason: null,
        elapsedSec: 0,
        timer: { accumulatedMs: 0, runningSince: null },
      },
    ];
  });
}

/** TEAM-8: "Entered by Olive on behalf of Cy Third". */
export function enteredLabel(s: Pick<Session, 'origin' | 'enteredBy' | 'interviewer' | 'interviewers'>): string | null {
  if (s.origin !== 'entered') return null;
  return `Entered by ${s.enteredBy ?? 'someone'} on behalf of ${interviewersOf(s).join(', ')}`;
}

/** TEAM-7: a judgement with no question scores has no percentage and is left out of the panel score. */
export function hasQuestionScores(sc: Pick<Scorecard, 'answeredCount'> | null | undefined): boolean {
  return !!sc && sc.answeredCount > 0;
}

// ---------------------------------------------------------------------------------------------
// Panel decision (TEAM-9…TEAM-12)

export interface DecisionInput {
  recommendation: Recommendation | null;
  rationale: string;
  participants: string[];
  rating: Score | null;
  /** Question id → agreed score; questions not set are left out. */
  scores: Record<string, Score | null | undefined>;
}

export type DecisionErrors = Partial<Record<'recommendation' | 'rationale' | 'participants' | 'rating' | 'scores', string>>;

/** TEAM-9: the agreed recommendation and its rationale are required; who took part needs at least one name. */
export function decisionProblems(input: DecisionInput, plan: Pick<InterviewPlan, 'questions'>): DecisionErrors {
  const e: DecisionErrors = {};
  if (!input.recommendation || !RECOMMENDATIONS.includes(input.recommendation)) e.recommendation = 'Choose the agreed recommendation.';
  if (!input.rationale.trim()) e.rationale = 'Write why, even one sentence.';
  else if (input.rationale.length > MAX_RATIONALE) e.rationale = `Keep it under ${MAX_RATIONALE} characters.`;
  const names = input.participants.map(cleanName).filter(Boolean);
  if (!names.length) e.participants = 'Name at least one person who took part.';
  else if (names.length > 2 * MAX_INTERVIEWERS) e.participants = `At most ${2 * MAX_INTERVIEWERS} people.`;
  else if (new Set(names.map(nameKey)).size !== names.length) e.participants = 'Each person once.';
  else if (names.some((n) => n.length > 200)) e.participants = 'A name is too long.';
  if (input.rating != null && !isScore(input.rating)) e.rating = 'Choose a rating from 1 to 4.';
  const ids = new Set(plan.questions.map((q) => q.id));
  if (Object.entries(input.scores).some(([id, v]) => !ids.has(id) || (v != null && !isScore(v)))) e.scores = 'Some agreed scores are not valid.';
  return e;
}

/** The decision as stored, from valid input (names cleaned, unset scores dropped). */
export function cleanDecision(input: DecisionInput): Pick<PanelDecision, 'recommendation' | 'rationale' | 'participants' | 'rating' | 'scores'> {
  const scores: Record<string, Score> = {};
  for (const [id, v] of Object.entries(input.scores)) if (isScore(v)) scores[id] = v;
  const seen = new Set<string>();
  const participants = input.participants.map(cleanName).filter((n) => n && !seen.has(nameKey(n)) && seen.add(nameKey(n)));
  return { recommendation: input.recommendation!, rationale: input.rationale.trim(), participants, rating: input.rating ?? null, scores };
}

const DECISION_FIELDS = ['recommendation', 'rationale', 'participants', 'rating', 'scores'] as const;

/** TEAM-11, TEAM-13: the fields that differ between two decisions (empty when they agree). */
export function decisionChanges(a: Pick<PanelDecision, (typeof DECISION_FIELDS)[number]>, b: Pick<PanelDecision, (typeof DECISION_FIELDS)[number]>): Array<(typeof DECISION_FIELDS)[number]> {
  const norm = (d: typeof a, k: (typeof DECISION_FIELDS)[number]) =>
    k === 'scores' ? JSON.stringify(Object.entries(d.scores ?? {}).sort(([x], [y]) => x.localeCompare(y))) : k === 'participants' ? JSON.stringify(d.participants.map(nameKey)) : JSON.stringify(d[k] ?? null);
  return DECISION_FIELDS.filter((k) => norm(a, k) !== norm(b, k));
}

/**
 * TEAM-9: "Start from the panel's median": per question, the median of the individual scores given
 * (skipped and unscored questions left out), rounded half up to a whole score. Questions nobody
 * scored stay empty. Never applied without that click.
 */
export function medianScores(plan: Pick<InterviewPlan, 'questions'>, members: ReadonlyArray<readonly Answer[]>): Record<string, Score> {
  const out: Record<string, Score> = {};
  for (const q of plan.questions) {
    const given = members.flatMap((answers) => answers.filter((a) => a.questionId === q.id && !a.skipped && isScore(a.score)).map((a) => a.score as number));
    const m = median(given);
    if (m != null) out[q.id] = Math.min(4, Math.max(1, Math.floor(m + 0.5))) as Score;
  }
  return out;
}

/** TEAM-9, TEAM-12: the agreed per-question scores as answers, so the usual maths applies (SCORE-1…8). */
export function agreedAnswers(plan: Pick<InterviewPlan, 'questions'>, decision: Pick<PanelDecision, 'scores'>): Answer[] {
  return enteredAnswers('agreed', plan, { scores: decision.scores, notes: {} });
}

/** TEAM-12: the scorecard of the agreed scores, or null when the decision has none. */
export function agreedScorecard(plan: Pick<InterviewPlan, 'questions' | 'categories'>, decision: Pick<PanelDecision, 'scores'> | null | undefined): Scorecard | null {
  if (!decision || !Object.keys(decision.scores).length) return null;
  return computeScorecard(plan, agreedAnswers(plan, decision));
}

export const recommendationLabel = (r: Recommendation | null | undefined) => (r ? RECOMMENDATION_LABELS[r] : '–');
