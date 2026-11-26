// DB-1, BANK-9…BANK-14: the question bank in PostgreSQL. The rules are the local app's pure ones
// (src/domain/bankEdit.ts); this module stores the result. Every change:
//   - locks its track row first (`FOR UPDATE`), so changes to one track happen one at a time and
//     numbers are never handed out twice (BANK-10);
//   - is audited with the values before and after, in the same transaction (BANK-14, HPRIV-4);
//   - marks the track as having changes not yet exported (BANK-14);
//   - records a new row in question_versions when a question is created or its version goes up
//     (BANK-11), and publishes a live "bank" event so open screens refresh (HOST-5).
import { sql } from 'kysely';
import { json, type Executor } from '../db/pool';
import type { CategoryRow, QuestionRow } from '../db/schema';
import { appendAudit, type AuditActor } from '../audit/audit';
import { publish } from '../live/bus';
import { ApiError, conflict, invalid, notFound } from '../http/errors';
import {
  LIMITS,
  TRACK_ID_RE,
  TRACK_VERSION_RE,
  categoryIdFor,
  changedVersionedFields,
  monthVersion,
  normaliseDraft,
  trackVersionProblem,
  validateQuestionDraft,
  type QuestionDraft,
} from '../../src/domain/bankEdit';
import { toJson, trackFile } from '../../src/domain/export';
import { trackQuestionsCsv } from '../../src/domain/bankCsv';
import { validateTrackFile } from '../../src/domain/validation';
import type { Category, Question, QuestionStatus, Track } from '../../src/domain/types';
import type { ExportedTrack, SaveQuestionResult, TrackBank, TrackSummary } from '../../src/shared/api';

export const WEIGHT_RANGE = [0.1, 10] as const;

export function questionFromRow(r: QuestionRow): Question {
  return {
    id: r.id,
    trackId: r.track_id,
    categoryId: r.category_id,
    number: r.number,
    text: r.text,
    description: r.description,
    difficulty: r.difficulty,
    type: r.type,
    timeMin: r.time_min,
    lookFor: r.look_for,
    redFlags: r.red_flags,
    probes: r.probes,
    version: r.version,
    status: r.status,
    rubricOverride: r.rubric_override ?? null,
  };
}

export function categoryFromRow(r: CategoryRow): Category {
  return { id: r.id, trackId: r.track_id, name: r.name, weight: r.weight, mustHave: r.must_have };
}

/** Column values for a question (jsonb columns as JSON text). */
export function questionColumns(q: Omit<Question, 'id' | 'trackId' | 'number' | 'version' | 'status'>) {
  return {
    category_id: q.categoryId,
    text: q.text,
    description: q.description ?? '',
    difficulty: q.difficulty,
    type: q.type,
    time_min: q.timeMin,
    look_for: json(q.lookFor),
    red_flags: json(q.redFlags),
    probes: json(q.probes),
    rubric_override: q.rubricOverride ? json(q.rubricOverride) : null,
  };
}

/** BANK-11: keeps the full question as it is at its current version. Idempotent per version. */
export async function recordVersion(db: Executor, q: Question, source: 'import' | 'create' | 'edit', userId: string | null): Promise<void> {
  await db
    .insertInto('question_versions')
    .values({ question_id: q.id, version: q.version, snapshot: json(q), source, created_by: userId })
    .onConflict((oc) => oc.columns(['question_id', 'version']).doNothing())
    .execute();
}

const userIdOf = (a: AuditActor) => ('system' in a ? null : a.id);

/** Locks the track for this transaction and returns it; 404 when it does not exist. */
export async function lockTrack(db: Executor, trackId: string) {
  const t = await db.selectFrom('tracks').selectAll().where('id', '=', trackId).forUpdate().executeTakeFirst();
  if (!t) throw notFound('That track');
  return t;
}

async function markChanged(db: Executor, trackId: string) {
  await db.updateTable('tracks').set({ changed_at: sql`coalesce(changed_at, now())`, updated_at: sql`now()` }).where('id', '=', trackId).execute();
}

const bankEvent = (db: Executor, kind: string, id?: string) => publish(db, { topic: 'bank', kind, id });

