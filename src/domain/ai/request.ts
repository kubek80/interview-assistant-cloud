// AI-3, AI-5: build the request sent to the local helper, and describe it before it is sent. Pure.
//
// The builder's input is deliberately narrow: question content and the pseudonymised transcript.
// It copies named fields only, so even if a caller passes a richer object (a session, an answer,
// a plan with candidate details), nothing else can reach the payload.
import { rubricFor } from '../rubric';
import type { QuestionSnapshot } from '../types';
import type { PseudonymisedTranscript } from './pseudonymise';
import { AI_LIMITS, AI_REQUEST_VERSION, AI_SECOND_OPINION_PATH, SPEAKER_LABEL_PATTERN, type AiQuestionPayload, type SecondOpinionRequest } from './types';

/** The parts of a locked plan's question snapshot that may be sent (AI-5). */
export type AiQuestionSource = Pick<QuestionSnapshot, 'id' | 'text' | 'lookFor' | 'redFlags' | 'probes' | 'rubricOverride'> & {
  /** BANK-8; older snapshots have none. */
  description?: string;
};

export interface SecondOpinionInput {
  /** The locked plan's question snapshots, in plan order. */
  questions: readonly AiQuestionSource[];
  /** From pseudonymiseTranscript (never the raw transcript). */
  transcript: Pick<PseudonymisedTranscript, 'text' | 'speakers'>;
}

export class AiRequestError extends Error {
  readonly code: 'no-questions' | 'too-many-questions' | 'empty-transcript' | 'transcript-too-large' | 'question-too-large' | 'invalid-speaker-label';
  constructor(code: AiRequestError['code'], message: string) {
    super(message);
    this.name = 'AiRequestError';
    this.code = code;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s) => s.length > 0) : []);

function checkQuestion(q: AiQuestionPayload, index: number): void {
  const n = index + 1;
  const tooLarge = (what: string) => new AiRequestError('question-too-large', `Question ${n}: the ${what} is too long to send.`);
  if (!q.id || q.id.length > AI_LIMITS.maxIdChars) throw tooLarge('id');
  if (!q.text || q.text.length > AI_LIMITS.maxQuestionTextChars) throw tooLarge('question text');
  if (q.description.length > AI_LIMITS.maxDescriptionChars) throw tooLarge('description');
  for (const [name, items] of [['key points', q.keyPoints], ['red flags', q.redFlags], ['probes', q.probes]] as const) {
    if (items.length > AI_LIMITS.maxListItems || items.some((s) => s.length > AI_LIMITS.maxListItemChars)) throw tooLarge(name);
  }
  if (q.rubric.some((l) => l.description.length > AI_LIMITS.maxRubricDescriptionChars)) throw tooLarge('rubric');
}

/** AI-5: the payload for POST api/ai/second-opinion. Throws AiRequestError. */
export function buildSecondOpinionRequest(input: SecondOpinionInput): SecondOpinionRequest {
  if (!input.questions.length) throw new AiRequestError('no-questions', 'The plan has no questions.');
  if (input.questions.length > AI_LIMITS.maxQuestions) {
    throw new AiRequestError('too-many-questions', `The plan has more than ${AI_LIMITS.maxQuestions} questions.`);
  }
  const transcriptText = typeof input.transcript.text === 'string' ? input.transcript.text : '';
  if (!transcriptText.trim()) throw new AiRequestError('empty-transcript', 'The transcript is empty.');
  if (transcriptText.length > AI_LIMITS.maxTranscriptChars) {
    throw new AiRequestError('transcript-too-large', `The transcript is longer than ${AI_LIMITS.maxTranscriptChars.toLocaleString('en')} characters.`);
  }
  const speakers = [...input.transcript.speakers];
  if (speakers.length > AI_LIMITS.maxSpeakers || speakers.some((s) => !SPEAKER_LABEL_PATTERN.test(s))) {
    throw new AiRequestError('invalid-speaker-label', 'The transcript has not been pseudonymised.');
  }

  const questions = input.questions.map((q, i): AiQuestionPayload => {
    const payload: AiQuestionPayload = {
      id: str(q.id),
      text: str(q.text),
      description: str(q.description),
      keyPoints: list(q.lookFor),
      redFlags: list(q.redFlags),
      probes: list(q.probes),
      // RUB-1 with RUB-2 overrides. Key points and red flags go as written (BANK-15 sentences).
      rubric: rubricFor({ rubricOverride: q.rubricOverride ?? null }).map((l) => ({ score: l.score, label: l.label, description: l.description })),
    };
    checkQuestion(payload, i);
    return payload;
  });
  return { version: AI_REQUEST_VERSION, questions, transcript: { text: transcriptText, speakers } };
}

