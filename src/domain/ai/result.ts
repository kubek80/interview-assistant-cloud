// AI-6, AI-7, AI-8, AI-11: turn a helper reply into a stored result, score it with the same maths
// as a human scorecard, and compare it with an interviewer's scores. Pure.
import { computeScorecard, type Scorecard } from '../scoring';
import type { Answer, InterviewPlan, QuestionSnapshot, Score } from '../types';
import type { PseudonymisedTranscript } from './pseudonymise';
import { buildQuoteIndex, verifyQuotations } from './quotes';
import type { AiQuestionResult, AiSecondOpinion, SecondOpinionResponse } from './types';
import { validateSecondOpinionOutput } from './validate';

export type CreateSecondOpinionResult = { ok: true; result: AiSecondOpinion } | { ok: false; errors: string[] };

/**
 * AI-6 + AI-8: validates the model output against the plan, verifies every quotation against the
 * transcript text that was sent, and builds the record to store. A reply that does not fit is
 * returned as errors and must never be shown as scores.
 */
export function createSecondOpinion(args: {
  plan: Pick<InterviewPlan, 'questions' | 'fingerprint'>;
  /** What was sent (from pseudonymiseTranscript); quotations are checked against it. */
  sentTranscript: Pick<PseudonymisedTranscript, 'lines' | 'sourceHash'>;
  response: Pick<SecondOpinionResponse, 'model' | 'output'> & { durationMs?: number | null };
  /** ISO timestamp; defaults to now. */
  createdAt?: string;
}): CreateSecondOpinionResult {
  const validation = validateSecondOpinionOutput(args.response.output, args.plan.questions);
  if (!validation.ok) return validation;
  const index = buildQuoteIndex(args.sentTranscript.lines);
  const questions: AiQuestionResult[] = validation.questions.map((q) => ({ ...q, quotes: verifyQuotations(q.quotes, index) }));
  const model = typeof args.response.model === 'string' && args.response.model.trim() ? args.response.model.trim().slice(0, 100) : 'unknown model';
  return {
    ok: true,
    result: {
      kind: 'ai-second-opinion',
      formatVersion: 1,
      model,
      createdAt: args.createdAt ?? new Date().toISOString(),
      transcriptHash: args.sentTranscript.sourceHash,
      planFingerprint: args.plan.fingerprint ?? null,
      durationMs: args.response.durationMs ?? null,
      questions,
      unverifiedQuoteCount: questions.reduce((n, q) => n + q.quotes.filter((x) => x.status === 'unverified').length, 0),
    },
  };
}

/** AI-8: the result is out of date when the transcript has changed (or been removed) since the run. */
export function isOutOfDate(result: Pick<AiSecondOpinion, 'transcriptHash'>, currentTranscriptHash: string | null | undefined): boolean {
  return !currentTranscriptHash || currentTranscriptHash !== result.transcriptHash;
}

/** Session id used on the synthetic answers built from an AI result. */
export const AI_SESSION_ID = 'ai-second-opinion';

/**
 * AI-7: the AI result as answers, so computeScorecard applies SCORE-1 to SCORE-8 unchanged.
 * "Not covered" becomes a skipped question: excluded from the overall % and lowering coverage (SCORE-6).
 */
export function aiAnswers(plan: Pick<InterviewPlan, 'questions'>, result: Pick<AiSecondOpinion, 'questions'>): Answer[] {
  const byId = new Map(result.questions.map((q) => [q.questionId, q]));
  return plan.questions.flatMap((question) => {
    const q = byId.get(question.id);
    if (!q) return [];
    const answer = {
      sessionId: AI_SESSION_ID,
      questionId: question.id,
      score: q.covered ? q.score : null,
      coveredKeyPoints: [...q.coveredKeyPoints],
      redFlagsSeen: [...q.redFlagsSeen],
      probeHandled: false,
      notes: [],
      flagged: false,
      skipped: !q.covered,
      skipReason: q.covered ? null : 'Not covered in the transcript',
      elapsedSec: 0,
      timer: { accumulatedMs: 0, runningSince: null },
    } satisfies Partial<Answer>;
    // Cast so that fields added to Answer later (e.g. for panels) do not break this synthetic answer.
    return [answer as Answer];
  });
}

/** AI-7: the AI's scorecard (overall %, coverage, band) with exactly the human maths. */
export function computeAiScorecard(plan: Pick<InterviewPlan, 'questions' | 'categories'>, result: Pick<AiSecondOpinion, 'questions'>): Scorecard {
  return computeScorecard(plan, aiAnswers(plan, result));
}

/** AI-11: differences of this many points or more are worth discussing. */
export const AI_DISCUSS_DIFFERENCE = 2;

export interface AiComparisonRow {
  index: number;
  question: QuestionSnapshot;
  /** The interviewer's score; null when skipped or unscored. */
  humanScore: Score | null;
  /** The AI's score; null when not covered. */
  aiScore: Score | null;
  aiCovered: boolean;
  /** aiScore - humanScore, or null when either is missing. */
  difference: number | null;
  /** |difference| >= AI_DISCUSS_DIFFERENCE. */
  worthDiscussing: boolean;
  /** The AI's full entry (rationale, quotations as evidence); null if the AI result lacks the question. */
  ai: AiQuestionResult | null;
}

export interface AiComparison {
  rows: AiComparisonRow[];
  /** AI-11: rows that differ by two points or more, in plan order. */
  worthDiscussing: AiComparisonRow[];
}

/** AI-11: per-question differences between one interviewer's scorecard and the AI result. */
export function compareWithAi(human: Pick<Scorecard, 'questions'>, ai: Pick<AiSecondOpinion, 'questions'>): AiComparison {
  const byId = new Map(ai.questions.map((q) => [q.questionId, q]));
  const rows = human.questions.map((h): AiComparisonRow => {
    const a = byId.get(h.question.id) ?? null;
    const aiScore = a?.covered ? a.score : null;
    const humanScore = h.answered ? h.score : null;
    const difference = aiScore != null && humanScore != null ? aiScore - humanScore : null;
    return {
      index: h.index,
      question: h.question,
      humanScore,
      aiScore,
      aiCovered: !!a?.covered,
      difference,
      worthDiscussing: difference != null && Math.abs(difference) >= AI_DISCUSS_DIFFERENCE,
      ai: a,
    };
  });
  return { rows, worthDiscussing: rows.filter((r) => r.worthDiscussing) };
}
