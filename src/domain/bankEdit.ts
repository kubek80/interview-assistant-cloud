// Pure rules for managing the question bank in the app (BANK-9…BANK-12, BANK-5, RUB-5).
import { TIME_ESTIMATES } from './plan';
import { BEHAVIOURAL_STARTING_KEY_POINTS, BEHAVIOURAL_STARTING_RED_FLAGS } from './rubric';
import { DIFFICULTIES, QUESTION_TYPES, type Difficulty, type Question, type QuestionType, type RubricOverride, type ScoreKey } from './types';

/** Limits used by the editor and the bulk import (well inside the import validators' limits). */
export const LIMITS = { text: 2000, description: 4000, item: 1000, items: 30, rubric: 2000, timeMin: 120, categoryName: 120, trackName: 200 } as const;

/** What the editor form edits; the repository adds id, number, version and status. */
export interface QuestionDraft {
  text: string;
  description: string;
  categoryId: string;
  difficulty: Difficulty;
  type: QuestionType;
  timeMin: number;
  lookFor: string[];
  redFlags: string[];
  probes: string[];
  rubricOverride: RubricOverride;
}

export type DraftField = 'text' | 'description' | 'categoryId' | 'difficulty' | 'type' | 'timeMin' | 'lookFor' | 'redFlags' | 'probes' | 'rubricOverride';
export type DraftErrors = Partial<Record<DraftField, string>>;

/** BANK-5: the time estimate for a type and difficulty (behavioural is always core, RUB-6). */
export function defaultTimeMin(type: QuestionType, difficulty: Difficulty): number {
  const d = type === 'behavioural' ? 'core' : difficulty;
  return TIME_ESTIMATES[type][d] ?? TIME_ESTIMATES[type].core ?? 3;
}

/** Trims every item and drops empty ones (blank rows in the list editor are ignored). */
export function cleanList(items: readonly string[]): string[] {
  return items.map((s) => s.trim()).filter(Boolean);
}

/** RUB-2: keeps only the levels that have text; `null` when none do. */
export function cleanRubricOverride(o: RubricOverride | undefined): RubricOverride {
  if (!o) return null;
  const out: Partial<Record<ScoreKey, string>> = {};
  for (const k of ['1', '2', '3', '4'] as const) {
    const t = o[k]?.trim();
    if (t) out[k] = t;
  }
  return Object.keys(out).length ? out : null;
}

/** Normalises a draft the way it is saved: trimmed text, clean lists, behavioural forced to core (RUB-6). */
export function normaliseDraft(d: QuestionDraft): QuestionDraft {
  return {
    text: d.text.trim(),
    description: d.description.trim(),
    categoryId: d.categoryId,
    type: d.type,
    difficulty: d.type === 'behavioural' ? 'core' : d.difficulty,
    timeMin: d.timeMin,
    lookFor: cleanList(d.lookFor),
    redFlags: cleanList(d.redFlags),
    probes: cleanList(d.probes),
    rubricOverride: cleanRubricOverride(d.rubricOverride),
  };
}

const LIST_LABEL: Record<'lookFor' | 'redFlags' | 'probes', string> = { lookFor: 'key point', redFlags: 'red flag', probes: 'probe' };

/**
 * BANK-1, BANK-9: problems by field; empty means the draft can be saved. `categoryIds` are the
 * track's categories (a new category being created with the question counts as existing).
 */
export function validateQuestionDraft(draft: QuestionDraft, categoryIds: readonly string[]): DraftErrors {
  const d = normaliseDraft(draft);
  const e: DraftErrors = {};
  if (!d.text) e.text = 'Enter the question text.';
  else if (d.text.length > LIMITS.text) e.text = `Keep the question under ${LIMITS.text} characters.`;
  if (!d.description) e.description = 'Enter a description: what the question is asking, in plain words, to steer a candidate who is stuck.';
  else if (d.description.length > LIMITS.description) e.description = `Keep the description under ${LIMITS.description} characters.`;
  if (!d.categoryId || !categoryIds.includes(d.categoryId)) e.categoryId = 'Choose a category.';
  if (!QUESTION_TYPES.includes(d.type)) e.type = 'Choose a type.';
  if (!DIFFICULTIES.includes(d.difficulty)) e.difficulty = 'Choose a difficulty.';
  if (!Number.isInteger(d.timeMin) || d.timeMin < 1 || d.timeMin > LIMITS.timeMin) e.timeMin = `Enter whole minutes from 1 to ${LIMITS.timeMin}.`;
  for (const k of ['lookFor', 'redFlags', 'probes'] as const) {
    const items = d[k];
    if (!items.length) e[k] = `Add at least one ${LIST_LABEL[k]}.`;
    else if (items.length > LIMITS.items) e[k] = `Use at most ${LIMITS.items} ${LIST_LABEL[k]}s.`;
    else if (items.some((s) => s.length > LIMITS.item)) e[k] = `Keep each ${LIST_LABEL[k]} under ${LIMITS.item} characters.`;
    else if (new Set(items.map((s) => s.toLowerCase())).size !== items.length) e[k] = `The same ${LIST_LABEL[k]} is listed twice.`;
  }
  const o = d.rubricOverride;
  if (o && Object.values(o).some((s) => (s ?? '').length > LIMITS.rubric)) e.rubricOverride = `Keep each level description under ${LIMITS.rubric} characters.`;
  return e;
}

/** The fields whose change raises a question's version (BANK-11). Category, time estimate and status do not. */
export const VERSIONED_FIELDS = ['text', 'description', 'difficulty', 'type', 'lookFor', 'redFlags', 'probes', 'rubricOverride'] as const;