export interface PayloadCategory {
  /** e.g. "Transcript" */
  label: string;
  /** e.g. "312 lines, 5,920 words, 33 KB; speakers shown as Interviewer 1, Candidate" */
  detail: string;
}

/** AI-3: what will be sent and where, for the confirmation shown before a run. */
export interface PayloadDisclosure {
  /** Where the data goes, in plain words. */
  destination: string;
  /** The helper endpoint on this computer. */
  endpoint: string;
  sent: PayloadCategory[];
  notSent: string[];
  questionCount: number;
  keyPointCount: number;
  redFlagCount: number;
  probeCount: number;
  transcriptCharacters: number;
  transcriptWords: number;
  transcriptLines: number;
  speakerLabels: string[];
  /** Size of the request body in bytes (UTF-8). */
  totalBytes: number;
  /** The exact request body that will be sent. */
  body: string;
}

export const AI_DESTINATION =
  'The local helper on this computer passes it to Claude Code (the claude command-line tool signed in on this computer), which sends it to Anthropic under that subscription.';

export const AI_NOT_SENT: readonly string[] = [
  "The candidate's name or initials",
  'The requisition id',
  "The interviewers' names (speakers are replaced with labels)",
  'Any human score, tick or note',
  'Any recording',
];

function formatBytes(n: number): string {
  return n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
}

/** AI-3: describes `request` exactly; `body` is the string that will be POSTed. */
export function describePayload(request: SecondOpinionRequest): PayloadDisclosure {
  const body = JSON.stringify(request);
  const totalBytes = new TextEncoder().encode(body).length;
  const qs = request.questions;
  const keyPointCount = qs.reduce((n, q) => n + q.keyPoints.length, 0);
  const redFlagCount = qs.reduce((n, q) => n + q.redFlags.length, 0);
  const probeCount = qs.reduce((n, q) => n + q.probes.length, 0);
  const text = request.transcript.text;
  const transcriptWords = text.split(/\s+/).filter(Boolean).length;
  const transcriptLines = text.split('\n').length;
  const transcriptBytes = new TextEncoder().encode(text).length;
  const n = (x: number) => x.toLocaleString('en');
  const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;
  return {
    destination: AI_DESTINATION,
    endpoint: AI_SECOND_OPINION_PATH,
    sent: [
      {
        label: 'Transcript',
        detail: `${plural(transcriptLines, 'line')}, ${plural(transcriptWords, 'word')}, ${formatBytes(transcriptBytes)}; speakers shown as ${request.transcript.speakers.join(', ') || '(no speaker names)'}`,
      },
      {
        label: 'Questions from the plan',
        detail: `${plural(qs.length, 'question')} with their text and description, ${plural(keyPointCount, 'key point')}, ${plural(redFlagCount, 'red flag')}, ${plural(probeCount, 'probe')} and the rubric`,
      },
    ],
    notSent: [...AI_NOT_SENT],
    questionCount: qs.length,
    keyPointCount,
    redFlagCount,
    probeCount,
    transcriptCharacters: text.length,
    transcriptWords,
    transcriptLines,
    speakerLabels: [...request.transcript.speakers],
    totalBytes,
    body,
  };
}