export async function listTracks(db: Executor): Promise<TrackSummary[]> {
  const rows = await db
    .selectFrom('tracks as t')
    .select(['t.id', 't.name', 't.version', 't.changed_at', 't.exported_at'])
    .select((eb) => [
      eb.selectFrom('questions as q').select(eb.fn.countAll<number>().as('n')).whereRef('q.track_id', '=', 't.id').as('questions'),
      eb.selectFrom('questions as q').select(eb.fn.countAll<number>().as('n')).whereRef('q.track_id', '=', 't.id').where('q.status', '=', 'active').as('active'),
      eb.selectFrom('categories as c').select(eb.fn.countAll<number>().as('n')).whereRef('c.track_id', '=', 't.id').as('categories'),
    ])
    .orderBy('t.id')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    version: r.version,
    changedAt: r.changed_at?.toISOString() ?? null,
    exportedAt: r.exported_at?.toISOString() ?? null,
    questions: Number(r.questions ?? 0),
    active: Number(r.active ?? 0),
    categories: Number(r.categories ?? 0),
  }));
}

export async function loadTrackBank(db: Executor, trackId: string): Promise<TrackBank | null> {
  const track = await db.selectFrom('tracks').selectAll().where('id', '=', trackId).executeTakeFirst();
  if (!track) return null;
  const [categories, questions] = await Promise.all([
    db.selectFrom('categories').selectAll().where('track_id', '=', trackId).orderBy('position').orderBy('id').execute(),
    db.selectFrom('questions').selectAll().where('track_id', '=', trackId).orderBy('number').execute(),
  ]);
  return {
    track: { id: track.id, name: track.name, version: track.version },
    categories: categories.map(categoryFromRow),
    questions: questions.map(questionFromRow),
    changedAt: track.changed_at?.toISOString() ?? null,
  };
}

export interface CategoryInput {
  name: string;
  weight?: number;
  mustHave?: boolean;
}

function categoryProblems(name: string, weight: number, others: readonly Pick<Category, 'id' | 'name'>[], selfId?: string): string[] {
  const p: string[] = [];
  const n = name.trim();
  if (!n) p.push('Enter a category name.');
  else if (n.length > LIMITS.categoryName) p.push(`Keep the name under ${LIMITS.categoryName} characters.`);
  else if (others.some((c) => c.id !== selfId && c.name.trim().toLowerCase() === n.toLowerCase())) p.push(`There is already a category called “${n}”.`);
  if (!(weight >= WEIGHT_RANGE[0] && weight <= WEIGHT_RANGE[1])) p.push(`Use a weight from ${WEIGHT_RANGE[0]} to ${WEIGHT_RANGE[1]}.`);
  return p;
}

/** Creates a category in a locked track; ids are never reused (a clash gets a numeric suffix). */
export async function insertCategory(db: Executor, actor: AuditActor, trackId: string, input: CategoryInput, audit = true): Promise<Category> {
  const others = await db.selectFrom('categories').select(['id', 'name', 'position']).where('track_id', '=', trackId).execute();
  const weight = input.weight ?? 1;
  const problems = categoryProblems(input.name, weight, others);
  if (problems.length) throw invalid(problems[0], problems);
  const base = categoryIdFor(trackId, input.name);
  let id = base;
  for (let i = 2; await db.selectFrom('categories').select('id').where('id', '=', id).executeTakeFirst(); i++) id = `${base}-${i}`;
  const position = Math.max(-1, ...others.map((c) => c.position)) + 1;
  const category: Category = { id, trackId, name: input.name.trim(), weight, mustHave: !!input.mustHave };
  await db.insertInto('categories').values({ id, track_id: trackId, name: category.name, weight, must_have: category.mustHave, position }).execute();
  if (audit) await appendAudit(db, actor, { action: 'bank.category_added', entity: 'category', entityId: id, after: { trackId, name: category.name, weight, mustHave: category.mustHave } });
  return category;
}

export interface SaveQuestionInput {
  trackId: string;
  id?: string;
  draft: QuestionDraft;
  newCategory?: CategoryInput;
  /** Recorded as the audit entry's reason (REVIEW-5: who proposed it and who accepted it). */
  auditReason?: string;
}

const EDITABLE: Array<keyof QuestionDraft> = ['text', 'description', 'categoryId', 'difficulty', 'type', 'timeMin', 'lookFor', 'redFlags', 'probes', 'rubricOverride'];

async function nextNumber(db: Executor, trackId: string): Promise<number> {
  const r = await db.selectFrom('questions').select((eb) => eb.fn.max('number').as('max')).where('track_id', '=', trackId).executeTakeFirst();
  return Number(r?.max ?? 0) + 1;
}