type Versioned = Pick<Question, (typeof VERSIONED_FIELDS)[number]>;

/**
 * BANK-11: does saving `after` over `before` raise the version? Compares normalised values, so
 * trailing spaces, blank list rows and an empty rubric override are not changes.
 */
export function editBumpsVersion(before: Versioned, after: Versioned): boolean {
  return changedVersionedFields(before, after).length > 0;
}

/** BANK-11: which versioned fields differ (for the "this will raise the version" note). */
export function changedVersionedFields(before: Versioned, after: Versioned): Array<(typeof VERSIONED_FIELDS)[number]> {
  const norm = (q: Versioned) => ({
    text: q.text.trim(),
    description: (q.description ?? '').trim(),
    difficulty: q.type === 'behavioural' ? 'core' : q.difficulty,
    type: q.type,
    lookFor: JSON.stringify(cleanList(q.lookFor)),
    redFlags: JSON.stringify(cleanList(q.redFlags)),
    probes: JSON.stringify(cleanList(q.probes)),
    rubricOverride: JSON.stringify(cleanRubricOverride(q.rubricOverride) ?? null, ['1', '2', '3', '4']),
  });
  const a = norm(before);
  const b = norm(after);
  return VERSIONED_FIELDS.filter((k) => a[k] !== b[k]);
}

/** BANK-10: the next free number; numbers are never reused (`highWater` remembers the largest ever used). */
export function nextQuestionNumber(numbers: readonly number[], highWater = 0): number {
  return Math.max(highWater, 0, ...numbers) + 1;
}

/** Slug used in category ids, the same rule as the seed's ids ("Identity & access" → "identity-access"). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Category ids are `<trackId>-<slug of the name>` (docs/05). */
export function categoryIdFor(trackId: string, name: string): string {
  const slug = slugify(name);
  return `${trackId}-${slug || 'category'}`;
}

/** New track ids: lower-case letters and digits, starting with a letter (schema). */
export const TRACK_ID_RE = /^[a-z][a-z0-9]{0,29}$/;

/** Track versions: year.month with an optional release number (schema, BANK-6). */
export const TRACK_VERSION_RE = /^[0-9]{4}\.(0[1-9]|1[0-2])(\.[1-9][0-9]*)?$/;

/** Compares "2026.11" style versions segment by segment (numeric where possible). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-]/);
  const pb = b.split(/[.\-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    const c = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y);
    if (c !== 0) return Math.sign(c);
  }
  return 0;
}

/** "2026.11" for a date (local calendar month). */
export function monthVersion(today: Date): string {
  return `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * BANK-4: the version suggested when exporting a track. This month's "YYYY.MM" when the current
 * version is from an earlier month; otherwise the next release number in the month
 * ("2026.11" → "2026.11.1", "2026.11.1" → "2026.11.2").
 */
export function suggestNextVersion(current: string, today: Date): string {
  const month = monthVersion(today);
  if (!TRACK_VERSION_RE.test(current)) return month;
  if (compareVersions(month, current) > 0) return month;
  const [y, m, n] = current.split('.');
  return `${y}.${m}.${Number(n ?? 0) + 1}`;
}

/** Problem with a version typed in the export dialog, or null when it can be used. */
export function trackVersionProblem(version: string, current: string): string | null {
  if (!TRACK_VERSION_RE.test(version)) return 'Use year.month with an optional release number, for example 2026.11 or 2026.11.2.';
  if (compareVersions(version, current) < 0) return `Use ${current} or a later version, so devices load it (BANK-6).`;
  return null;
}

/**
 * RUB-5: the behavioural starting items first, then the question's own (without repeating one it
 * already lists, ignoring case), for a new behavioural question to be reworded in the editor.
 */
export function withBehaviouralStartingItems(lookFor: readonly string[], redFlags: readonly string[]): { lookFor: string[]; redFlags: string[] } {
  const norm = (s: string) => s.trim().toLowerCase();
  const merge = (start: readonly string[], own: readonly string[]) => {
    const seen = new Set(start.map(norm));
    return [...start, ...cleanList(own).filter((s) => !seen.has(norm(s)))];
  };
  return { lookFor: merge(BEHAVIOURAL_STARTING_KEY_POINTS, lookFor), redFlags: merge(BEHAVIOURAL_STARTING_RED_FLAGS, redFlags) };
}

/**
 * RUB-5: the editor offers the starting items while a behavioural question has no key points yet
 * (a new question, or one whose lists were cleared); never over items already written.
 */
export function offersBehaviouralStartingItems(type: QuestionDraft['type'], lookFor: readonly string[]): boolean {
  return type === 'behavioural' && lookFor.every((s) => !s.trim());
}

/** An empty draft for "Add question" (time estimate from BANK-5). */
export function emptyDraft(categoryId = ''): QuestionDraft {
  return {
    text: '',
    description: '',
    categoryId,
    difficulty: 'core',
    type: 'knowledge',
    timeMin: defaultTimeMin('knowledge', 'core'),
    lookFor: [''],
    redFlags: [''],
    probes: [''],
    rubricOverride: null,
  };
}

/** The editable part of a stored question. */
export function draftFromQuestion(q: Question): QuestionDraft {
  return {
    text: q.text,
    description: q.description ?? '',
    categoryId: q.categoryId,
    difficulty: q.difficulty,
    type: q.type,
    timeMin: q.timeMin,
    lookFor: [...q.lookFor],
    redFlags: [...q.redFlags],
    probes: [...q.probes],
    rubricOverride: q.rubricOverride ? { ...q.rubricOverride } : null,
  };
}
