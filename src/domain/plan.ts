// Plan building helpers (docs/02-interview-flow.md, steps 2-3). Pure.
import { sha256Hex } from './sha256';
import { seededRng } from './random';
import type { Category, Difficulty, InterviewPlan, PlanCategory, Question, QuestionType } from './types';
import { QUESTION_TYPES } from './types';

export type Quotas = Record<QuestionType, number>;

/** FLOW-3 */
export const DEFAULT_QUOTAS: Readonly<Quotas> = { knowledge: 9, scenario: 2, design: 1, behavioural: 2 };
/** FLOW-3: allowed range for the knowledge ("technical") quota. */
export const KNOWLEDGE_QUOTA_RANGE: readonly [number, number] = [8, 10];
/** FLOW-4 */
export const DEFAULT_TIME_BUDGET_MIN = 60;
/** FLOW-7, PRIV-5 */
export const DEFAULT_RETENTION_DAYS = 90;
/** PRIV-4: shown verbatim when setting up an interview. */
export const CONSENT_TEXT =
  'Notes and ratings from this interview are recorded by your interviewers to support a fair, structured hiring decision. They are kept only for the period set by HR and are seen only by people involved in this hiring decision. Ratings are made by people; the tool\'s summary is advisory. You can ask to see or delete your interview record.';

/**
 * TR-4: added to the consent text when the interview will be recorded or transcribed. Verbatim
 * from docs/11-interviewers-transcripts-ai.md (a unit test keeps them identical).
 */
export const RECORDING_CONSENT_TEXT =
  'This interview is being recorded or transcribed. The transcript may be analysed by an AI tool to give your interviewers a second opinion; people still make every rating and the decision.';

/** BANK-5: expected time estimates by type and difficulty. */
export const TIME_ESTIMATES: Record<QuestionType, Partial<Record<Difficulty, number>>> = {
  knowledge: { core: 3, advanced: 4, expert: 5 },
  scenario: { core: 5, advanced: 5, expert: 6 },
  design: { core: 7, advanced: 7, expert: 8 },
  behavioural: { core: 4 },
};

export interface QuestionFilter {
  categoryIds?: readonly string[];
  difficulties?: readonly Difficulty[];
  types?: readonly QuestionType[];
  search?: string;
  /** Retired questions are never offered when building a plan; the bank screen may show them. */
  includeRetired?: boolean;
}

/** FLOW-2, BANK-2. Empty filter arrays mean "any". */
export function filterQuestions<Q extends Question>(questions: readonly Q[], f: QuestionFilter): Q[] {
  const needle = f.search?.trim().toLowerCase() ?? '';
  return questions.filter(
    (q) =>
      (f.includeRetired || q.status !== 'retired') &&
      (!f.categoryIds?.length || f.categoryIds.includes(q.categoryId)) &&
      (!f.difficulties?.length || f.difficulties.includes(q.difficulty)) &&
      (!f.types?.length || f.types.includes(q.type)) &&
      (!needle ||
        [q.text, ...q.lookFor, ...q.redFlags, ...q.probes, String(q.number)].some((s) => s.toLowerCase().includes(needle))),
  );
}

export interface UnmetQuota {
  type: QuestionType;
  wanted: number;
  got: number;
}

export interface DrawResult<Q extends Question = Question> {
  questions: Q[];
  unmet: UnmetQuota[];
}

/**
 * FLOW-3: draw at random by type quotas from an already-filtered pool, spreading picks across
 * categories (each pick goes to a category with the fewest picks so far). Never draws retired
 * questions. Result is in bank order (by question number).
 */
export function drawRandom<Q extends Question>(pool: readonly Q[], quotas: Partial<Quotas>, rng: () => number = Math.random): DrawResult<Q> {
  const available = pool.filter((q) => q.status !== 'retired');
  const picked: Q[] = [];
  const perCategory = new Map<string, number>();
  const unmet: UnmetQuota[] = [];
  const randomOf = <T>(xs: readonly T[]): T => xs[Math.min(xs.length - 1, Math.floor(rng() * xs.length))];

  for (const type of QUESTION_TYPES) {
    const wanted = Math.max(0, Math.floor(quotas[type] ?? 0));
    const remaining = available.filter((q) => q.type === type);
    let got = 0;
    while (got < wanted && remaining.length) {
      const counts = remaining.map((q) => perCategory.get(q.categoryId) ?? 0);
      const least = Math.min(...counts);
      const cats = [...new Set(remaining.filter((_, i) => counts[i] === least).map((q) => q.categoryId))].sort();
      const cat = randomOf(cats);
      const q = randomOf(remaining.filter((r) => r.categoryId === cat));
      remaining.splice(remaining.indexOf(q), 1);
      picked.push(q);
      perCategory.set(cat, (perCategory.get(cat) ?? 0) + 1);
      got++;
    }
    if (got < wanted) unmet.push({ type, wanted, got });
  }
  picked.sort((a, b) => a.number - b.number);
  return { questions: picked, unmet };
}

/**
 * FLOW-33, FLOW-3, FLOW-4: a balanced random draw that prefers a set whose time estimates fit the
 * budget. Tries a few draws (deterministic from `seed`) and keeps the first that fits, else the
 * shortest.
 */
