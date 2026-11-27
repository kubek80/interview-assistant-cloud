// ROUND-1…ROUND-5, FLOW-2…FLOW-9, TEAM-1, TEAM-2, TEAM-15: hiring rounds, their question sets and the
// interviews planned in them, in PostgreSQL. Every change:
//   - locks the round row first (`FOR UPDATE`) and re-checks that it is open, so closing a round,
//     editing its questions and planning interviews happen one at a time;
//   - is audited in the same transaction (HPRIV-4, AUD-2), with no candidate text in before/after;
//   - publishes `round:<id>` so the round's pages and the Dashboard of everyone on it refresh (HOST-5).
import { sql } from 'kysely';
import { json, type Executor } from '../db/pool';
import { appendAudit } from '../audit/audit';
import { publish } from '../live/bus';
import { conflict, invalid, notFound } from '../http/errors';
import type { Actor } from '../authz/policy';
import { canInRound } from '../authz/policy';
import { categoryFromRow, questionFromRow } from '../bank/service';
import { DEFAULT_QUOTAS, DEFAULT_TIME_BUDGET_MIN, candidateKey, cleanCandidate, drawBalanced, isValidCandidate, planFingerprint } from '../../src/domain/plan';
import { MAX_PANEL, MAX_PLAN_NOTE, MAX_REQUISITION, compareSchedule, interviewStatus, personName, retentionDate } from '../../src/domain/rounds';
import { isDay, isTimeOfDay } from '../../src/domain/team';
import type { PlanCategory, Question } from '../../src/domain/types';
import type {
  ChangeInterviewInput,
  InterviewDetail,
  InterviewSummary,
  PlanInterviewInput,
  PlanManyInput,
  QuestionSetDetail,
  QuestionSetInput,
  RoundCounts,
  RoundDetail,
  RoundMember,
  RoundRole,
  RoundSummary,
  TeamOption,
} from '../../src/shared/api';

const roundEvent = (db: Executor, roundId: string, kind: string, id?: string) => publish(db, { topic: `round:${roundId}`, kind, id });
/** Tells one person their list of rounds changed (they were added to or removed from a round). */
const userEvent = (db: Executor, userId: string) => publish(db, { topic: `user:${userId}`, kind: 'rounds' });

// ---------------------------------------------------------------------------------------------
// Reading

async function orgRetentionDays(db: Executor): Promise<number> {
  const r = await db.selectFrom('org_settings').select('default_retention_days').executeTakeFirst();
  return r?.default_retention_days ?? 90;
}

/** Counts of a round's interviews by status (cancelled ones are not counted). */
async function countsFor(db: Executor, roundIds: string[]): Promise<Map<string, RoundCounts>> {
  const out = new Map<string, RoundCounts>(roundIds.map((id) => [id, { upcoming: 0, inProgress: 0, waiting: 0, finished: 0 }]));
  if (!roundIds.length) return out;
  const rows = await db
    .selectFrom('interviews as i')
    .select(['i.round_id', 'i.state'])
    .select((eb) => eb.exists(eb.selectFrom('interview_panel as p').select('p.user_id').whereRef('p.interview_id', '=', 'i.id').where('p.status', '=', 'submitted')).as('some_submitted'))
    .where('i.round_id', 'in', roundIds)
    .where('i.state', '!=', 'cancelled')
    .execute();
  for (const r of rows) {
    const c = out.get(r.round_id)!;
    const s = interviewStatus(r.state, r.some_submitted ? ['submitted'] : []);
    if (s === 'upcoming') c.upcoming++;
    else if (s === 'in-progress') c.inProgress++;
    else if (s === 'waiting') c.waiting++;
    else if (s === 'finished') c.finished++;
  }
  return out;
}

