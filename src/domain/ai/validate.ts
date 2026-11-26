// AI-6: strict, hand-written validation of the model's reply (no eval-based schema libraries: CSP).
import type { QuestionSnapshot, Score } from '../types';
import { AI_LIMITS } from './types';

export interface ValidatedQuestion {
  questionId: string;
  covered: boolean;
  score: Score | null;
  /** 0-based. */
  coveredKeyPoints: number[];
  /** 0-based. */
  redFlagsSeen: number[];
  rationale: string;
  quotes: string[];
}

export type OutputValidation = { ok: true; questions: ValidatedQuestion[] } | { ok: false; errors: string[] };

const QUESTION_KEYS = ['questionId', 'covered', 'score', 'keyPointsCovered', 'redFlagsObserved', 'rationale', 'quotes'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/**
 * AI-6: checks the model output against the expected shape and the plan: one entry per planned
 * question (no unknown or repeated ids), score 1-4 or not covered, 1-based indexes in range, text
 * within the caps, no extra fields. Returns the entries in plan order with 0-based indexes, or
 * readable errors (which never quote the model's text).
 */
export function validateSecondOpinionOutput(
  output: unknown,
  questions: ReadonlyArray<Pick<QuestionSnapshot, 'id' | 'lookFor' | 'redFlags'>>,
): OutputValidation {
  const errors: string[] = [];
  if (!isPlainObject(output)) return { ok: false, errors: ['The reply is not a JSON object.'] };
  const extraTop = Object.keys(output).filter((k) => k !== 'questions');
  if (extraTop.length) errors.push(`The reply has unexpected fields: ${extraTop.slice(0, 5).join(', ')}.`);
  const items = output.questions;
  if (!Array.isArray(items)) return { ok: false, errors: [...errors, 'The reply has no list of questions.'] };

  const planIndex = new Map(questions.map((q, i) => [q.id, i]));
  const seen = new Map<string, ValidatedQuestion>();

  items.forEach((item, i) => {
    const at = `Entry ${i + 1}`;
    if (!isPlainObject(item)) {
      errors.push(`${at} is not an object.`);
      return;
    }
    const extra = Object.keys(item).filter((k) => !(QUESTION_KEYS as readonly string[]).includes(k));
    if (extra.length) errors.push(`${at} has unexpected fields: ${extra.slice(0, 5).join(', ')}.`);
    const missing = QUESTION_KEYS.filter((k) => !(k in item));
    if (missing.length) {
      errors.push(`${at} is missing: ${missing.join(', ')}.`);
      return;
    }
    const id = item.questionId;
    if (typeof id !== 'string' || !planIndex.has(id)) {
      errors.push(`${at} refers to a question that is not in the plan.`);
      return;
    }
    const qn = planIndex.get(id)! + 1;
    const label = `Question ${qn}`;
    if (seen.has(id)) {
      errors.push(`${label} appears more than once.`);
      return;
    }
    const q = questions[qn - 1];
    const before = errors.length;

    if (typeof item.covered !== 'boolean') errors.push(`${label}: "covered" must be true or false.`);
    const covered = item.covered === true;
    const score = item.score;
    if (covered) {
      if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 4) errors.push(`${label}: the score must be a whole number from 1 to 4.`);
    } else if (score !== null) {
      errors.push(`${label}: a question that is not covered must have no score.`);
    }

    const indexes = (value: unknown, count: number, what: string): number[] => {
      if (!Array.isArray(value)) {
        errors.push(`${label}: ${what} must be a list.`);
        return [];
      }
      const out: number[] = [];
      for (const v of value) {
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > count) {
          errors.push(`${label}: ${what} has a number that is not between 1 and ${count}.`);
          return [];
        }
        if (out.includes(v - 1)) {
          errors.push(`${label}: ${what} lists the same item twice.`);
          return [];
        }
        out.push(v - 1);
      }
      return out.sort((a, b) => a - b);
    };
    const coveredKeyPoints = indexes(item.keyPointsCovered, q.lookFor.length, 'the key points');
    const redFlagsSeen = indexes(item.redFlagsObserved, q.redFlags.length, 'the red flags');
    if (!covered && (coveredKeyPoints.length || redFlagsSeen.length)) errors.push(`${label}: a question that is not covered cannot have key points or red flags.`);

    const rationale = item.rationale;
    if (typeof rationale !== 'string') errors.push(`${label}: the rationale must be text.`);
    else if (rationale.length > AI_LIMITS.maxRationaleChars) errors.push(`${label}: the rationale is longer than ${AI_LIMITS.maxRationaleChars} characters.`);
    else if (covered && !rationale.trim()) errors.push(`${label}: the rationale is empty.`);

    const quotes = item.quotes;
    if (!Array.isArray(quotes)) errors.push(`${label}: the quotations must be a list.`);
    else if (quotes.length > AI_LIMITS.maxQuotes) errors.push(`${label}: more than ${AI_LIMITS.maxQuotes} quotations.`);
    else if (quotes.some((s) => typeof s !== 'string' || !s.trim() || s.length > AI_LIMITS.maxQuoteChars)) {
      errors.push(`${label}: each quotation must be text of 1 to ${AI_LIMITS.maxQuoteChars} characters.`);
    }

    if (errors.length > before) return;
    seen.set(id, {
      questionId: id,
      covered,
      score: covered ? (score as Score) : null,
      coveredKeyPoints,
      redFlagsSeen,
      rationale: (rationale as string).trim(),
      quotes: (quotes as string[]).map((s) => s.trim()),
    });
  });

  const missing = questions.map((q, i) => (items.some((it) => isPlainObject(it) && it.questionId === q.id) ? null : i + 1)).filter((n): n is number => n != null);
  if (missing.length) errors.push(`The reply has no entry for question${missing.length > 1 ? 's' : ''} ${missing.join(', ')}.`);
  if (errors.length) return { ok: false, errors };
  return { ok: true, questions: questions.map((q) => seen.get(q.id)!) };
}
