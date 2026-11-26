// BANK-9…BANK-14: managing the question bank in the app. Every change is saved straight away,
// recorded in the audit log with the values before and after (no candidate data), and marks the
// track as having unexported changes. Screens call these; they never write to the bank directly.
import { db } from './db';
import { RepoError, appendAudit, clock } from './util';
import { bankTables, markTrackChanged, trackMetaOf } from './bank';
import {
  LIMITS,
  TRACK_ID_RE,
  TRACK_VERSION_RE,
  categoryIdFor,
  changedVersionedFields,
  monthVersion,
  nextQuestionNumber,
  normaliseDraft,
  validateQuestionDraft,
  type QuestionDraft,
} from '../domain/bankEdit';
import type { Category, Question, QuestionStatus } from '../domain/types';

export interface CategoryInput {
  name: string;
  weight?: number;
  mustHave?: boolean;
}

/** FLOW-6 uses the same range for plan weights. */
export const WEIGHT_RANGE = [0.1, 10] as const;

function categoryProblems(name: string, weight: number, others: readonly Category[], selfId?: string): string[] {
  const p: string[] = [];
  const n = name.trim();
  if (!n) p.push('Enter a category name.');
  else if (n.length > LIMITS.categoryName) p.push(`Keep the name under ${LIMITS.categoryName} characters.`);
  else if (others.some((c) => c.id !== selfId && c.name.trim().toLowerCase() === n.toLowerCase())) p.push(`There is already a category called “${n}”.`);
  if (!(weight >= WEIGHT_RANGE[0] && weight <= WEIGHT_RANGE[1])) p.push(`Use a weight from ${WEIGHT_RANGE[0]} to ${WEIGHT_RANGE[1]}.`);
  return p;
}

/** Creates a category inside a running bank transaction. Returns it. */
async function insertCategory(trackId: string, input: CategoryInput): Promise<Category> {
  const others = await db.categories.where('trackId').equals(trackId).toArray();
  const weight = input.weight ?? 1;
  const problems = categoryProblems(input.name, weight, others);
  if (problems.length) throw new RepoError('invalid', problems[0], problems);
  let id = categoryIdFor(trackId, input.name);
  // Ids are never reused: a clash (for example "C++" and "C") gets a numeric suffix.
  for (let i = 2; (await db.categories.get(id)) || others.some((c) => c.id === id); i++) id = `${categoryIdFor(trackId, input.name)}-${i}`;
  const category: Category = { id, trackId, name: input.name.trim(), weight, mustHave: !!input.mustHave };
  await db.categories.add(category);
  const meta = await trackMetaOf(trackId);
  await markTrackChanged(trackId, { categoryOrder: [...meta.categoryOrder.filter((x) => x !== id), id] });
  await appendAudit({ action: 'bank.category_added', entity: 'category', entityId: id, after: { trackId, name: category.name, weight, mustHave: category.mustHave } });
  return category;
}

async function requireTrack(trackId: string) {
  const track = await db.tracks.get(trackId);
  if (!track) throw new RepoError('not-found', 'Track not found.');
  return track;
}

export interface SaveQuestionInput {
  trackId: string;
  /** Edit this question; omit to add a new one (BANK-10 numbering). */
  id?: string;
  draft: QuestionDraft;
  /** Create this category with the question and file the question under it. */
  newCategory?: CategoryInput;
}

export interface SaveQuestionResult {
  id: string;
  number: number;
  version: number;
  /** BANK-11: true when the save raised the version. */
  bumped: boolean;
  /** False when an edit changed nothing (nothing is written or audited). */
  changed: boolean;
}

const EDITABLE: Array<keyof QuestionDraft> = ['text', 'description', 'categoryId', 'difficulty', 'type', 'timeMin', 'lookFor', 'redFlags', 'probes', 'rubricOverride'];

/**
 * BANK-9…BANK-11: adds or edits a question. New questions get the next free number in their track
 * (never reused). An edit that changes the text, description, difficulty, type, lists or rubric
 * descriptions raises the version by one; category and time estimate changes do not.
 */