/** ROUND-2: the rounds the actor is on; administrators see every round. Newest first, open before closed. */
export async function listRounds(db: Executor, actor: Actor): Promise<RoundSummary[]> {
  let q = db
    .selectFrom('rounds as r')
    .innerJoin('tracks as t', 't.id', 'r.track_id')
    .leftJoin('round_members as me', (j) => j.onRef('me.round_id', '=', 'r.id').on('me.user_id', '=', actor.id))
    .select(['r.id', 'r.name', 'r.track_id', 't.name as track_name', 'r.requisition_id', 'r.state', 'r.retention_until', 'r.created_at', 'me.role as my_role'])
    .orderBy(sql`r.state = 'closed'`)
    .orderBy('r.created_at', 'desc');
  if (actor.role !== 'admin') q = q.where('me.user_id', 'is not', null);
  const rows = await q.execute();
  const ids = rows.map((r) => r.id);
  const [counts, team] = await Promise.all([
    countsFor(db, ids),
    ids.length
      ? db
          .selectFrom('round_members as m')
          .innerJoin('users as u', 'u.id', 'm.user_id')
          .select(['m.round_id', 'u.id', 'u.name', 'u.email', 'm.role'])
          .where('m.round_id', 'in', ids)
          .orderBy(sql`m.role = 'interviewer'`)
          .orderBy(sql`lower(coalesce(u.name, u.email))`)
          .execute()
      : Promise.resolve([]),
  ]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    trackId: r.track_id,
    trackName: r.track_name,
    requisitionId: r.requisition_id,
    state: r.state,
    myRole: r.my_role ?? null,
    team: team.filter((m) => m.round_id === r.id).map((m) => ({ id: m.id, name: personName(m), role: m.role })),
    counts: counts.get(r.id)!,
    retentionUntil: r.retention_until,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function roundTeam(db: Executor, roundId: string): Promise<RoundMember[]> {
  const rows = await db
    .selectFrom('round_members as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select(['u.id', 'u.name', 'u.email', 'u.role as global_role', 'u.active', 'm.role'])
    .where('m.round_id', '=', roundId)
    .orderBy(sql`m.role = 'interviewer'`)
    .orderBy(sql`lower(coalesce(u.name, u.email))`)
    .execute();
  return rows.map((r) => ({ id: r.id, name: personName(r), email: r.email, role: r.role, globalRole: r.global_role, active: r.active }));
}

export async function loadRound(db: Executor, actor: Actor, roundId: string): Promise<RoundDetail> {
  const r = await db
    .selectFrom('rounds as r')
    .innerJoin('tracks as t', 't.id', 'r.track_id')
    .leftJoin('round_members as me', (j) => j.onRef('me.round_id', '=', 'r.id').on('me.user_id', '=', actor.id))
    .selectAll('r')
    .select(['t.name as track_name', 'me.role as my_role'])
    .where('r.id', '=', roundId)
    .executeTakeFirst();
  if (!r) throw notFound('That round');
  const [team, counts] = await Promise.all([roundTeam(db, roundId), countsFor(db, [roundId])]);
  const access = { roundId, memberRole: r.my_role ?? null, state: r.state };
  return {
    id: r.id,
    name: r.name,
    trackId: r.track_id,
    trackName: r.track_name,
    requisitionId: r.requisition_id,
    state: r.state,
    myRole: r.my_role ?? null,
    team,
    counts: counts.get(roundId)!,
    retentionUntil: r.retention_until,
    createdAt: r.created_at.toISOString(),
    hideOthersScores: r.hide_others_scores,
    closedAt: r.closed_at?.toISOString() ?? null,
    closeReason: r.close_reason,
    defaultQuestionSetId: r.default_question_set_id,
    // ROUND-5: on a closed round, organisers may only reopen it; planning is refused.
    canManage: canInRound(actor, 'round.manage', access),
    canPlan: canInRound(actor, 'round.plan', access),
  };
}

/** ROUND-2: who can be put on a team: active people who are not question reviewers (REVIEW-1). */
export async function teamOptions(db: Executor): Promise<TeamOption[]> {
  const rows = await db.selectFrom('users').select(['id', 'name', 'email', 'role']).where('active', '=', true).where('role', '!=', 'reviewer').orderBy(sql`lower(coalesce(name, email))`).execute();
  return rows.map((u) => ({ id: u.id, name: personName(u), email: u.email, globalRole: u.role, canOrganise: u.role === 'admin' || u.role === 'organiser' }));
}

// ---------------------------------------------------------------------------------------------
// Rounds

/** Locks the round for this transaction; refuses changes to a closed one (ROUND-5). */
export async function lockRound(db: Executor, roundId: string, opts: { allowClosed?: boolean } = {}) {
  const r = await db.selectFrom('rounds').selectAll().where('id', '=', roundId).forUpdate().executeTakeFirst();
  if (!r) throw notFound('That round');
  if (r.state === 'closed' && !opts.allowClosed) throw conflict('This round is closed, so it cannot be changed. Reopen it first.');
  return r;
}

function cleanOptional(v: string | null | undefined): string | null {
  const t = (v ?? '').trim().replace(/\s+/g, ' ');
  return t ? t : null;
}

export async function createRound(db: Executor, actor: Actor, input: { name: string; trackId: string; requisitionId?: string | null }): Promise<string> {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (!name) throw invalid('Give the round a name.', { name: 'Give the round a name.' });
  const track = await db.selectFrom('tracks').select(['id', 'name', 'version']).where('id', '=', input.trackId).executeTakeFirst();
  if (!track) throw invalid('Choose a role.', { trackId: 'Choose a role.' });
  const days = await orgRetentionDays(db);
  const round = await db
    .insertInto('rounds')
    .values({ name, track_id: track.id, requisition_id: cleanOptional(input.requisitionId), retention_until: retentionDate(days), created_by: actor.id })
    .returning(['id', 'retention_until'])
    .executeTakeFirstOrThrow();
  // The person who creates it organises it (ROUND-1).
  await db.insertInto('round_members').values({ round_id: round.id, user_id: actor.id, role: 'organiser', added_by: actor.id }).execute();
  // ROUND-3, UX-2: a balanced default set, already drawn.
  const set = await drawDefaultSet(db, actor, round.id, track.id, `${name} questions`);
  await db.updateTable('rounds').set({ default_question_set_id: set.id }).where('id', '=', round.id).execute();
  await appendAudit(db, actor, {
    action: 'round.created',
    entity: 'round',
    entityId: round.id,
    roundId: round.id,
    after: { name, trackId: track.id, requisitionId: cleanOptional(input.requisitionId), retentionUntil: round.retention_until, questionSetId: set.id, fingerprint: set.fingerprint },
  });
  await userEvent(db, actor.id);
  await publish(db, { topic: 'rounds', kind: 'created', id: round.id });
  return round.id;
}

export async function updateRound(
  db: Executor,
  actor: Actor,
  roundId: string,
  patch: { name?: string; requisitionId?: string | null; retentionUntil?: string; hideOthersScores?: boolean },
): Promise<void> {
  const r = await lockRound(db, roundId);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim().replace(/\s+/g, ' ');
    if (!name) throw invalid('Give the round a name.', { name: 'Give the round a name.' });
    if (name !== r.name) [before.name, after.name, set.name] = [r.name, name, name];
  }
  if (patch.requisitionId !== undefined) {
    const req = cleanOptional(patch.requisitionId);
    if (req !== r.requisition_id) [before.requisitionId, after.requisitionId, set.requisition_id] = [r.requisition_id, req, req];
  }
  if (patch.retentionUntil !== undefined && patch.retentionUntil !== r.retention_until) {
    if (!isDay(patch.retentionUntil)) throw invalid('Enter a date.', { retentionUntil: 'Enter a date.' });
    if (patch.retentionUntil < new Date().toISOString().slice(0, 10)) throw invalid('Choose a date from today on.', { retentionUntil: 'Choose a date from today on.' });
    [before.retentionUntil, after.retentionUntil, set.retention_until] = [r.retention_until, patch.retentionUntil, patch.retentionUntil];
  }
  if (patch.hideOthersScores !== undefined && patch.hideOthersScores !== r.hide_others_scores) {
    [before.hideOthersScores, after.hideOthersScores, set.hide_others_scores] = [r.hide_others_scores, patch.hideOthersScores, patch.hideOthersScores];
  }
  if (!Object.keys(set).length) return;
  await db.updateTable('rounds').set({ ...set, updated_at: new Date() }).where('id', '=', roundId).execute();
  // PRIV-5: interviews follow their round's retention date while they have not started.
  if (set.retention_until) await db.updateTable('interviews').set({ retention_until: set.retention_until as string }).where('round_id', '=', roundId).where('state', '=', 'planned').execute();
  await appendAudit(db, actor, { action: 'round.changed', entity: 'round', entityId: roundId, roundId, before, after });
  await roundEvent(db, roundId, 'round');
}

export async function closeRound(db: Executor, actor: Actor, roundId: string, reason: string | null): Promise<void> {
  const r = await lockRound(db, roundId, { allowClosed: true });
  if (r.state === 'closed') return;
  await db.updateTable('rounds').set({ state: 'closed', closed_at: new Date(), closed_by: actor.id, close_reason: reason?.trim() || null, updated_at: new Date() }).where('id', '=', roundId).execute();
  await appendAudit(db, actor, { action: 'round.closed', entity: 'round', entityId: roundId, roundId, before: { state: 'open' }, after: { state: 'closed' }, reason: reason?.trim() || null });
  await roundEvent(db, roundId, 'round');
}

export async function reopenRound(db: Executor, actor: Actor, roundId: string, reason: string): Promise<void> {
  const r = await lockRound(db, roundId, { allowClosed: true });
  if (r.state === 'open') return;
  if (!reason.trim()) throw invalid('Say why the round is reopened.', { reason: 'Say why the round is reopened.' });
  await db.updateTable('rounds').set({ state: 'open', closed_at: null, closed_by: null, close_reason: null, updated_at: new Date() }).where('id', '=', roundId).execute();
  await appendAudit(db, actor, { action: 'round.reopened', entity: 'round', entityId: roundId, roundId, before: { state: 'closed' }, after: { state: 'open' }, reason: reason.trim() });
  await roundEvent(db, roundId, 'round');
}

// ---------------------------------------------------------------------------------------------
// Team (ROUND-2)

async function organiserCount(db: Executor, roundId: string): Promise<number> {
  const r = await db.selectFrom('round_members').select((eb) => eb.fn.countAll<number>().as('n')).where('round_id', '=', roundId).where('role', '=', 'organiser').executeTakeFirst();
  return Number(r?.n ?? 0);
}

/** Checks that a person may be on the team in that role (ROUND-2, REVIEW-1). */
async function eligible(db: Executor, userId: string, role: RoundRole) {
  const u = await db.selectFrom('users').select(['id', 'email', 'name', 'role', 'active']).where('id', '=', userId).executeTakeFirst();
  if (!u) throw notFound('That person');
  if (u.role === 'reviewer') throw invalid('Question reviewers cannot be on a round’s team. They see only the question bank.');
  if (!u.active) throw invalid(`${personName(u)} is deactivated, so they cannot be added.`);
  if (role === 'organiser' && u.role !== 'admin' && u.role !== 'organiser') throw invalid(`${personName(u)} is an interviewer. Only organisers and administrators can organise a round.`);
  return u;
}

export async function setMember(db: Executor, actor: Actor, roundId: string, userId: string, role: RoundRole): Promise<void> {
  await lockRound(db, roundId);
  const u = await eligible(db, userId, role);
  const existing = await db.selectFrom('round_members').select('role').where('round_id', '=', roundId).where('user_id', '=', userId).executeTakeFirst();
  if (existing?.role === role) return;
  if (existing?.role === 'organiser' && (await organiserCount(db, roundId)) <= 1) throw conflict('A round needs at least one organiser. Make someone else an organiser first.');
  if (existing) await db.updateTable('round_members').set({ role }).where('round_id', '=', roundId).where('user_id', '=', userId).execute();
  else await db.insertInto('round_members').values({ round_id: roundId, user_id: userId, role, added_by: actor.id }).execute();
  await appendAudit(db, actor, {
    action: existing ? 'round.member_changed' : 'round.member_added',
    entity: 'round',
    entityId: roundId,
    roundId,
    before: existing ? { user: u.email, role: existing.role } : null,
    after: { user: u.email, role },
  });
  await roundEvent(db, roundId, 'team', userId);
  await userEvent(db, userId);
}

export async function removeMember(db: Executor, actor: Actor, roundId: string, userId: string): Promise<void> {
  await lockRound(db, roundId);
  const m = await db
    .selectFrom('round_members as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select(['m.role', 'u.email', 'u.name'])
    .where('m.round_id', '=', roundId)
    .where('m.user_id', '=', userId)
    .executeTakeFirst();
  if (!m) throw notFound('That team member');
  if (m.role === 'organiser' && (await organiserCount(db, roundId)) <= 1) throw conflict('A round needs at least one organiser. Make someone else an organiser first.');
  const onPanels = await db
    .selectFrom('interview_panel as p')
    .innerJoin('interviews as i', 'i.id', 'p.interview_id')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('i.round_id', '=', roundId)
    .where('i.state', '!=', 'cancelled')
    .where('p.user_id', '=', userId)
    .executeTakeFirst();
  const n = Number(onPanels?.n ?? 0);
  if (n > 0) throw conflict(`${personName(m)} is on the panel of ${n} interview${n === 1 ? '' : 's'} in this round. Take them off ${n === 1 ? 'it' : 'those'} first.`);
  await db.deleteFrom('round_members').where('round_id', '=', roundId).where('user_id', '=', userId).execute();
  await appendAudit(db, actor, { action: 'round.member_removed', entity: 'round', entityId: roundId, roundId, before: { user: m.email, role: m.role } });
  await roundEvent(db, roundId, 'team', userId);
  await userEvent(db, userId);
}

// ---------------------------------------------------------------------------------------------
// Question sets (ROUND-3, FLOW-2…FLOW-9)

type SetRow = Awaited<ReturnType<typeof loadSetRow>>;
async function loadSetRow(db: Executor, setId: string, lock = false) {
  let q = db.selectFrom('question_sets').selectAll().where('id', '=', setId);
  if (lock) q = q.forUpdate();
  const r = await q.executeTakeFirst();
  if (!r) throw notFound('That question set');
  return r;
}

export async function setDetail(db: Executor, row: NonNullable<SetRow>): Promise<QuestionSetDetail> {
  const [used, round] = await Promise.all([
    db.selectFrom('interviews').select((eb) => eb.fn.countAll<number>().as('n')).where('question_set_id', '=', row.id).where('state', '!=', 'cancelled').executeTakeFirst(),
    row.round_id ? db.selectFrom('rounds').select('default_question_set_id').where('id', '=', row.round_id).executeTakeFirst() : Promise.resolve(undefined),
  ]);
  return {
    id: row.id,
    roundId: row.round_id,
    trackId: row.track_id,
    trackVersion: row.track_version,
    name: row.name,
    questions: row.questions,
    categories: row.categories,
    timeBudgetMin: row.time_budget_min,
    fingerprint: row.fingerprint,
    fixed: !!row.fixed_at,
    fixedAt: row.fixed_at?.toISOString() ?? null,
    interviews: Number(used?.n ?? 0),
    isRoundDefault: round?.default_question_set_id === row.id,
    version: row.version,
  };
}

export async function loadSet(db: Executor, setId: string): Promise<QuestionSetDetail> {
  return setDetail(db, await loadSetRow(db, setId));
}

/** The track's questions and categories from the bank. */
async function trackBank(db: Executor, trackId: string) {
  const [track, categories, questions] = await Promise.all([
    db.selectFrom('tracks').select(['id', 'version']).where('id', '=', trackId).executeTakeFirst(),
    db.selectFrom('categories').selectAll().where('track_id', '=', trackId).orderBy('position').orderBy('id').execute(),
    db.selectFrom('questions').selectAll().where('track_id', '=', trackId).orderBy('number').execute(),
  ]);
  if (!track) throw notFound('That role');
  return { track, categories: categories.map(categoryFromRow), questions: questions.map(questionFromRow) };
}

async function drawDefaultSet(db: Executor, actor: Actor, roundId: string, trackId: string, name: string) {
  const bank = await trackBank(db, trackId);
  const draw = drawBalanced(bank.questions, DEFAULT_QUOTAS, DEFAULT_TIME_BUDGET_MIN, Math.floor(Math.random() * 2 ** 31));
  if (!draw.questions.length) throw invalid('This role has no questions in the bank yet. Add some first.');
  const categories: PlanCategory[] = bank.categories.map((c) => ({ ...c }));
  const fingerprint = planFingerprint({ trackId, questions: draw.questions, categories });
  return db
    .insertInto('question_sets')
    .values({ round_id: roundId, track_id: trackId, track_version: bank.track.version, name: name.slice(0, 200), questions: json(draw.questions), categories: json(categories), time_budget_min: DEFAULT_TIME_BUDGET_MIN, fingerprint, created_by: actor.id })
    .returning(['id', 'fingerprint'])
    .executeTakeFirstOrThrow();
}

/** Builds a set from the editor's input: snapshots from the bank, the set's own weights (FLOW-6). */
async function buildSet(db: Executor, trackId: string, input: QuestionSetInput, keep: readonly Question[] = []) {
  const bank = await trackBank(db, trackId);
  const byId = new Map(bank.questions.map((q) => [q.id, q]));
  const kept = new Map(keep.map((q) => [q.id, q]));
  if (!input.questionIds.length) throw invalid('Add at least one question.', { questions: 'Add at least one question.' });
  if (new Set(input.questionIds).size !== input.questionIds.length) throw invalid('A question is in the set twice.');
  const questions: Question[] = [];
  for (const id of input.questionIds) {
    const q = byId.get(id);
    if (!q) throw invalid(`Question ${id} is not in this role’s question bank.`);
    // A retired question is not offered (BANK-10), but one already in the set may stay.
    if (q.status === 'retired' && !kept.has(id)) throw invalid(`Question ${q.number} is retired, so it cannot be added.`);
    questions.push(q);
  }
  const overrides = new Map(input.categories.map((c) => [c.id, c]));
  for (const c of input.categories) if (!bank.categories.some((b) => b.id === c.id)) throw invalid('A category is not in this role.');
  const categories: PlanCategory[] = bank.categories.map((c) => {
    const o = overrides.get(c.id);
    return o ? { ...c, weight: Math.round(o.weight * 100) / 100, mustHave: o.mustHave } : { ...c };
  });
  const fingerprint = planFingerprint({ trackId, questions, categories });
  return { questions, categories, fingerprint, trackVersion: bank.track.version };
}

/**
 * FLOW-8: fixes a set when the first interview that uses it is planned. Its question snapshots are
 * taken from the bank now (the questions as they are at this moment) and never change afterwards.
 */
export async function fixSet(db: Executor, actor: Actor, setId: string): Promise<{ id: string; fingerprint: string }> {
  const row = await loadSetRow(db, setId, true);
  if (row.fixed_at) return { id: row.id, fingerprint: row.fingerprint };
  const built = await buildSet(
    db,
    row.track_id,
    { questionIds: row.questions.map((q) => q.id), categories: row.categories.map((c) => ({ id: c.id, weight: c.weight, mustHave: c.mustHave })), timeBudgetMin: row.time_budget_min },
    row.questions,
  );
  await db
    .updateTable('question_sets')
    .set({ questions: json(built.questions), categories: json(built.categories), fingerprint: built.fingerprint, track_version: built.trackVersion, fixed_at: new Date(), updated_at: new Date(), version: sql`version + 1` })
    .where('id', '=', setId)
    .execute();
  await appendAudit(db, actor, { action: 'question_set.fixed', entity: 'question_set', entityId: setId, roundId: row.round_id, after: { fingerprint: built.fingerprint, questions: built.questions.map((q) => [q.id, q.version]) } });
  return { id: setId, fingerprint: built.fingerprint };
}

/**
 * ROUND-3, UX-3: saves the round's questions as edited. A set not used yet is changed in place; a
 * fixed one is left alone and a new set is made for future interviews (FLOW-9).
 */
export async function saveRoundSet(db: Executor, actor: Actor, roundId: string, input: QuestionSetInput & { baseSetId: string; baseVersion: number }) {
  const round = await lockRound(db, roundId);
  if (round.default_question_set_id !== input.baseSetId) throw conflict('Someone else changed this round’s questions meanwhile. The latest questions are shown now.');
  const current = await loadSetRow(db, input.baseSetId, true);
  if (!current.fixed_at && current.version !== input.baseVersion) throw conflict('Someone else changed this round’s questions meanwhile. The latest questions are shown now.');
  const built = await buildSet(db, round.track_id, input, current.questions);
  const name = (input.name?.trim() || current.name).slice(0, 200);
  const summary = (qs: readonly Question[], budget: number, fp: string) => ({ questions: qs.map((q) => q.id), timeBudgetMin: budget, fingerprint: fp });
  if (!current.fixed_at) {
    await db
      .updateTable('question_sets')
      .set({ questions: json(built.questions), categories: json(built.categories), fingerprint: built.fingerprint, track_version: built.trackVersion, time_budget_min: input.timeBudgetMin, name, updated_at: new Date(), version: sql`version + 1` })
      .where('id', '=', current.id)
      .execute();
    await appendAudit(db, actor, {
      action: 'question_set.changed',
      entity: 'question_set',
      entityId: current.id,
      roundId,
      before: summary(current.questions, current.time_budget_min, current.fingerprint),
      after: summary(built.questions, input.timeBudgetMin, built.fingerprint),
    });
    await roundEvent(db, roundId, 'questions', current.id);
    return { set: await loadSet(db, current.id), replaced: false };
  }
  const created = await db
    .insertInto('question_sets')
    .values({ round_id: roundId, track_id: round.track_id, track_version: built.trackVersion, name, questions: json(built.questions), categories: json(built.categories), time_budget_min: input.timeBudgetMin, fingerprint: built.fingerprint, created_by: actor.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db.updateTable('rounds').set({ default_question_set_id: created.id, updated_at: new Date() }).where('id', '=', roundId).execute();
  await appendAudit(db, actor, {
    action: 'question_set.replaced',
    entity: 'question_set',
    entityId: created.id,
    roundId,
    before: { questionSetId: current.id, ...summary(current.questions, current.time_budget_min, current.fingerprint) },
    after: { questionSetId: created.id, ...summary(built.questions, input.timeBudgetMin, built.fingerprint) },
  });
  await roundEvent(db, roundId, 'questions', created.id);
  return { set: await loadSet(db, created.id), replaced: true };
}

/** "Use different questions for this interview": a set of its own, fixed at once (FLOW-8). */
async function interviewSet(db: Executor, actor: Actor, round: { id: string; track_id: string; name: string }, input: QuestionSetInput): Promise<{ id: string; fingerprint: string }> {
  const built = await buildSet(db, round.track_id, input);
  const r = await db
    .insertInto('question_sets')
    .values({
      round_id: round.id,
      track_id: round.track_id,
      track_version: built.trackVersion,
      name: (input.name?.trim() || `${round.name}: questions for one interview`).slice(0, 200),
      questions: json(built.questions),
      categories: json(built.categories),
      time_budget_min: input.timeBudgetMin,
      fingerprint: built.fingerprint,
      created_by: actor.id,
      fixed_at: new Date(),
    })
    .returning(['id', 'fingerprint'])
    .executeTakeFirstOrThrow();
  await appendAudit(db, actor, { action: 'question_set.fixed', entity: 'question_set', entityId: r.id, roundId: round.id, after: { fingerprint: r.fingerprint, questions: built.questions.map((q) => [q.id, q.version]), ownSet: true } });
  return r;
}

// ---------------------------------------------------------------------------------------------
// Interviews (ROUND-4, TEAM-1, TEAM-2, TEAM-15, PANEL-1)

interface ScheduleFields {
  date?: string | null;
  time?: string | null;
  note?: string;
}

/** TEAM-1: the optional day, time and note; problems as plain sentences. */
export function scheduleProblems(s: ScheduleFields): string[] {
  const p: string[] = [];
  if (s.date && !isDay(s.date)) p.push('The date is not a real day (use 2026-12-01).');
  if (s.time && !isTimeOfDay(s.time)) p.push('The time is not valid (use 14:30).');
  else if (s.time && !s.date) p.push('A time needs a date.');
  if ((s.note ?? '').length > MAX_PLAN_NOTE) p.push(`Keep the note under ${MAX_PLAN_NOTE} characters.`);
  return p;
}

function candidateProblems(name: string, requisitionId: string | null | undefined): string[] {
  const p: string[] = [];
  const c = cleanCandidate(name);
  if (!c) p.push('Enter the candidate’s name or initials.');
  else if (!isValidCandidate(c)) p.push('The candidate’s name or initials can have letters, spaces, hyphens, apostrophes and full stops only, up to 60 characters.');
  if ((requisitionId ?? '').trim().length > MAX_REQUISITION) p.push(`The requisition id is longer than ${MAX_REQUISITION} characters.`);
  return p;
}

async function teamIds(db: Executor, roundId: string): Promise<Set<string>> {
  const rows = await db.selectFrom('round_members').select('user_id').where('round_id', '=', roundId).execute();
  return new Set(rows.map((r) => r.user_id));
}

function panelProblems(panel: readonly string[], team: ReadonlySet<string>): string[] {
  if (!panel.length) return ['Choose at least one person for the panel.'];
  if (new Set(panel).size !== panel.length) return ['Someone is on the panel twice.'];
  if (panel.length > MAX_PANEL) return [`At most ${MAX_PANEL} people on a panel.`];
  if (panel.some((id) => !team.has(id))) return ['Everyone on the panel must be on the round’s team.'];
  return [];
}

/** PRIV-1: one candidate per name or initials plus requisition id in a round (FLOW-29 key). */
async function candidateFor(db: Executor, actor: Actor, roundId: string, name: string, requisitionId: string | null | undefined): Promise<string> {
  const display = cleanCandidate(name);
  const req = cleanOptional(requisitionId);
  const key = candidateKey({ initials: display, requisitionId: req });
  const r = await db
    .insertInto('candidates')
    .values({ round_id: roundId, display_name: display, requisition_id: req, key, created_by: actor.id })
    .onConflict((oc) => oc.columns(['round_id', 'key']).doUpdateSet({ key: (eb) => eb.ref('excluded.key') }))
    .returning('id')
    .executeTakeFirstOrThrow();
  return r.id;
}

async function insertInterview(
  db: Executor,
  actor: Actor,
  round: { id: string; retention_until: string },
  v: { candidateId: string; setId: string; date: string | null; time: string | null; note: string; recordingNotice: boolean; panel: string[] },
): Promise<string> {
  const i = await db
    .insertInto('interviews')
    .values({
      round_id: round.id,
      candidate_id: v.candidateId,
      question_set_id: v.setId,
      scheduled_date: v.date,
      scheduled_time: v.time,
      note: v.note || null,
      recording_notice: v.recordingNotice,
      retention_until: round.retention_until,
      created_by: actor.id,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db.insertInto('interview_panel').values(v.panel.map((user_id) => ({ interview_id: i.id, user_id }))).execute();
  return i.id;
}

export async function planInterview(db: Executor, actor: Actor, roundId: string, input: PlanInterviewInput): Promise<string> {
  const round = await lockRound(db, roundId);
  const team = await teamIds(db, roundId);
  const problems = [...candidateProblems(input.candidate.name, input.candidate.requisitionId), ...scheduleProblems(input), ...panelProblems(input.panel, team)];
  if (problems.length) throw invalid(problems.length === 1 ? problems[0] : 'Some details need fixing.', problems);
  const set = input.questions ? await interviewSet(db, actor, round, input.questions) : await fixSet(db, actor, round.default_question_set_id!);
  const candidateId = await candidateFor(db, actor, roundId, input.candidate.name, input.candidate.requisitionId);
  const id = await insertInterview(db, actor, round, {
    candidateId,
    setId: set.id,
    date: input.date || null,
    time: input.time || null,
    note: (input.note ?? '').trim(),
    recordingNotice: !!input.recordingNotice,
    panel: input.panel,
  });
  await appendAudit(db, actor, {
    action: 'interview.planned',
    entity: 'interview',
    entityId: id,
    roundId,
    after: { candidateId, questionSetId: set.id, fingerprint: set.fingerprint, date: input.date || null, time: input.time || null, panel: input.panel, recordingNotice: !!input.recordingNotice },
  });
  await roundEvent(db, roundId, 'interview', id);
  return id;
}

/** TEAM-15: every line becomes an interview with the round's questions, or nothing is created. */
export async function planMany(db: Executor, actor: Actor, roundId: string, input: PlanManyInput): Promise<string[]> {
  const round = await lockRound(db, roundId);
  for (const userId of input.addToTeam ?? []) {
    const already = await db.selectFrom('round_members').select('role').where('round_id', '=', roundId).where('user_id', '=', userId).executeTakeFirst();
    if (!already) await setMember(db, actor, roundId, userId, 'interviewer');
  }
  const team = await teamIds(db, roundId);
  const problems: string[] = [];
  input.lines.forEach((l, i) => {
    for (const p of [...candidateProblems(l.candidate, l.requisitionId), ...scheduleProblems(l), ...panelProblems(l.panel, team)]) problems.push(`Line ${i + 1}: ${p}`);
  });
  if (!input.lines.length) problems.push('There is nothing to plan.');
  if (problems.length) throw invalid('Nothing was planned: some lines need fixing.', problems.slice(0, 50));
  const set = await fixSet(db, actor, round.default_question_set_id!);
  const ids: string[] = [];
  for (const l of input.lines) {
    const candidateId = await candidateFor(db, actor, roundId, l.candidate, l.requisitionId);
    ids.push(await insertInterview(db, actor, round, { candidateId, setId: set.id, date: l.date || null, time: l.time || null, note: (l.note ?? '').trim(), recordingNotice: !!input.recordingNotice, panel: l.panel }));
  }
  await appendAudit(db, actor, { action: 'interview.planned_many', entity: 'round', entityId: roundId, roundId, after: { interviews: ids, questionSetId: set.id, fingerprint: set.fingerprint } });
  await roundEvent(db, roundId, 'interviews');
  return ids;
}

async function lockInterview(db: Executor, interviewId: string) {
  const i = await db.selectFrom('interviews').selectAll().where('id', '=', interviewId).forUpdate().executeTakeFirst();
  if (!i || i.state === 'cancelled') throw notFound('That interview');
  return i;
}

async function panelOf(db: Executor, interviewId: string): Promise<string[]> {
  return (await db.selectFrom('interview_panel').select('user_id').where('interview_id', '=', interviewId).orderBy('user_id').execute()).map((r) => r.user_id);
}

/** TEAM-2: change the day, time, panel, note or recording notice of an interview that has not started. */
export async function changeInterview(db: Executor, actor: Actor, interviewId: string, input: ChangeInterviewInput): Promise<void> {
  const i = await lockInterview(db, interviewId);
  await lockRound(db, i.round_id);
  if (i.state !== 'planned') throw conflict('This interview has started, so its plan cannot be changed any more.');
  const date = input.date === undefined ? i.scheduled_date : input.date || null;
  const time = input.time === undefined ? (input.date === null ? null : i.scheduled_time) : input.time || null;
  const problems = scheduleProblems({ date, time, note: input.note });
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const set: Record<string, unknown> = {};
  if (date !== i.scheduled_date) [before.date, after.date, set.scheduled_date] = [i.scheduled_date, date, date];
  if (time !== i.scheduled_time) [before.time, after.time, set.scheduled_time] = [i.scheduled_time, time, time];
  if (input.note !== undefined && (input.note.trim() || null) !== i.note) {
    set.note = input.note.trim() || null;
    after.noteChanged = true;
  }
  if (input.recordingNotice !== undefined && input.recordingNotice !== i.recording_notice) [before.recordingNotice, after.recordingNotice, set.recording_notice] = [i.recording_notice, input.recordingNotice, input.recordingNotice];
  let newPanel: string[] | null = null;
  if (input.panel) {
    problems.push(...panelProblems(input.panel, await teamIds(db, i.round_id)));
    const old = await panelOf(db, interviewId);
    if ([...input.panel].sort().join() !== old.join()) {
      newPanel = input.panel;
      [before.panel, after.panel] = [old, input.panel];
    }
  }
  if (problems.length) throw invalid(problems.length === 1 ? problems[0] : 'Some details need fixing.', problems);
  if (!Object.keys(set).length && !newPanel) return;
  if (Object.keys(set).length) await db.updateTable('interviews').set({ ...set, updated_at: new Date(), version: sql`version + 1` }).where('id', '=', interviewId).execute();
  if (newPanel) {
    await db.deleteFrom('interview_panel').where('interview_id', '=', interviewId).where('user_id', 'not in', newPanel).execute();
    await db
      .insertInto('interview_panel')
      .values(newPanel.map((user_id) => ({ interview_id: interviewId, user_id })))
      .onConflict((oc) => oc.columns(['interview_id', 'user_id']).doNothing())
      .execute();
    if (!Object.keys(set).length) await db.updateTable('interviews').set({ updated_at: new Date(), version: sql`version + 1` }).where('id', '=', interviewId).execute();
  }
  await appendAudit(db, actor, { action: 'interview.changed', entity: 'interview', entityId: interviewId, roundId: i.round_id, before, after });
  await roundEvent(db, i.round_id, 'interview', interviewId);
}

/** TEAM-2, AUD-2: cancel an interview that has not started (kept, marked cancelled, audited). */
export async function cancelInterview(db: Executor, actor: Actor, interviewId: string, reason: string | null): Promise<void> {
  const i = await lockInterview(db, interviewId);
  await lockRound(db, i.round_id);
  if (i.state !== 'planned') throw conflict('This interview has started, so it cannot be cancelled.');
  await db.updateTable('interviews').set({ state: 'cancelled', cancelled_at: new Date(), cancelled_by: actor.id, updated_at: new Date(), version: sql`version + 1` }).where('id', '=', interviewId).execute();
  await appendAudit(db, actor, { action: 'interview.cancelled', entity: 'interview', entityId: interviewId, roundId: i.round_id, before: { state: 'planned' }, after: { state: 'cancelled' }, reason: reason?.trim() || null });
  await roundEvent(db, i.round_id, 'interview', interviewId);
}

// ---------------------------------------------------------------------------------------------
// Listing interviews

export async function interviewSummaries(db: Executor, actor: Actor, where: { roundIds?: string[]; ids?: string[] }): Promise<InterviewSummary[]> {
  if ((where.roundIds && !where.roundIds.length) || (where.ids && !where.ids.length)) return [];
  let q = db
    .selectFrom('interviews as i')
    .innerJoin('candidates as c', 'c.id', 'i.candidate_id')
    .innerJoin('rounds as r', 'r.id', 'i.round_id')
    .innerJoin('question_sets as s', 's.id', 'i.question_set_id')
    .select([
      'i.id',
      'i.round_id',
      'r.name as round_name',
      'r.state as round_state',
      'r.track_id',
      'r.default_question_set_id',
      'c.id as candidate_id',
      'c.display_name',
      'c.requisition_id',
      'i.scheduled_date',
      'i.scheduled_time',
      'i.state',
      'i.note',
      'i.recording_notice',
      'i.created_at',
      's.id as set_id',
      's.name as set_name',
      's.fingerprint',
    ])
    .select([
      sql<number>`jsonb_array_length(s.questions)`.as('set_questions'),
      sql<number>`(SELECT coalesce(sum((q->>'timeMin')::int), 0) FROM jsonb_array_elements(s.questions) q)`.as('set_minutes'),
    ])
    .where('i.state', '!=', 'cancelled');
  if (where.roundIds) q = q.where('i.round_id', 'in', where.roundIds);
  if (where.ids) q = q.where('i.id', 'in', where.ids);
  const rows = await q.execute();
  const ids = rows.map((r) => r.id);
  const panel = ids.length
    ? await db
        .selectFrom('interview_panel as p')
        .innerJoin('users as u', 'u.id', 'p.user_id')
        .select(['p.interview_id', 'u.id', 'u.name', 'u.email', 'p.status'])
        .where('p.interview_id', 'in', ids)
        .orderBy(sql`lower(coalesce(u.name, u.email))`)
        .execute()
    : [];
  const byInterview = new Map<string, typeof panel>();
  for (const p of panel) byInterview.set(p.interview_id, [...(byInterview.get(p.interview_id) ?? []), p]);
  return rows
    .map((r): InterviewSummary => {
      const members = byInterview.get(r.id) ?? [];
      return {
        id: r.id,
        roundId: r.round_id,
        roundName: r.round_name,
        roundState: r.round_state,
        trackId: r.track_id,
        candidate: { id: r.candidate_id, name: r.display_name, requisitionId: r.requisition_id },
        date: r.scheduled_date,
        time: r.scheduled_time,
        state: r.state as InterviewSummary['state'],
        status: interviewStatus(r.state, members.map((m) => m.status))!,
        panel: members.map((m) => ({ id: m.id, name: personName(m), status: m.status })),
        onMyPanel: members.some((m) => m.id === actor.id),
        note: r.note ?? '',
        recordingNotice: r.recording_notice,
        questionSet: { id: r.set_id, name: r.set_name, fingerprint: r.fingerprint, questions: Number(r.set_questions), minutes: Number(r.set_minutes), isRoundDefault: r.set_id === r.default_question_set_id },
        createdAt: r.created_at.toISOString(),
      };
    })
    .sort((a, b) => compareSchedule(a, b));
}

/** FLOW-1, FLOW-34, TEAM-16: every interview in the rounds the actor is on (administrators: theirs too). */
export async function myInterviews(db: Executor, actor: Actor): Promise<InterviewSummary[]> {
  const rounds = await db.selectFrom('round_members').select('round_id').where('user_id', '=', actor.id).execute();
  return interviewSummaries(db, actor, { roundIds: rounds.map((r) => r.round_id) });
}

export async function loadInterview(db: Executor, actor: Actor, interviewId: string): Promise<InterviewDetail> {
  const [summary] = await interviewSummaries(db, actor, { ids: [interviewId] });
  if (!summary) throw notFound('That interview');
  const extra = await db
    .selectFrom('interviews as i')
    .innerJoin('rounds as r', 'r.id', 'i.round_id')
    .innerJoin('tracks as t', 't.id', 'r.track_id')
    .leftJoin('round_members as me', (j) => j.onRef('me.round_id', '=', 'r.id').on('me.user_id', '=', actor.id))
    .select(['t.name as track_name', 'i.retention_until', 'r.state as round_state', 'me.role as my_role'])
    .where('i.id', '=', interviewId)
    .executeTakeFirstOrThrow();
  return {
    ...summary,
    trackName: extra.track_name,
    retentionUntil: extra.retention_until,
    set: await loadSet(db, summary.questionSet.id),
    canPlan: summary.state === 'planned' && canInRound(actor, 'round.plan', { roundId: summary.roundId, memberRole: extra.my_role ?? null, state: extra.round_state }),
  };
}

