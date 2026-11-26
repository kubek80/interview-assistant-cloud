// DB-2, DB-3: importing questions from track files (BANK-3 JSON) and CSV files (BANK-13 layout),
// used by `npm run db:import-questions`, `npm run db:seed` and the administrators' upload in the app.
//
//   1. Every file is read and validated completely first (the same validators as the browser:
//      the compiled JSON Schema plus the structural checks). Any problem in any file: nothing is
//      written, and the report lists every problem by file and row.
//   2. Each track is compared with the database (under a row lock) and the report says what would
//      be added, changed (with the version change) and left alone.
//   3. Unless it is a dry run, the changes are written in the same transaction, with the audit log.
//
// Rules, chosen so that running the same files again changes nothing, and so that an import never
// silently undoes work done in the app:
//   - JSON: questions are matched by id. A question whose content (BANK-11's versioned fields)
//     differs gets version max(database + 1, file); a change only to category, time or status keeps
//     max(database, file). A question that is at a higher version in the database than in the file
//     was edited in the app since: it is left alone and reported as "kept (newer in the database)".
//     Categories are matched by id (file wins on name, weight and must-have). Questions and
//     categories that are in the database but not in the file are left alone.
//   - CSV: there are no ids, so rows are matched to the track's questions by their text (ignoring
//     case and spaces). A matched row updates that question (version rule as above; status and
//     per-level rubric texts, which CSV does not carry, are kept); an unmatched row adds a question.
//     The track is named with --track (or the file name `<track>-questions….csv` / `<track>.csv`)
//     and must already exist.
//   - Versions already planned into interviews are not touched: question sets keep their own
//     snapshots (FLOW-8), and question_versions keeps every version.
import { basename } from 'node:path';
import { sql } from 'kysely';
import type { Db, Executor } from '../db/pool';
import { appendAudit, type AuditActor } from '../audit/audit';
import { publish } from '../live/bus';
import { categoryFromRow, insertCategory, questionColumns, questionFromRow, recordVersion } from './service';
import { categoryIdFor, changedVersionedFields, compareVersions } from '../../src/domain/bankEdit';
import { parseBulkQuestions } from '../../src/domain/bankCsv';
import { validateTrackFile } from '../../src/domain/validation';
import type { Category, Question, TrackFile } from '../../src/domain/types';
import type { ImportFileInput, ImportReport, ImportTrackReport } from '../../src/shared/api';

const CATEGORY_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_IMPORT_FILES = 20;
export const MAX_IMPORT_FILE_CHARS = 5_000_000;

type Parsed =
  | { kind: 'json'; source: string; file: TrackFile }
  | { kind: 'csv'; source: string; trackId: string; text: string };

/** The track a CSV file belongs to: the given id, or one taken from the file name. */
export function csvTrackFromName(name: string, known: readonly string[]): string | null {
  const base = basename(name).toLowerCase();
  const m = /^([a-z][a-z0-9]{0,29})(?:-questions[^/]*)?\.csv$/.exec(base);
  return m && known.includes(m[1]) ? m[1] : null;
}