export async function saveQuestion(input: SaveQuestionInput): Promise<SaveQuestionResult> {
  return db.transaction('rw', bankTables(), async () => {
    await requireTrack(input.trackId);
    let draft = input.draft;
    if (input.newCategory) {
      const created = await insertCategory(input.trackId, input.newCategory);
      draft = { ...draft, categoryId: created.id };
    }
    const categories = await db.categories.where('trackId').equals(input.trackId).toArray();
    const errors = validateQuestionDraft(draft, categories.map((c) => c.id));
    const messages = Object.values(errors).filter((m): m is string => !!m);
    if (messages.length) throw new RepoError('invalid', 'The question has problems.', messages);
    const clean = normaliseDraft(draft);

    if (input.id) {
      const before = await db.questions.get(input.id);
      if (!before || before.trackId !== input.trackId) throw new RepoError('not-found', 'Question not found.');
      const changedFields = EDITABLE.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(clean[k] ?? null));
      if (!changedFields.length) return { id: before.id, number: before.number, version: before.version, bumped: false, changed: false };
      const bumped = changedVersionedFields(before, clean).length > 0;
      const after: Question = { ...before, ...clean, version: before.version + (bumped ? 1 : 0) };
      await db.questions.put(after);
      await markTrackChanged(input.trackId);
      const pick = (q: Question) => Object.fromEntries([...changedFields, 'version'].map((k) => [k, q[k as keyof Question] ?? null]));
      await appendAudit({ action: 'bank.question_edited', entity: 'question', entityId: before.id, before: pick(before), after: pick(after) });
      return { id: after.id, number: after.number, version: after.version, bumped, changed: true };
    }

    const meta = await trackMetaOf(input.trackId);
    const numbers = (await db.questions.where('trackId').equals(input.trackId).toArray()).map((q) => q.number);
    let number = nextQuestionNumber(numbers, meta.maxNumber);
    while (await db.questions.get(`${input.trackId}-${number}`)) number++;
    const question: Question = { id: `${input.trackId}-${number}`, trackId: input.trackId, number, ...clean, version: 1, status: 'active' };
    await db.questions.add(question);
    await markTrackChanged(input.trackId, { maxNumber: Math.max(meta.maxNumber, number) });
    await appendAudit({ action: 'bank.question_added', entity: 'question', entityId: question.id, after: question });
    return { id: question.id, number, version: 1, bumped: false, changed: true };
  });
}

/**
 * BANK-13: adds many questions in one go (all or nothing), creating the new categories they use.
 * Numbers follow on from the track's largest number. Each question is audited.
 */
export async function bulkAddQuestions(trackId: string, drafts: readonly QuestionDraft[], newCategories: ReadonlyArray<{ id: string; name: string }> = []): Promise<{ ids: string[]; categories: string[] }> {
  if (!drafts.length) throw new RepoError('invalid', 'There are no questions to add.');
  return db.transaction('rw', bankTables(), async () => {
    await requireTrack(trackId);
    // Provisional category ids from the preview are mapped to the ids actually created.
    const idMap = new Map<string, string>();
    const createdNames: string[] = [];
    for (const c of newCategories) {
      if (!drafts.some((d) => d.categoryId === c.id)) continue;
      const existing = (await db.categories.where('trackId').equals(trackId).toArray()).find((x) => x.name.trim().toLowerCase() === c.name.trim().toLowerCase());
      const created = existing ?? (await insertCategory(trackId, { name: c.name }));
      idMap.set(c.id, created.id);
      if (!existing) createdNames.push(created.name);
    }
    const categories = await db.categories.where('trackId').equals(trackId).toArray();
    const catIds = categories.map((c) => c.id);
    const prepared = drafts.map((d, i) => {
      const draft = { ...d, categoryId: idMap.get(d.categoryId) ?? d.categoryId };
      const errors = Object.values(validateQuestionDraft(draft, catIds)).filter((m): m is string => !!m);
      if (errors.length) throw new RepoError('invalid', `Question ${i + 1} has problems: ${errors[0]}`, errors);
      return normaliseDraft(draft);
    });
    const meta = await trackMetaOf(trackId);
    let number = nextQuestionNumber((await db.questions.where('trackId').equals(trackId).toArray()).map((q) => q.number), meta.maxNumber);
    const ids: string[] = [];
    for (const clean of prepared) {
      while (await db.questions.get(`${trackId}-${number}`)) number++;
      const question: Question = { id: `${trackId}-${number}`, trackId, number, ...clean, version: 1, status: 'active' };
      await db.questions.add(question);
      await appendAudit({ action: 'bank.question_added', entity: 'question', entityId: question.id, after: question, reason: `Bulk add of ${prepared.length} questions` });
      ids.push(question.id);
      number++;
    }
    await markTrackChanged(trackId, { maxNumber: Math.max(meta.maxNumber, number - 1) });
    return { ids, categories: createdNames };
  });
}

/** BANK-10: retire or restore a question. Retired questions are not offered when building a plan. No version change. */
export async function setQuestionStatus(questionId: string, status: QuestionStatus): Promise<void> {
  await db.transaction('rw', bankTables(), async () => {
    const q = await db.questions.get(questionId);
    if (!q) throw new RepoError('not-found', 'Question not found.');
    if (q.status === status) return;
    await db.questions.put({ ...q, status });
    await markTrackChanged(q.trackId);
    await appendAudit({
      action: status === 'retired' ? 'bank.question_retired' : 'bank.question_restored',
      entity: 'question',
      entityId: q.id,
      before: { status: q.status },
      after: { status },
    });
  });
}