/** BANK-9…BANK-11: add or edit one question. */
export async function saveQuestion(db: Executor, actor: AuditActor, input: SaveQuestionInput): Promise<SaveQuestionResult> {
  await lockTrack(db, input.trackId);
  let draft = input.draft;
  if (input.newCategory) {
    const created = await insertCategory(db, actor, input.trackId, input.newCategory);
    draft = { ...draft, categoryId: created.id };
  }
  const catIds = (await db.selectFrom('categories').select('id').where('track_id', '=', input.trackId).execute()).map((c) => c.id);
  const errors = validateQuestionDraft(draft, catIds);
  const messages = Object.values(errors).filter((m): m is string => !!m);
  if (messages.length) throw new ApiError(400, 'invalid', 'The question has problems.', errors as Record<string, string>);
  const clean = normaliseDraft(draft);

  if (input.id) {
    const row = await db.selectFrom('questions').selectAll().where('id', '=', input.id).where('track_id', '=', input.trackId).forUpdate().executeTakeFirst();
    if (!row) throw notFound('That question');
    const before = questionFromRow(row);
    const changedFields = EDITABLE.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(clean[k] ?? null));
    if (!changedFields.length) return { id: before.id, number: before.number, version: before.version, bumped: false, changed: false };
    // BANK-11: the existing pure rule decides whether the version goes up.
    const bumped = changedVersionedFields(before, clean).length > 0;
    const after: Question = { ...before, ...clean, version: before.version + (bumped ? 1 : 0) };
    await db.updateTable('questions').set({ ...questionColumns(after), version: after.version, updated_at: sql`now()` }).where('id', '=', after.id).execute();
    if (bumped) await recordVersion(db, after, 'edit', userIdOf(actor));
    await markChanged(db, input.trackId);
    const pick = (q: Question) => Object.fromEntries([...changedFields, 'version'].map((k) => [k, q[k as keyof Question] ?? null]));
    await appendAudit(db, actor, { action: 'bank.question_edited', entity: 'question', entityId: after.id, before: pick(before), after: pick(after), reason: input.auditReason ?? null });
    await bankEvent(db, 'question', after.id);
    // REVIEW-6: open proposals on this question may now be out of date.
    await publish(db, { topic: 'reviews', kind: 'question', id: after.id });
    return { id: after.id, number: after.number, version: after.version, bumped, changed: true };
  }

  const number = await nextNumber(db, input.trackId);
  const question: Question = { id: `${input.trackId}-${number}`, trackId: input.trackId, number, ...clean, version: 1, status: 'active' };
  await db.insertInto('questions').values({ id: question.id, track_id: input.trackId, number, ...questionColumns(question), version: 1, status: 'active' }).execute();
  await recordVersion(db, question, 'create', userIdOf(actor));
  await markChanged(db, input.trackId);
  await appendAudit(db, actor, { action: 'bank.question_added', entity: 'question', entityId: question.id, after: question, reason: input.auditReason ?? null });
  await bankEvent(db, 'question', question.id);
  return { id: question.id, number, version: 1, bumped: false, changed: true };
}

/** BANK-13: many questions at once, all or nothing, creating the new categories they use. */
export async function bulkAdd(
  db: Executor,
  actor: AuditActor,
  trackId: string,
  drafts: readonly QuestionDraft[],
  newCategories: ReadonlyArray<{ id: string; name: string }>,
): Promise<{ ids: string[]; categories: string[] }> {
  if (!drafts.length) throw invalid('There are no questions to add.');
  await lockTrack(db, trackId);
  const idMap = new Map<string, string>();
  const createdNames: string[] = [];
  for (const c of newCategories) {
    if (!drafts.some((d) => d.categoryId === c.id)) continue;
    const existing = await db.selectFrom('categories').select(['id', 'name']).where('track_id', '=', trackId).where(sql`lower(btrim(name))`, '=', c.name.trim().toLowerCase()).executeTakeFirst();
    const created = existing ? { id: existing.id } : await insertCategory(db, actor, trackId, { name: c.name });
    idMap.set(c.id, created.id);
    if (!existing) createdNames.push(c.name.trim());
  }
  const catIds = (await db.selectFrom('categories').select('id').where('track_id', '=', trackId).execute()).map((c) => c.id);
  const prepared = drafts.map((d, i) => {
    const draft = { ...d, categoryId: idMap.get(d.categoryId) ?? d.categoryId };
    const errors = Object.values(validateQuestionDraft(draft, catIds)).filter((m): m is string => !!m);
    if (errors.length) throw invalid(`Question ${i + 1} has problems: ${errors[0]}`, errors);
    return normaliseDraft(draft);
  });
  let number = await nextNumber(db, trackId);
  const ids: string[] = [];
  for (const clean of prepared) {
    const q: Question = { id: `${trackId}-${number}`, trackId, number, ...clean, version: 1, status: 'active' };
    await db.insertInto('questions').values({ id: q.id, track_id: trackId, number, ...questionColumns(q), version: 1, status: 'active' }).execute();
    await recordVersion(db, q, 'create', userIdOf(actor));
    await appendAudit(db, actor, { action: 'bank.question_added', entity: 'question', entityId: q.id, after: q, reason: `Bulk add of ${prepared.length} questions` });
    ids.push(q.id);
    number++;
  }
  await markChanged(db, trackId);
  await bankEvent(db, 'bulk', trackId);
  return { ids, categories: createdNames };
}