function parseFiles(files: readonly ImportFileInput[], knownTracks: readonly string[]): { parsed: Parsed[]; problems: ImportReport['problems'] } {
  const problems: ImportReport['problems'] = [];
  const parsed: Parsed[] = [];
  if (!files.length) problems.push({ source: '(none)', messages: ['Give at least one track file (.json) or CSV file (.csv).'] });
  if (files.length > MAX_IMPORT_FILES) problems.push({ source: '(files)', messages: [`Import at most ${MAX_IMPORT_FILES} files at a time.`] });
  const seenTracks = new Map<string, string>();
  for (const f of files) {
    const source = f.name;
    if (f.text.length > MAX_IMPORT_FILE_CHARS) {
      problems.push({ source, messages: ['The file is too large (5 MB at most).'] });
      continue;
    }
    const isCsv = /\.csv$/i.test(f.name) || (!!f.trackId && !/^\s*\{/.test(f.text));
    if (isCsv) {
      const trackId = f.trackId?.trim() || csvTrackFromName(f.name, knownTracks);
      if (!trackId) problems.push({ source, messages: ['Say which track this CSV file is for (--track <id>, or name the file <track>-questions.csv).'] });
      else if (!knownTracks.includes(trackId)) problems.push({ source, messages: [`There is no track “${trackId}” in the database. Import its track file first.`] });
      else parsed.push({ kind: 'csv', source, trackId, text: f.text });
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(f.text);
    } catch {
      problems.push({ source, messages: ['This is not valid JSON (a track file) or a .csv file.'] });
      continue;
    }
    const v = validateTrackFile(value);
    if (!v.ok) {
      problems.push({ source, messages: v.errors });
      continue;
    }
    const file = v.value;
    const msgs: string[] = [];
    for (const c of file.categories) if (!CATEGORY_ID_RE.test(c.id)) msgs.push(`category id “${c.id}” must be lower-case letters, digits and dashes`);
    for (const q of file.questions) if (q.id !== `${file.track.id}-${q.number}`) msgs.push(`question ${q.id} must have the id ${file.track.id}-${q.number} (track id and number)`);
    const other = seenTracks.get(file.track.id);
    if (other) msgs.push(`track “${file.track.id}” is also in ${other}: import one file per track`);
    seenTracks.set(file.track.id, source);
    if (msgs.length) problems.push({ source, messages: msgs });
    else parsed.push({ kind: 'json', source, file });
  }
  return { parsed, problems };
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

interface QuestionWrite {
  kind: 'add' | 'change';
  question: Question;
  before?: Question;
  fields: string[];
}

interface TrackPlan {
  report: ImportTrackReport;
  createTrack: { id: string; name: string; version: string } | null;
  trackUpdate: { name?: string; version?: string } | null;
  categoryAdds: Array<Category & { position: number }>;
  categoryUpdates: Array<{ id: string; name: string; weight: number; mustHave: boolean; before: Category }>;
  categoryPositions: Array<{ id: string; position: number }>;
  newCsvCategories: string[];
  questions: QuestionWrite[];
  markChanged: boolean;
}

function emptyReport(trackId: string, name: string, source: string): ImportTrackReport {
  return { trackId, name, source, trackAction: 'unchanged', trackChanges: [], categoriesAdded: [], categoriesChanged: [], added: [], changed: [], unchanged: 0, keptNewer: [], notInFile: 0 };
}

/** Compares one incoming question with the stored one. */
function compare(db: Question, incoming: Question, keepStatusAndRubric: boolean): { fields: string[]; next: Question } | 'unchanged' | 'newer' {
  const fileVersion = keepStatusAndRubric ? db.version : incoming.version;
  if (!keepStatusAndRubric && db.version > incoming.version) return 'newer';
  const target: Question = keepStatusAndRubric ? { ...incoming, status: db.status, rubricOverride: db.rubricOverride } : incoming;
  const versioned = changedVersionedFields(db, target);
  const other = (['categoryId', 'timeMin', 'status'] as const).filter((k) => !sameJson(db[k], target[k]));
  const version = versioned.length ? Math.max(db.version + 1, fileVersion) : Math.max(db.version, fileVersion);
  if (!versioned.length && !other.length && version === db.version) return 'unchanged';
  return { fields: [...versioned, ...other], next: { ...target, id: db.id, trackId: db.trackId, number: db.number, version } };
}

async function planJson(db: Executor, source: string, file: TrackFile): Promise<TrackPlan> {
  const trackId = file.track.id;
  const report = emptyReport(trackId, file.track.name, source);
  const plan: TrackPlan = { report, createTrack: null, trackUpdate: null, categoryAdds: [], categoryUpdates: [], categoryPositions: [], newCsvCategories: [], questions: [], markChanged: false };
  const track = await db.selectFrom('tracks').selectAll().where('id', '=', trackId).forUpdate().executeTakeFirst();
  if (!track) {
    report.trackAction = 'create';
    plan.createTrack = { id: trackId, name: file.track.name, version: file.track.version };
  } else {
    const upd: { name?: string; version?: string } = {};
    if (track.name !== file.track.name) {
      upd.name = file.track.name;
      report.trackChanges.push(`name “${track.name}” → “${file.track.name}”`);
    }
    if (compareVersions(file.track.version, track.version) > 0) {
      upd.version = file.track.version;
      report.trackChanges.push(`version ${track.version} → ${file.track.version}`);
    }
    if (Object.keys(upd).length) {
      plan.trackUpdate = upd;
      report.trackAction = 'update';
    }
  }
  const storedCats = new Map((await db.selectFrom('categories').selectAll().where('track_id', '=', trackId).execute()).map((r) => [r.id, categoryFromRow(r)]));
  const elsewhere = await db.selectFrom('categories').select(['id', 'track_id']).where('id', 'in', file.categories.map((c) => c.id)).where('track_id', '<>', trackId).execute();
  if (elsewhere.length) throw new ImportProblem(source, elsewhere.map((c) => `category id “${c.id}” is already used by track “${c.track_id}”`));
  file.categories.forEach((c, position) => {
    const s = storedCats.get(c.id);
    if (!s) {
      plan.categoryAdds.push({ id: c.id, trackId, name: c.name, weight: c.weight, mustHave: c.mustHave, position });
      report.categoriesAdded.push(c.name);
    } else {
      plan.categoryPositions.push({ id: c.id, position });
      if (s.name !== c.name || Number(s.weight) !== Number(c.weight) || s.mustHave !== c.mustHave) {
        plan.categoryUpdates.push({ id: c.id, name: c.name, weight: c.weight, mustHave: c.mustHave, before: s });
        report.categoriesChanged.push(s.name === c.name ? c.name : `${s.name} → ${c.name}`);
      }
    }
  });
  const stored = new Map((await db.selectFrom('questions').selectAll().where('track_id', '=', trackId).execute()).map((r) => [r.id, questionFromRow(r)]));
  for (const fq of file.questions) {
    const incoming: Question = { ...fq, trackId, description: fq.description, rubricOverride: fq.rubricOverride ?? null };
    const s = stored.get(fq.id);
    if (!s) {
      plan.questions.push({ kind: 'add', question: incoming, fields: [] });
      report.added.push({ id: fq.id, number: fq.number, text: fq.text });
      continue;
    }
    const c = compare(s, incoming, false);
    if (c === 'unchanged') report.unchanged++;
    else if (c === 'newer') report.keptNewer.push({ id: s.id, number: s.number, databaseVersion: s.version, fileVersion: fq.version });
    else {
      plan.questions.push({ kind: 'change', question: c.next, before: s, fields: c.fields });
      report.changed.push({ id: s.id, number: s.number, text: s.text, fromVersion: s.version, toVersion: c.next.version, fields: c.fields });
    }
  }
  const inFile = new Set(file.questions.map((q) => q.id));
  report.notInFile = [...stored.keys()].filter((id) => !inFile.has(id)).length;
  if (report.trackAction === 'unchanged' && (report.added.length || report.changed.length || report.categoriesAdded.length || report.categoriesChanged.length)) report.trackAction = 'update';
  return plan;
}

class ImportProblem extends Error {
  constructor(
    public readonly source: string,
    public readonly messages: string[],
  ) {
    super(messages[0]);
  }
}

async function planCsv(db: Executor, source: string, trackId: string, text: string): Promise<TrackPlan> {
  const track = await db.selectFrom('tracks').selectAll().where('id', '=', trackId).forUpdate().executeTakeFirstOrThrow();
  const report = emptyReport(trackId, track.name, source);
  const plan: TrackPlan = { report, createTrack: null, trackUpdate: null, categoryAdds: [], categoryUpdates: [], categoryPositions: [], newCsvCategories: [], questions: [], markChanged: true };
  const categories = (await db.selectFrom('categories').selectAll().where('track_id', '=', trackId).execute()).map(categoryFromRow);
  const parsed = parseBulkQuestions(text, trackId, categories);
  if (parsed.problem) throw new ImportProblem(source, [parsed.problem]);
  const rowProblems = parsed.rows.filter((r) => r.problems.length).flatMap((r) => r.problems.map((p) => `row ${r.line}: ${p}`));
  if (rowProblems.length) throw new ImportProblem(source, rowProblems);
  plan.newCsvCategories = parsed.newCategories;
  report.categoriesAdded.push(...parsed.newCategories);
  const stored = (await db.selectFrom('questions').selectAll().where('track_id', '=', trackId).orderBy('number').execute()).map(questionFromRow);
  const byText = new Map(stored.map((q) => [norm(q.text), q]));
  const used = new Set<string>();
  for (const row of parsed.rows) {
    const s = byText.get(norm(row.draft.text));
    const incoming: Question = { id: '', trackId, number: 0, ...row.draft, version: 1, status: 'active' };
    if (!s || used.has(s.id)) {
      plan.questions.push({ kind: 'add', question: incoming, fields: [] });
      report.added.push({ id: '', number: 0, text: row.draft.text });
      continue;
    }
    used.add(s.id);
    const c = compare(s, { ...incoming, id: s.id, number: s.number }, true);
    if (c === 'unchanged' || c === 'newer') report.unchanged++;
    else {
      plan.questions.push({ kind: 'change', question: c.next, before: s, fields: c.fields });
      report.changed.push({ id: s.id, number: s.number, text: s.text, fromVersion: s.version, toVersion: c.next.version, fields: c.fields });
    }
  }
  report.notInFile = stored.length - used.size;
  if (report.added.length || report.changed.length) report.trackAction = 'update';
  return plan;
}

async function applyPlan(db: Executor, actor: AuditActor, plan: TrackPlan): Promise<void> {
  const r = plan.report;
  const trackId = r.trackId;
  const userId = 'system' in actor ? null : actor.id;
  if (plan.createTrack) await db.insertInto('tracks').values(plan.createTrack).execute();
  if (plan.trackUpdate) await db.updateTable('tracks').set({ ...plan.trackUpdate, updated_at: sql`now()` }).where('id', '=', trackId).execute();
  for (const c of plan.categoryAdds) {
    await db.insertInto('categories').values({ id: c.id, track_id: trackId, name: c.name, weight: c.weight, must_have: c.mustHave, position: c.position }).execute();
  }
  for (const c of plan.categoryUpdates) {
    await db.updateTable('categories').set({ name: c.name, weight: c.weight, must_have: c.mustHave }).where('id', '=', c.id).execute();
    await appendAudit(db, actor, { action: 'bank.category_edited', entity: 'category', entityId: c.id, before: { name: c.before.name, weight: c.before.weight, mustHave: c.before.mustHave }, after: { name: c.name, weight: c.weight, mustHave: c.mustHave }, reason: `Imported from ${r.source}` });
  }
  for (const p of plan.categoryPositions) await db.updateTable('categories').set({ position: p.position }).where('id', '=', p.id).where('position', '<>', p.position).execute();
  // CSV: create the new categories it names, then point its rows at their real ids.
  const idMap = new Map<string, string>();
  for (const name of plan.newCsvCategories) {
    const created = await insertCategory(db, actor, trackId, { name }, false);
    idMap.set(categoryIdFor(trackId, name), created.id);
  }
  let next = Number((await db.selectFrom('questions').select((eb) => eb.fn.max('number').as('m')).where('track_id', '=', trackId).executeTakeFirst())?.m ?? 0) + 1;
  for (const w of plan.questions) {
    const q: Question = { ...w.question, categoryId: idMap.get(w.question.categoryId) ?? w.question.categoryId };
    if (w.kind === 'add') {
      if (!q.id) {
        q.number = next++;
        q.id = `${trackId}-${q.number}`;
        const line = r.added.find((a) => !a.id && a.text === q.text);
        if (line) Object.assign(line, { id: q.id, number: q.number });
      }
      await db.insertInto('questions').values({ id: q.id, track_id: trackId, number: q.number, ...questionColumns(q), version: q.version, status: q.status }).execute();
      await recordVersion(db, q, 'import', userId);
    } else {
      await db.updateTable('questions').set({ ...questionColumns(q), version: q.version, status: q.status, updated_at: sql`now()` }).where('id', '=', q.id).execute();
      await recordVersion(db, q, 'import', userId);
      const pick = (x: Question) => Object.fromEntries([...w.fields, 'version'].map((k) => [k, x[k as keyof Question] ?? null]));
      await appendAudit(db, actor, { action: 'bank.question_edited', entity: 'question', entityId: q.id, before: pick(w.before!), after: pick(q), reason: `Imported from ${r.source}` });
    }
  }
  if (plan.markChanged && plan.questions.length) await db.updateTable('tracks').set({ changed_at: sql`coalesce(changed_at, now())` }).where('id', '=', trackId).execute();
  await appendAudit(db, actor, {
    action: 'import',
    entity: 'track',
    entityId: trackId,
    after: {
      source: r.source,
      track: r.trackAction,
      added: r.added.length,
      changed: r.changed.map((c) => ({ id: c.id, from: c.fromVersion, to: c.toVersion })),
      unchanged: r.unchanged,
      keptNewer: r.keptNewer.length,
      categoriesAdded: r.categoriesAdded,
      questionsAdded: r.added.map((a) => a.id),
    },
  });
}

const hasChanges = (r: ImportTrackReport) => r.trackAction !== 'unchanged' || r.added.length > 0 || r.changed.length > 0 || r.categoriesAdded.length > 0 || r.categoriesChanged.length > 0;

/**
 * DB-2, DB-3: validates every file, reports what would change and, unless `dryRun`, applies it —
 * all inside one transaction, so either everything is imported or nothing is.
 */
export async function importQuestions(db: Executor, actor: AuditActor, files: readonly ImportFileInput[], opts: { dryRun: boolean }): Promise<ImportReport> {
  const run = async (trx: Executor): Promise<ImportReport> => {
    const known = (await trx.selectFrom('tracks').select('id').execute()).map((t) => t.id);
    const { parsed, problems } = parseFiles(files, known);
    const report: ImportReport = { ok: false, problems, tracks: [], dryRun: opts.dryRun, applied: false };
    if (problems.length) return report;
    const plans: TrackPlan[] = [];
    for (const p of parsed) {
      try {
        plans.push(p.kind === 'json' ? await planJson(trx, p.source, p.file) : await planCsv(trx, p.source, p.trackId, p.text));
      } catch (err) {
        if (err instanceof ImportProblem) problems.push({ source: err.source, messages: err.messages });
        else throw err;
      }
    }
    report.tracks = plans.map((p) => p.report);
    if (problems.length) return report;
    report.ok = true;
    if (!opts.dryRun) {
      for (const p of plans) if (hasChanges(p.report)) await applyPlan(trx, actor, p);
      if (plans.some((p) => hasChanges(p.report))) await publish(trx, { topic: 'bank', kind: 'import' });
      report.applied = true;
    }
    return report;
  };
  if (db.isTransaction) return run(db);
  return (db as Db).transaction().execute(run);
}

/** A plain-text report for the command line (and the same words as the app's report). */
export function formatReport(r: ImportReport): string {
  const out: string[] = [];
  if (r.problems.length) {
    out.push('Problems found — nothing was imported:');
    for (const p of r.problems) {
      out.push(`  ${p.source}:`);
      for (const m of p.messages.slice(0, 50)) out.push(`    - ${m}`);
      if (p.messages.length > 50) out.push(`    … and ${p.messages.length - 50} more`);
    }
    return out.join('\n');
  }
  for (const t of r.tracks) {
    const head = t.trackAction === 'create' ? 'new track' : t.trackAction === 'update' ? 'changes' : 'no changes';
    out.push(`${t.trackId} — ${t.name} (${t.source}): ${head}`);
    for (const c of t.trackChanges) out.push(`  track: ${c}`);
    if (t.categoriesAdded.length) out.push(`  categories added: ${t.categoriesAdded.length} (${t.categoriesAdded.join(', ')})`);
    if (t.categoriesChanged.length) out.push(`  categories changed: ${t.categoriesChanged.join(', ')}`);
    out.push(`  questions added: ${t.added.length}`);
    out.push(`  questions changed: ${t.changed.length}`);
    for (const c of t.changed.slice(0, 30)) out.push(`    - ${c.id}: version ${c.fromVersion} → ${c.toVersion} (${c.fields.join(', ') || 'version only'})`);
    out.push(`  questions unchanged: ${t.unchanged}`);
    if (t.keptNewer.length) {
      out.push(`  kept as they are (newer in the database than in the file): ${t.keptNewer.length}`);
      for (const k of t.keptNewer.slice(0, 30)) out.push(`    - ${k.id}: database version ${k.databaseVersion}, file version ${k.fileVersion}`);
    }
    if (t.notInFile) out.push(`  in the database but not in the file (left as they are): ${t.notInFile}`);
  }
  const added = r.tracks.reduce((n, t) => n + t.added.length, 0);
  const changed = r.tracks.reduce((n, t) => n + t.changed.length, 0);
  const unchanged = r.tracks.reduce((n, t) => n + t.unchanged, 0);
  out.push('');
  out.push(`Total: ${added} added, ${changed} changed, ${unchanged} unchanged.`);
  out.push(r.dryRun ? 'Dry run: nothing was written.' : added || changed || r.tracks.some(hasChanges) ? 'Imported.' : 'Nothing to change.');
  return out.join('\n');
}