export function drawBalanced<Q extends Question>(
  pool: readonly Q[],
  quotas: Partial<Quotas>,
  budgetMin: number,
  seed: number,
  tries = 25,
): DrawResult<Q> & { seed: number } {
  let best: (DrawResult<Q> & { seed: number }) | null = null;
  for (let i = 0; i < tries; i++) {
    const s = (seed + i * 0x9e3779b9) >>> 0;
    const draw = drawRandom(pool, quotas, seededRng(s));
    if (!best || totalTimeMin(draw.questions) < totalTimeMin(best.questions)) best = { ...draw, seed: s };
    if (totalTimeMin(draw.questions) <= budgetMin) return { ...draw, seed: s };
  }
  return best!;
}

export function quotaTotal(quotas: Partial<Quotas>): number {
  return QUESTION_TYPES.reduce((n, t) => n + (quotas[t] ?? 0), 0);
}

/** FLOW-4 */
export function totalTimeMin(questions: readonly Pick<Question, 'timeMin'>[]): number {
  return questions.reduce((n, q) => n + q.timeMin, 0);
}

export interface TimeMeter {
  totalMin: number;
  budgetMin: number;
  /** total / budget (0 when the budget is 0). */
  ratio: number;
  over: boolean;
}

export function timeMeter(questions: readonly Pick<Question, 'timeMin'>[], budgetMin: number): TimeMeter {
  const totalMin = totalTimeMin(questions);
  return { totalMin, budgetMin, ratio: budgetMin > 0 ? totalMin / budgetMin : 0, over: totalMin > budgetMin };
}

/** FLOW-5: count of selected questions per category, in category order (zero counts included). */
export function categoryCoverage(categories: readonly Category[], questions: readonly Pick<Question, 'categoryId'>[]): Array<{ category: Category; count: number }> {
  return categories.map((category) => ({ category, count: questions.filter((q) => q.categoryId === category.id).length }));
}

/** JSON with object keys sorted, so equal values always serialise identically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

/**
 * FLOW-9: SHA-256 over the track, the ordered question ids and versions, and each category's
 * weight and must-have flag. Time budget, name and question text are deliberately excluded.
 */
export function planFingerprint(plan: Pick<InterviewPlan, 'trackId' | 'questions' | 'categories'>): string {
  const payload = {
    v: 1,
    trackId: plan.trackId,
    questions: plan.questions.map((q) => [q.id, q.version]),
    categories: [...plan.categories]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((c) => [c.id, c.weight, c.mustHave]),
  };
  return sha256Hex(canonicalJson(payload));
}

/** Short form for display, e.g. "3f9a1c2b". */
export function shortFingerprint(fp: string | null | undefined): string {
  return fp ? fp.slice(0, 8) : '—';
}

/** Copies bank categories into plan categories (FLOW-6 defaults come from the seed). */
export function planCategoriesFrom(categories: readonly Category[]): PlanCategory[] {
  return categories.map((c) => ({ ...c }));
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

/** Local calendar date as YYYY-MM-DD. */
export function isoDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** FLOW-7: default retention date, 90 days ahead. */
export function defaultRetentionDate(now: Date = new Date()): string {
  return isoDate(addDays(now, DEFAULT_RETENTION_DAYS));
}

/** PRIV-1: the longest candidate name or initials. */
export const MAX_CANDIDATE = 60;
/** PRIV-1: letters in any script, spaces, hyphens, apostrophes and full stops; starts with a letter. */
const CANDIDATE_RE = /^[\p{L}\p{M}][\p{L}\p{M} '’.\-]*$/u;

/** PRIV-1: the candidate's name or initials as stored: trimmed, inner spaces collapsed. */
export function cleanCandidate(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** PRIV-1: a name or initials, 1 to 60 characters (letters, spaces, hyphens, apostrophes, full stops). */
export function isValidCandidate(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const c = cleanCandidate(raw);
  return c.length >= 1 && c.length <= MAX_CANDIDATE && CANDIDATE_RE.test(c);
}

/**
 * Candidate key used to group panels (FLOW-29) and for access/deletion requests (PRIV-6): the
 * candidate (the stored field is still called `initials`) and the requisition id, trimmed, inner
 * spaces collapsed and compared case-insensitively, so "Ana  Diaz"/"ana diaz" and "req-1"/"REQ-1"
 * from different devices group together.
 */
export function candidateKey(c: { initials: string; requisitionId: string | null | undefined }): string {
  return `${cleanCandidate(c.initials).toUpperCase()}|${cleanCandidate(c.requisitionId ?? '').toUpperCase()}`;
}

/**
 * Human-readable candidate, e.g. "Ana Diaz · REQ-123" or "AB". The name is shown as typed (trimmed);
 * the requisition id in upper case, like the key.
 */
export function formatCandidateKey(c: { initials: string; requisitionId: string | null | undefined }): string {
  const name = cleanCandidate(c.initials);
  const req = cleanCandidate(c.requisitionId ?? '').toUpperCase();
  return req ? `${name} · ${req}` : name;
}