/** BANK-10: retire or restore; no version change. */
export async function setQuestionStatus(db: Executor, actor: AuditActor, questionId: string, status: QuestionStatus): Promise<void> {
  const q = await db.selectFrom('questions').select(['id', 'track_id', 'status']).where('id', '=', questionId).executeTakeFirst();
  if (!q) throw notFound('That question');
  await lockTrack(db, q.track_id);
  if (q.status === status) return;
  await db.updateTable('questions').set({ status, updated_at: sql`now()` }).where('id', '=', q.id).execute();
  await markChanged(db, q.track_id);
  await appendAudit(db, actor, { action: status === 'retired' ? 'bank.question_retired' : 'bank.question_restored', entity: 'question', entityId: q.id, before: { status: q.status }, after: { status } });
  await bankEvent(db, 'question', q.id);
}

export async function addCategory(db: Executor, actor: AuditActor, trackId: string, input: CategoryInput): Promise<string> {
  await lockTrack(db, trackId);
  const c = await insertCategory(db, actor, trackId, input);
  await markChanged(db, trackId);
  await bankEvent(db, 'category', c.id);
  return c.id;
}

/** BANK-12: rename, or change default weight and must-have; the id never changes. */
export async function updateCategory(db: Executor, actor: AuditActor, categoryId: string, patch: Partial<CategoryInput>): Promise<void> {
  const found = await db.selectFrom('categories').select('track_id').where('id', '=', categoryId).executeTakeFirst();
  if (!found) throw notFound('That category');
  await lockTrack(db, found.track_id);
  const c = categoryFromRow(await db.selectFrom('categories').selectAll().where('id', '=', categoryId).executeTakeFirstOrThrow());
  const next: Category = { ...c, name: patch.name !== undefined ? patch.name.trim() : c.name, weight: patch.weight ?? c.weight, mustHave: patch.mustHave ?? c.mustHave };
  const others = await db.selectFrom('categories').select(['id', 'name']).where('track_id', '=', c.trackId).execute();
  const problems = categoryProblems(next.name, next.weight, others, c.id);
  if (problems.length) throw invalid(problems[0], problems);
  const changed = (['name', 'weight', 'mustHave'] as const).filter((k) => c[k] !== next[k]);
  if (!changed.length) return;
  await db.updateTable('categories').set({ name: next.name, weight: next.weight, must_have: next.mustHave }).where('id', '=', c.id).execute();
  await markChanged(db, c.trackId);
  await appendAudit(db, actor, {
    action: 'bank.category_edited',
    entity: 'category',
    entityId: c.id,
    before: Object.fromEntries(changed.map((k) => [k, c[k]])),
    after: Object.fromEntries(changed.map((k) => [k, next[k]])),
  });
  await bankEvent(db, 'category', c.id);
}

/** BANK-12: only an unused category can be removed, and a track keeps at least one. */
export async function removeCategory(db: Executor, actor: AuditActor, categoryId: string): Promise<void> {
  const found = await db.selectFrom('categories').selectAll().where('id', '=', categoryId).executeTakeFirst();
  if (!found) throw notFound('That category');
  await lockTrack(db, found.track_id);
  const used = Number((await db.selectFrom('questions').select((eb) => eb.fn.countAll<number>().as('n')).where('category_id', '=', categoryId).executeTakeFirstOrThrow()).n);
  if (used) throw conflict(`“${found.name}” still has ${used} question${used === 1 ? '' : 's'} (including retired ones), so it cannot be removed.`);
  const remaining = Number((await db.selectFrom('categories').select((eb) => eb.fn.countAll<number>().as('n')).where('track_id', '=', found.track_id).executeTakeFirstOrThrow()).n);
  if (remaining <= 1) throw conflict('A track needs at least one category.');
  await db.deleteFrom('categories').where('id', '=', categoryId).execute();
  await markChanged(db, found.track_id);
  await appendAudit(db, actor, { action: 'bank.category_removed', entity: 'category', entityId: found.id, before: { trackId: found.track_id, name: found.name, weight: found.weight, mustHave: found.must_have } });
  await bankEvent(db, 'category', found.id);
}

