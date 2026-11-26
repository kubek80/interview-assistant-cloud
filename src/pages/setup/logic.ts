// Pure helpers for the New interview screen (FLOW-2..9, FLOW-33). Kept free of React so they can be unit tested.
import { KNOWLEDGE_QUOTA_RANGE, MAX_CANDIDATE, type Quotas, type UnmetQuota } from '../../domain/plan';
import { DIFFICULTY_LABEL, TYPE_LABEL } from '../../domain/rubric';
import { QUESTION_TYPES, type Question, type QuestionType } from '../../domain/types';
import type { CandidateInput } from '../../domain/validation';

/** Quota inputs are edited as text so a half-typed value is not lost. */
export type QuotaText = Record<QuestionType, string>;

export const MAX_QUOTA = 20;
export const MIN_WEIGHT = 0.1;
export const MAX_WEIGHT = 10;
export const MAX_BUDGET_MIN = 600;

export function quotasToText(q: Quotas): QuotaText {
  return { knowledge: String(q.knowledge), scenario: String(q.scenario), design: String(q.design), behavioural: String(q.behavioural) };
}

/**
 * FLOW-3: validates the quota inputs. Knowledge ("technical") must stay within 8-10; the other
 * types take any whole number from 0 to MAX_QUOTA.
 */
export function parseQuotas(text: QuotaText): { quotas: Quotas | null; errors: Partial<Record<QuestionType, string>> } {
  const errors: Partial<Record<QuestionType, string>> = {};
  const quotas = {} as Quotas;
  const [kMin, kMax] = KNOWLEDGE_QUOTA_RANGE;
  for (const type of QUESTION_TYPES) {
    const raw = text[type].trim();
    const n = Number(raw);
    const [min, max] = type === 'knowledge' ? [kMin, kMax] : [0, MAX_QUOTA];
    if (!raw || !Number.isInteger(n) || n < min || n > max) {
      errors[type] = `${MIX_LABEL[type]}: choose ${min} to ${max}.`;
    } else {
      quotas[type] = n;
    }
  }
  return Object.keys(errors).length ? { quotas: null, errors } : { quotas, errors };
}

/** FLOW-6: a category weight typed by the user. */
export function parseWeight(raw: string): { value: number | null; error: string | null } {
  const t = raw.trim().replace(',', '.');
  const n = Number(t);
  if (!t || !Number.isFinite(n)) return { value: null, error: 'Enter a number, for example 1.0 or 1.5.' };
  if (n < MIN_WEIGHT || n > MAX_WEIGHT) return { value: null, error: `Use a weight from ${MIN_WEIGHT} to ${MAX_WEIGHT}.` };
  return { value: Math.round(n * 100) / 100, error: null };
}

/** FLOW-4: the time budget in whole minutes. */
export function parseBudget(raw: string): { value: number | null; error: string | null } {
  const t = raw.trim();
  const n = Number(t);
  if (!t || !Number.isInteger(n) || n < 1 || n > MAX_BUDGET_MIN) return { value: null, error: `Enter whole minutes from 1 to ${MAX_BUDGET_MIN}.` };
  return { value: n, error: null };
}

