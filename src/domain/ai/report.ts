// AI-7, AI-8, AI-10, AI-11: one view of a stored AI second opinion next to the interviewers'
// scorecard, used by the scorecard screen and by the exports. Pure.
//
// AI-10: everything here READS the human scorecard and the AI result and returns new objects.
// No function changes an answer, the overall assessment, the recommendation or the human scorecard.
import type { Scorecard } from '../scoring';
import type { InterviewPlan } from '../types';
import { compareWithAi, computeAiScorecard, isOutOfDate, type AiComparison, type AiComparisonRow } from './result';
import { CANDIDATE_LABEL, type AiQuotation, type AiSecondOpinion } from './types';

/** AI-11: the label used everywhere the AI result is shown or exported. */
export const AI_LABEL = 'AI second opinion';
export const AI_NOT_A_DECISION = 'not a decision';

export interface AiReport {
  result: AiSecondOpinion;
  /** AI-7: the AI's own scorecard (same maths as a human scorecard). Never merged with the human one. */
  aiScorecard: Scorecard;
  /** AI-11 */
  comparison: AiComparison;
  /** AI-8: the transcript changed (or was removed) since the run. */
  outOfDate: boolean;
}

export function buildAiReport(
  plan: Pick<InterviewPlan, 'questions' | 'categories'>,
  human: Pick<Scorecard, 'questions'>,
  result: AiSecondOpinion,
  currentTranscriptHash: string | null,
): AiReport {
  return {
    result,
    aiScorecard: computeAiScorecard(plan, result),
    comparison: compareWithAi(human, result),
    outOfDate: isOutOfDate(result, currentTranscriptHash),
  };
}

/** AI-11: the heading text, e.g. "AI second opinion (claude-sonnet-5-5), not a decision". */
export function aiHeading(model: string): string {
  return `${AI_LABEL} (${model}), ${AI_NOT_A_DECISION}`;
}

/** AI-6: a verified quotation whose words are not the candidate's (an interviewer or another speaker). */
export function isNotCandidateQuote(q: Pick<AiQuotation, 'status' | 'speaker'>): boolean {
  return q.status === 'verified' && !!q.speaker && q.speaker !== CANDIDATE_LABEL;
}

export type TickAgreement = 'both' | 'interviewers-only' | 'ai-only' | 'neither';

export interface TickComparison {
  index: number;
  text: string;
  /** Ticked by the interviewers (human record). */
  human: boolean;
  /** Judged covered / observed by the AI. */
  ai: boolean;
  agreement: TickAgreement;
}

function ticks(items: readonly string[], human: readonly number[], ai: readonly number[]): TickComparison[] {
  return items.map((text, index) => {
    const h = human.includes(index);
    const a = ai.includes(index);
    return { index, text, human: h, ai: a, agreement: h && a ? 'both' : h ? 'interviewers-only' : a ? 'ai-only' : 'neither' };
  });
}

/** AI-11: key points and red flags as ticked by the interviewers and as judged by the AI. */
export function compareTicks(row: AiComparisonRow, humanAnswer: { coveredKeyPoints: readonly number[]; redFlagsSeen: readonly number[] } | undefined) {
  return {
    keyPoints: ticks(row.question.lookFor, humanAnswer?.coveredKeyPoints ?? [], row.ai?.coveredKeyPoints ?? []),
    redFlags: ticks(row.question.redFlags, humanAnswer?.redFlagsSeen ?? [], row.ai?.redFlagsSeen ?? []),
  };
}

/** "+2", "-1", "0", or null. */
export function formatDifference(d: number | null): string | null {
  if (d == null) return null;
  return d > 0 ? `+${d}` : String(d);
}