export interface NewTrackInput {
  id: string;
  name: string;
  version?: string;
  firstCategory: CategoryInput;
}

export async function newTrackProblems(db: Executor, input: Pick<NewTrackInput, 'id' | 'name' | 'version'>): Promise<Partial<Record<'id' | 'name' | 'version', string>>> {
  const p: Partial<Record<'id' | 'name' | 'version', string>> = {};
  const id = input.id.trim();
  if (!TRACK_ID_RE.test(id)) p.id = 'Use lower-case letters and digits only, starting with a letter (for example “data” or “sre2”), at most 30.';
  else if (await db.selectFrom('tracks').select('id').where('id', '=', id).executeTakeFirst()) p.id = `There is already a track with the id “${id}”.`;
  const name = input.name.trim();
  if (!name) p.name = 'Enter the track name.';
  else if (name.length > LIMITS.trackName) p.name = `Keep the name under ${LIMITS.trackName} characters.`;
  else if (await db.selectFrom('tracks').select('id').where(sql`lower(btrim(name))`, '=', name.toLowerCase()).executeTakeFirst()) p.name = 'There is already a track with this name.';
  if (input.version !== undefined && input.version.trim() && !TRACK_VERSION_RE.test(input.version.trim())) p.version = 'Use year.month, for example 2026.11.';
  return p;
}

export async function createTrack(db: Executor, actor: AuditActor, input: NewTrackInput): Promise<string> {
  const problems = await newTrackProblems(db, input);
  if (Object.keys(problems).length) throw new ApiError(400, 'invalid', Object.values(problems)[0]!, problems as Record<string, string>);
  const id = input.id.trim();
  const version = input.version?.trim() || monthVersion(new Date());
  await db.insertInto('tracks').values({ id, name: input.name.trim(), version, changed_at: new Date() }).execute();
  await appendAudit(db, actor, { action: 'bank.track_created', entity: 'track', entityId: id, after: { id, name: input.name.trim(), version } });
  await insertCategory(db, actor, id, input.firstCategory);
  await bankEvent(db, 'track', id);
  return id;
}

async function currentTrackFile(db: Executor, trackId: string, version?: string) {
  const bank = await loadTrackBank(db, trackId);
  if (!bank) throw notFound('That track');
  const track: Track = { ...bank.track, version: version ?? bank.track.version };
  return { bank, file: trackFile(track, bank.categories, bank.questions, bank.categories.map((c) => c.id)) };
}

/** DB-4, BANK-7: the track as a track file. With a new version, the track takes it. Clears BANK-14's marker. */
export async function exportTrackFile(db: Executor, actor: AuditActor, trackId: string, opts: { version?: string } = {}): Promise<ExportedTrack> {
  const track = await lockTrack(db, trackId);
  const version = opts.version?.trim() || track.version;
  const problem = trackVersionProblem(version, track.version);
  if (problem && version !== track.version) throw invalid(problem.replace(/, so devices load it \(BANK-6\)/, ''));
  const { file } = await currentTrackFile(db, trackId, version);
  const v = validateTrackFile(file);
  const unused = file.categories.filter((c) => !file.questions.some((q) => q.categoryId === c.id)).map((c) => `Category “${c.name}” has no questions: add one or remove the category.`);
  const problems = [...(v.ok ? [] : v.errors), ...unused];
  if (problems.length) throw invalid('This track cannot be exported until these problems are fixed.', problems);
  await db.updateTable('tracks').set({ version, changed_at: null, exported_at: sql`now()`, updated_at: sql`now()` }).where('id', '=', trackId).execute();
  await appendAudit(db, actor, { action: 'export', entity: 'track', entityId: trackId, before: { version: track.version, unexportedChangesSince: track.changed_at?.toISOString() ?? null }, after: { format: 'track-json', version } });
  await bankEvent(db, 'track', trackId);
  return { fileName: `${trackId}.json`, mime: 'application/json', text: toJson(file), version };
}

/** DB-4, BANK-13: active questions as CSV in the bulk-add layout. */
export async function exportTrackCsv(db: Executor, actor: AuditActor, trackId: string): Promise<ExportedTrack> {
  const bank = await loadTrackBank(db, trackId);
  if (!bank) throw notFound('That track');
  const text = trackQuestionsCsv(bank.questions, bank.categories);
  await appendAudit(db, actor, { action: 'export', entity: 'track', entityId: trackId, after: { format: 'track-csv', version: bank.track.version, questions: bank.questions.filter((q) => q.status === 'active').length } });
  return { fileName: `${trackId}-questions-${new Date().toISOString().slice(0, 10)}.csv`, mime: 'text/csv', text, version: bank.track.version };
}
