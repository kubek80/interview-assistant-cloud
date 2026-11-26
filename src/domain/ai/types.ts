// AI second opinion (docs/11-interviewers-transcripts-ai.md, AI-1 to AI-11): shared types and limits.
// The same limits are enforced by the local helper (server/lib/contract.mjs); keep them in step.
import type { Score } from '../types';

/** Version of the request the browser sends to the helper. */
export const AI_REQUEST_VERSION = 1;
/** Path of the helper endpoints, relative to the app (same origin; CSP connect-src 'self'). */
export const AI_STATUS_PATH = 'api/ai/status';
export const AI_SECOND_OPINION_PATH = 'api/ai/second-opinion';
/** Custom header required on every helper request (AI-4: blocks cross-site "simple" requests). */
export const AI_CLIENT_HEADER = 'X-Interview-Assistant';
export const AI_CLIENT_HEADER_VALUE = '1';

export const AI_LIMITS = {
  maxQuestions: 60,
  maxQuestionTextChars: 2_000,
  maxDescriptionChars: 4_000,
  maxListItems: 30,
  maxListItemChars: 600,
  maxRubricDescriptionChars: 1_500,
  maxIdChars: 100,
  /** Same as MAX_TRANSCRIPT_CHARS: one call covers the whole interview; there is no chunking. */
  maxTranscriptChars: 500_000,
  maxSpeakers: 20,
  /** Request body limit at the helper (bytes). */
  maxRequestBytes: 3 * 1024 * 1024,
  // Response caps (AI-6).
  maxRationaleChars: 600,
  maxQuotes: 3,
  maxQuoteChars: 300,
} as const;

/** AI-5: the only speaker labels that may be sent. */
export const CANDIDATE_LABEL = 'Candidate';
export const SPEAKER_LABEL_PATTERN = /^(Candidate|Interviewer [1-9]\d?|Other speaker [1-9]\d?)$/;
export type SpeakerLabel = 'Candidate' | `Interviewer ${number}` | `Other speaker ${number}`;

// ---------------------------------------------------------------------------------------------
// Request (browser → helper). Built only by buildSecondOpinionRequest.

export interface AiRubricLevel {
  score: Score;
  label: string;
  description: string;
}

export interface AiQuestionPayload {
  /** The plan's question id (opaque, e.g. "qa-017"). */
  id: string;
  text: string;
  description: string;
  keyPoints: string[];
  redFlags: string[];
  probes: string[];
  /** RUB-1 with the question's RUB-2 override applied. */
  rubric: AiRubricLevel[];
}

export interface SecondOpinionRequest {
  version: typeof AI_REQUEST_VERSION;
  /** In plan order. */
  questions: AiQuestionPayload[];
  transcript: {
    /** Pseudonymised plain text, one turn per line: "[hh:mm:ss] Candidate: ...". */
    text: string;
    /** Labels used in the text, e.g. ["Interviewer 1", "Candidate"]. */
    speakers: string[];
  };
}

// ---------------------------------------------------------------------------------------------
// Response (helper → browser)

/** What the model returns, per the JSON Schema the helper passes to the CLI. Indexes are 1-based. */
export interface AiModelQuestionOutput {
  questionId: string;
  covered: boolean;
  score: Score | null;
  keyPointsCovered: number[];
  redFlagsObserved: number[];
  rationale: string;
  quotes: string[];
}

export interface AiModelOutput {
  questions: AiModelQuestionOutput[];
}

/** Successful helper reply. `output` is unvalidated model output: always pass it through validateSecondOpinionOutput. */
export interface SecondOpinionResponse {
  ok: true;
  /** Model reported by the Claude Code CLI (e.g. "claude-sonnet-5-5"). */
  model: string;
  durationMs: number;
  output: unknown;
}

// ---------------------------------------------------------------------------------------------
// Validated, stored result (AI-6, AI-8)

export type QuotationStatus = 'verified' | 'unverified';

export interface AiQuotation {
  text: string;
  status: QuotationStatus;
  /** 1-based line of the sent transcript where the quotation starts; null when unverified. */
  line: number | null;
  /** Speaker label of that line ("Candidate", "Interviewer 1"), or null. */
  speaker: string | null;
}

export interface AiQuestionResult {
  questionId: string;
  /** False: "not covered in the transcript" (treated like a skipped question, AI-7). */
  covered: boolean;
  /** 1-4 when covered, null when not covered. */
  score: Score | null;
  /** 0-based indexes into the question's lookFor (same convention as Answer.coveredKeyPoints). */
  coveredKeyPoints: number[];
  /** 0-based indexes into the question's redFlags (same convention as Answer.redFlagsSeen). */
  redFlagsSeen: number[];
  rationale: string;
  quotes: AiQuotation[];
}

/** AI-8: one stored AI second opinion for an interview. */
export interface AiSecondOpinion {
  kind: 'ai-second-opinion';
  formatVersion: 1;
  model: string;
  /** ISO timestamp of the run. */
  createdAt: string;
  /** Transcript.hash of the stored transcript the run was based on. */
  transcriptHash: string;
  /** The plan's fingerprint (FLOW-9), when it has one. */
  planFingerprint: string | null;
  durationMs: number | null;
  /** In plan order, exactly one per planned question. */
  questions: AiQuestionResult[];
  /** Number of quotations that could not be found in the transcript (AI-6). */
  unverifiedQuoteCount: number;
}