/** BANK-12: add a category to a track. Its id is `<trackId>-<slug of the name>`. */
export async function addCategory(trackId: string, input: CategoryInput): Promise<string> {
  return db.transaction('rw', bankTables(), async () => {
    await requireTrack(trackId);
    return (await insertCategory(trackId, input)).id;
  });
}

/**
 * BANK-12: rename a category or change its default weight and must-have flag. The id stays the
 * same, so questions, plans and fingerprints that refer to it are unaffected.
 */
export async function updateCategory(categoryId: string, patch: Partial<CategoryInput>): Promise<void> {
  await db.transaction('rw', bankTables(), async () => {
    const c = await db.categories.get(categoryId);
    if (!c) throw new RepoError('not-found', 'Category not found.');
    const next: Category = { ...c, name: patch.name !== undefined ? patch.name.trim() : c.name, weight: patch.weight ?? c.weight, mustHave: patch.mustHave ?? c.mustHave };
    const others = await db.categories.where('trackId').equals(c.trackId).toArray();
    const problems = categoryProblems(next.name, next.weight, others, c.id);
    if (problems.length) throw new RepoError('invalid', problems[0], problems);
    const changed = (['name', 'weight', 'mustHave'] as const).filter((k) => c[k] !== next[k]);
    if (!changed.length) return;
    await db.categories.put(next);
    await markTrackChanged(c.trackId);
    await appendAudit({
      action: 'bank.category_edited',
      entity: 'category',
      entityId: c.id,
      before: Object.fromEntries(changed.map((k) => [k, c[k]])),
      after: Object.fromEntries(changed.map((k) => [k, next[k]])),
    });
  });
}

/** BANK-12: a category can be removed only when no question (active or retired) uses it. */
export async function removeCategory(categoryId: string): Promise<void> {
  await db.transaction('rw', bankTables(), async () => {
    const c = await db.categories.get(categoryId);
    if (!c) throw new RepoError('not-found', 'Category not found.');
    const used = await db.questions.where('categoryId').equals(categoryId).count();
    if (used) throw new RepoError('in-use', `“${c.name}” still has ${used} question${used === 1 ? '' : 's'} (including retired ones), so it cannot be removed.`);
    const remaining = await db.categories.where('trackId').equals(c.trackId).count();
    if (remaining <= 1) throw new RepoError('last-category', 'A track needs at least one category.');
    await db.categories.delete(categoryId);
    const meta = await trackMetaOf(c.trackId);
    await markTrackChanged(c.trackId, { categoryOrder: meta.categoryOrder.filter((x) => x !== categoryId) });
    await appendAudit({ action: 'bank.category_removed', entity: 'category', entityId: c.id, before: { trackId: c.trackId, name: c.name, weight: c.weight, mustHave: c.mustHave } });
  });
}

export interface NewTrackInput {
  id: string;
  name: string;
  /** Defaults to this month ("2026.11"). */
  version?: string;
  firstCategory: CategoryInput;
}

/** Problems with a new track's id, name or version, by field. */
export async function newTrackProblems(input: Pick<NewTrackInput, 'id' | 'name' | 'version'>): Promise<Partial<Record<'id' | 'name' | 'version', string>>> {
  const p: Partial<Record<'id' | 'name' | 'version', string>> = {};
  const id = input.id.trim();
  if (!TRACK_ID_RE.test(id)) p.id = 'Use lower-case letters and digits only, starting with a letter (for example “data” or “sre2”), at most 30.';
  else if (await db.tracks.get(id)) p.id = `There is already a track with the id “${id}”.`;
  const name = input.name.trim();
  if (!name) p.name = 'Enter the track name.';
  else if (name.length > LIMITS.trackName) p.name = `Keep the name under ${LIMITS.trackName} characters.`;
  else if ((await db.tracks.toArray()).some((t) => t.name.trim().toLowerCase() === name.toLowerCase())) p.name = 'There is already a track with this name.';
  if (input.version !== undefined && !TRACK_VERSION_RE.test(input.version.trim())) p.version = 'Use year.month, for example 2026.11.';
  return p;
}

/** BANK-12: creates a new, empty track with its first category. It has unexported changes until it is exported. */
export async function createTrack(input: NewTrackInput): Promise<string> {
  return db.transaction('rw', bankTables(), async () => {
    const problems = await newTrackProblems(input);
    const messages = Object.values(problems).filter((m): m is string => !!m);
    if (messages.length) throw new RepoError('invalid', messages[0], messages);
    const id = input.id.trim();
    const version = input.version?.trim() || monthVersion(new Date(clock.now()));
    await db.tracks.add({ id, name: input.name.trim(), version });
    await db.trackMeta.put({ trackId: id, changedAt: null, exportedAt: null, maxNumber: 0, categoryOrder: [] });
    await appendAudit({ action: 'bank.track_created', entity: 'track', entityId: id, after: { id, name: input.name.trim(), version } });
    await insertCategory(id, input.firstCategory);
    return id;
  });
}