/** Moves the item at `from` by `delta` places, clamped to the list. Returns a new array. */
export function moveItem<T>(xs: readonly T[], from: number, delta: number): T[] {
  const to = Math.max(0, Math.min(xs.length - 1, from + delta));
  if (from < 0 || from >= xs.length || to === from) return [...xs];
  const next = [...xs];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Hand pick (FLOW-3): adds to the end or removes, keeping the order of the rest. */
export function toggleSelected(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** Where a problem that blocks "Continue" is shown, in screen order (FLOW-33). */
export type ContinueField = 'name' | 'initials' | 'questions' | 'budget' | 'otherInterviewers' | 'requisitionId' | 'retentionUntil' | 'weights' | 'setName';

export interface ContinueProblem {
  field: ContinueField;
  message: string;
}

/**
 * FLOW-33, FLOW-7, FLOW-8: everything that blocks "Continue", in screen order. Over budget is a
 * warning only (FLOW-4) and does not block. Consent is confirmed later, on the ready screen.
 */
export function continueProblems(opts: {
  questionCount: number;
  budgetError?: string | null;
  /** FLOW-6: true when any category weight input is invalid. */
  weightsInvalid?: boolean;
  setNameMissing?: boolean;
  candidateErrors: Partial<Record<keyof CandidateInput, string>>;
}): ContinueProblem[] {
  const c = opts.candidateErrors;
  const problems: ContinueProblem[] = [];
  if (c.interviewerName) problems.push({ field: 'name', message: 'Enter your name.' });
  if (c.initials) problems.push({ field: 'initials', message: c.initials });
  if (opts.questionCount === 0) problems.push({ field: 'questions', message: 'Add at least one question.' });
  if (opts.budgetError) problems.push({ field: 'budget', message: `Time budget: ${opts.budgetError}` });
  if (c.requisitionId) problems.push({ field: 'requisitionId', message: c.requisitionId });
  if (c.otherInterviewers) problems.push({ field: 'otherInterviewers', message: c.otherInterviewers });
  if (c.retentionUntil) problems.push({ field: 'retentionUntil', message: c.retentionUntil });
  if (opts.setNameMissing) problems.push({ field: 'setName', message: 'Give the question set a name.' });
  if (opts.weightsInvalid) problems.push({ field: 'weights', message: 'Fix the category weights marked below.' });
  return problems;
}

/** The kinds of question in an interviewer's words (UX-8), singular and plural. */
export const TYPE_WORDS: Record<QuestionType, [string, string]> = {
  knowledge: ['knowledge question', 'knowledge questions'],
  scenario: ['scenario', 'scenarios'],
  design: ['design exercise', 'design exercises'],
  behavioural: ['behavioural question', 'behavioural questions'],
};

/** Labels of the mix steppers (FLOW-3 quotas in plain words). */
export const MIX_LABEL: Record<QuestionType, string> = {
  knowledge: 'Knowledge questions',
  scenario: 'Scenarios',
  design: 'Design exercises',
  behavioural: 'Behavioural',
};

const plural = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;

/** FLOW-33: the mix in words, e.g. "9 knowledge questions, 2 scenarios, 1 design exercise and 2 behavioural questions". */
export function mixInWords(questions: readonly Pick<Question, 'type'>[]): string {
  const parts = QUESTION_TYPES.map((t) => [t, questions.filter((q) => q.type === t).length] as const)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => plural(n, TYPE_WORDS[t]));
  if (parts.length <= 1) return parts[0] ?? 'No questions yet';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** FLOW-3: a quota that could not be met, in words. */
export function shortfallInWords(unmet: readonly UnmetQuota[]): string | null {
  if (!unmet.length) return null;
  const parts = unmet.map((u) => `${u.got} of ${plural(u.wanted, TYPE_WORDS[u.type])}`);
  return `Not enough questions in the bank for this mix: the set has ${parts.join(', ')}.`;
}

/** FLOW-3: the allowed range of each kind in the mix (knowledge 8-10, FLOW-3). */
export function mixRange(type: QuestionType): [number, number] {
  return type === 'knowledge' ? [...KNOWLEDGE_QUOTA_RANGE] : [0, MAX_QUOTA];
}

/** One line per question, in words: "Knowledge · Advanced · Test strategy · 4 min" (RUB-6 without letter codes, UX-8). */
export function questionMeta(q: Pick<Question, 'type' | 'difficulty' | 'timeMin'>, categoryName: string): string {
  const parts = [TYPE_LABEL[q.type]];
  if (q.type !== 'behavioural') parts.push(DIFFICULTY_LABEL[q.difficulty]);
  if (categoryName) parts.push(categoryName);
  parts.push(`${q.timeMin} min`);
  return parts.join(' · ');
}

/** Moves the item at `from` to `to` (drag and drop). Returns a new array. */
export function moveTo<T>(xs: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= xs.length) return [...xs];
  const target = Math.max(0, Math.min(xs.length - 1, to));
  return moveItem(xs, from, target - from);
}

/** PRIV-1: the candidate's name or initials as typed, at most 60 characters (checked on Continue). */
export function normaliseInitials(raw: string): string {
  return raw.slice(0, MAX_CANDIDATE);
}
