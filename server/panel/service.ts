// The debrief, the panel decision, judgements entered on someone's behalf, written summaries, the
// Summary and the round report (LIVE-9, TEAM-6…TEAM-12, SUM-1…SUM-6, SCORE-11, FLOW-28, FLOW-30,
// PANEL-5, ROUND-5, ROUND-6), in PostgreSQL.
//
// Reading: loadPanels() is the one query path for one interview or every interview of several rounds:
// a fixed number of queries whatever the count (interviews, their question sets, panels, records,
// answers, notes, decisions, summaries), no query per interview (SUM-6). The figures are then worked
// out per reader by the pure src/domain/panel.ts, which applies the round's "hide other people's
// scores" rule (LIVE-3, FLOW-27) to every judgement, the decision and anything made from them, so the
// debrief, the candidate page, the Summary and every export show the same thing to the same person.
//
// Writing: each change locks its interview (FOR UPDATE), checks the policy (canOnInterview), writes
// its audit entry in the same transaction (HPRIV-4, AUD-2, AUD-4) and publishes `interview:<id>`
// ("records") and `round:<id>` so the debrief, the Summary and the Dashboard refresh for everyone.
// Nothing here ever changes a panel member's own record (TEAM-11).
import { sql } from 'kysely';
import { json, type Executor } from '../db/pool';
import { appendAudit } from '../audit/audit';
import { publish } from '../live/bus';
import { ApiError, conflict, invalid, notFound } from '../http/errors';
import { canInRound, canOnInterview, type Actor, type PanelAction, type RoundAccess } from '../authz/policy';
import { loadSet, roundTeam } from '../rounds/service';
import { personName } from '../../src/domain/rounds';
import { cleanName, nameKey } from '../../src/domain/interviewers';
import { MAX_ENTERED_NOTE, MAX_RATIONALE, MAX_SUMMARY } from '../../src/domain/decision';
import {
  buildPanel,
  candidateDetail,
  liveRecordFor,
  othersHidden,
  panelFigures,
  startingMedian,
  type PanelInput,
  type RecordInput,
} from '../../src/domain/panel';
import { summaryCsv, summaryMarkdown } from '../../src/domain/panelExport';
import { exportFileName } from '../../src/domain/export';
import type { PlanCategory, Question, Recommendation, Score } from '../../src/domain/types';
import type {
  AnswerJson,
  DebriefData,
  DecisionInput,
  DecisionJson,
  EnteredJudgementInput,
  NoteJson,
  ReportInput,
  ReportResult,
  SummaryData,
  SummaryRow,
  WrittenSummaryJson,
} from '../../src/shared/api';

const RECORDS_TOPIC = (db: Executor, interviewId: string) => publish(db, { topic: `interview:${interviewId}`, kind: 'records' });
const ROUND_TOPIC = (db: Executor, roundId: string, interviewId: string) => publish(db, { topic: `round:${roundId}`, kind: 'panel', id: interviewId });

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
type Name = { name: string | null; email: string } | null | undefined;
const nameOf = (u: Name, gone = 'Someone no longer here') => (u?.email ? personName(u) : gone);

// ---------------------------------------------------------------------------------------------
// Reading: one query path (SUM-6)

interface Loaded {
  inputs: PanelInput[];
  /** Interview id → the round's access facts are not here: callers check the round first. */
  byId: Map<string, PanelInput>;
}

/**
 * Every non-cancelled interview of the given rounds (or the given interviews), with what the debrief,
 * the Summary and the report need. Eight queries whatever the number of interviews.
 */
export async function loadPanels(db: Executor, where: { roundIds?: readonly string[]; interviewIds?: readonly string[] }): Promise<Loaded> {
  const empty = { inputs: [], byId: new Map() };
  if ((where.roundIds && !where.roundIds.length) || (where.interviewIds && !where.interviewIds.length)) return empty;
  let q = db
    .selectFrom('interviews as i')
    .innerJoin('rounds as r', 'r.id', 'i.round_id')
    .innerJoin('tracks as t', 't.id', 'r.track_id')
    .innerJoin('candidates as c', 'c.id', 'i.candidate_id')
    .select([
      'i.id',
      'i.round_id',
      'i.state',
      'i.scheduled_date',
      'i.scheduled_time',
      'i.started_at',
      'i.question_set_id',
      'r.name as round_name',
      'r.state as round_state',
      'r.hide_others_scores',
      'r.track_id',
      't.name as track_name',
      'c.id as candidate_id',
      'c.display_name',
      'c.requisition_id',
    ])
    .where('i.state', '!=', 'cancelled');
  if (where.roundIds) q = q.where('i.round_id', 'in', [...where.roundIds]);
  if (where.interviewIds) q = q.where('i.id', 'in', [...where.interviewIds]);
  const interviews = await q.execute();
  if (!interviews.length) return empty;
  const ids = interviews.map((i) => i.id);
  const setIds = [...new Set(interviews.map((i) => i.question_set_id))];
  const candidateIds = [...new Set(interviews.map((i) => i.candidate_id))];
  const submittedOf = db.selectFrom('records').select('id').where('interview_id', 'in', ids).where('state', '=', 'submitted').where('origin', 'in', ['live', 'entered']);
  const [sets, panel, records, answers, notes, decisions, summaries] = await Promise.all([
    db.selectFrom('question_sets').select(['id', 'name', 'fingerprint', 'questions', 'categories']).where('id', 'in', setIds).execute(),
    db
      .selectFrom('interview_panel as p')
      .innerJoin('users as u', 'u.id', 'p.user_id')
      .select(['p.interview_id', 'p.user_id', 'p.status', 'u.name', 'u.email'])
      .where('p.interview_id', 'in', ids)
      .orderBy(sql`lower(coalesce(u.name, u.email))`)
      .execute(),
    db
      .selectFrom('records as r')
      .leftJoin('users as eb', 'eb.id', 'r.entered_by')
      .select([
        'r.id',
        'r.interview_id',
        'r.origin',
        'r.owner_user_id',
        'r.shared_with',
        'r.names',
        'r.entered_for',
        'r.entered_by',
        'r.entered_at',
        'r.state',
        'r.overall_rating',
        'r.recommendation',
        'r.rationale',
        'r.submitted_at',
        'eb.name as eb_name',
        'eb.email as eb_email',
      ])
      .where('r.interview_id', 'in', ids)
      .where('r.origin', 'in', ['live', 'entered'])
      .orderBy('r.submitted_at')
      .orderBy('r.created_at')
      .execute(),
    db.selectFrom('answers').selectAll().where('record_id', 'in', submittedOf).execute(),
    db.selectFrom('notes').selectAll().where('record_id', 'in', submittedOf).orderBy('created_at').orderBy('id').execute(),
    db
      .selectFrom('panel_decisions as d')
      .leftJoin('users as cb', 'cb.id', 'd.created_by')
      .leftJoin('users as db', 'db.id', 'd.decided_by')
      .selectAll('d')
      .select(['cb.name as cb_name', 'cb.email as cb_email', 'db.name as db_name', 'db.email as db_email'])
      .where('d.interview_id', 'in', ids)
      .execute(),
    db.selectFrom('written_summaries').select('candidate_id').where('candidate_id', 'in', candidateIds).where(sql<boolean>`length(btrim(text)) > 0`).execute(),
  ]);
  const setById = new Map(sets.map((s) => [s.id, s]));
  const group = <T, K>(xs: readonly T[], key: (x: T) => K) => {
    const m = new Map<K, T[]>();
    for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
    return m;
  };
  const panelBy = group(panel, (p) => p.interview_id);
  const recordsBy = group(records, (r) => r.interview_id);
  const answersBy = group(answers, (a) => a.record_id);
  const notesBy = group(notes, (n) => n.record_id);
  const decisionBy = new Map(decisions.map((d) => [d.interview_id, d]));
  const withSummary = new Set(summaries.map((s) => s.candidate_id));

  const inputs = interviews.map((i): PanelInput => {
    const set = setById.get(i.question_set_id)!;
    const d = decisionBy.get(i.id);
    return {
      interview: {
        id: i.id,
        roundId: i.round_id,
        roundName: i.round_name,
        roundState: i.round_state,
        hideOthers: i.hide_others_scores,
        state: i.state as PanelInput['interview']['state'],
        date: i.scheduled_date,
        time: i.scheduled_time,
        startedAt: iso(i.started_at),
        candidate: { id: i.candidate_id, name: i.display_name, requisitionId: i.requisition_id },
        trackId: i.track_id,
        trackName: i.track_name,
      },
      set: { id: set.id, name: set.name, fingerprint: set.fingerprint, questions: set.questions as Question[], categories: set.categories as PlanCategory[] },
      panel: (panelBy.get(i.id) ?? []).map((p) => ({ userId: p.user_id, name: personName(p), status: p.status })),
      records: (recordsBy.get(i.id) ?? []).map(
        (r): RecordInput => ({
          id: r.id,
          origin: r.origin as 'live' | 'entered',
          ownerId: r.owner_user_id,
          sharedWith: r.shared_with,
          names: r.names,
          enteredFor: r.entered_for,
          enteredBy: r.origin === 'entered' ? nameOf(r.eb_email ? { name: r.eb_name, email: r.eb_email } : null) : null,
          enteredById: r.entered_by,
          enteredAt: iso(r.entered_at),
          state: r.state,
          rating: (r.overall_rating as Score | null) ?? null,
          recommendation: r.recommendation,
          rationale: r.rationale,
          submittedAt: iso(r.submitted_at),
          answers: r.state === 'submitted' ? (answersBy.get(r.id) ?? []).map(answerJson) : [],
          notes: r.state === 'submitted' ? (notesBy.get(r.id) ?? []).map((n) => ({ id: n.id, questionId: n.question_id, atSec: n.at_sec, text: n.text, by: n.by_name })) : [],
        }),
      ),
      decision: d ? decisionJson(d) : null,
      hasSummary: withSummary.has(i.candidate_id),
    };
  });
  return { inputs, byId: new Map(inputs.map((x) => [x.interview.id, x])) };
}

function answerJson(a: { question_id: string; score: number | null; covered_key_points: number[]; red_flags_seen: number[]; probe_handled: boolean; flagged: boolean; skipped: boolean; skip_reason: string | null }): AnswerJson {
  return { questionId: a.question_id, score: a.score as Score | null, coveredKeyPoints: a.covered_key_points, redFlagsSeen: a.red_flags_seen, probeHandled: a.probe_handled, flagged: a.flagged, skipped: a.skipped, skipReason: a.skip_reason };
}

function decisionJson(d: {
  recommendation: Recommendation;
  rationale: string;
  participants: Array<{ userId: string | null; name: string }>;
  overall_rating: number | null;
  question_scores: Record<string, number>;
  created_at: Date;
  decided_at: Date;
  version: number;
  cb_name: string | null;
  cb_email: string | null;
  db_name: string | null;
  db_email: string | null;
}): DecisionJson {
  const changed = d.version > 1;
  return {
    recommendation: d.recommendation,
    rationale: d.rationale,
    participants: d.participants,
    rating: (d.overall_rating as Score | null) ?? null,
    scores: d.question_scores as Record<string, Score>,
    recordedBy: nameOf(d.cb_email ? { name: d.cb_name, email: d.cb_email } : null),
    recordedAt: d.created_at.toISOString(),
    changedBy: changed ? nameOf(d.db_email ? { name: d.db_name, email: d.db_email } : null) : null,
    changedAt: changed ? d.decided_at.toISOString() : null,
    version: d.version,
  };
}

/** ROUND-2, ROUND-6: the rounds a person can see (administrators: every round), with their place in each. */
export async function visibleRounds(db: Executor, actor: Actor): Promise<Array<SummaryData['rounds'][number] & { access: RoundAccess }>> {
  const rows = await db
    .selectFrom('rounds as r')
    .innerJoin('tracks as t', 't.id', 'r.track_id')
    .leftJoin('round_members as m', (j) => j.onRef('m.round_id', '=', 'r.id').on('m.user_id', '=', actor.id))
    .select(['r.id', 'r.name', 'r.state', 'r.created_at', 't.name as track_name', 'm.role'])
    .orderBy('r.created_at', 'desc')
    .execute();
  return rows
    .map((r) => ({ id: r.id, name: r.name, state: r.state, trackName: r.track_name, createdAt: r.created_at.toISOString(), mine: !!r.role, access: { roundId: r.id, memberRole: r.role ?? null, state: r.state } as RoundAccess }))
    .filter((r) => (actor.role === 'admin' || r.mine) && canInRound(actor, 'round.read', r.access));
}

const byDateDesc = (a: SummaryRow, b: SummaryRow) => (b.date ?? '').localeCompare(a.date ?? '') || (b.time ?? '').localeCompare(a.time ?? '') || a.candidate.name.localeCompare(b.candidate.name);

/** SUM-1, SUM-2, ROUND-6: the Summary rows of one round, or of every round the reader can see. */
export async function summary(db: Executor, actor: Actor, roundId: string | 'all'): Promise<SummaryData> {
  const rounds = await visibleRounds(db, actor);
  const chosen = roundId === 'all' ? rounds : rounds.filter((r) => r.id === roundId);
  if (roundId !== 'all' && !chosen.length) throw notFound('That round');
  const { inputs } = await loadPanels(db, { roundIds: chosen.map((r) => r.id) });
  return {
    rows: inputs.map((p) => buildPanel(p, actor.id).row).sort(byDateDesc),
    rounds: rounds.map(({ access: _a, ...r }) => r),
  };
}

async function onPanelOf(db: Executor, interviewId: string, userId: string): Promise<boolean> {
  return !!(await db.selectFrom('interview_panel').select('user_id').where('interview_id', '=', interviewId).where('user_id', '=', userId).executeTakeFirst());
}

/** LIVE-9, SUM-3: the debrief and the candidate page of one interview, for this reader. */
export async function loadDebrief(db: Executor, actor: Actor, access: RoundAccess, interviewId: string): Promise<DebriefData> {
  const { byId } = await loadPanels(db, { interviewIds: [interviewId] });
  const input = byId.get(interviewId);
  if (!input) throw notFound('That interview');
  const built = buildPanel(input, actor.id);
  const [set, team, summaryRow, onPanel, others] = await Promise.all([
    loadSet(db, input.set.id),
    roundTeam(db, input.interview.roundId),
    loadSummary(db, input.interview.candidate.id),
    onPanelOf(db, interviewId, actor.id),
    db
      .selectFrom('interviews as i')
      .innerJoin('question_sets as s', 's.id', 'i.question_set_id')
      .select(['i.id', 'i.scheduled_date', 's.name'])
      .where('i.candidate_id', '=', input.interview.candidate.id)
      .where('i.id', '!=', interviewId)
      .where('i.state', '!=', 'cancelled')
      .execute(),
  ]);
  const may = (a: PanelAction) => canOnInterview(actor, a, access, onPanel);
  return {
    row: built.row,
    set,
    detail: candidateDetail(input, built),
    panel: panelFigures(built.members),
    medianScores: built.hidden ? {} : startingMedian(input, built.members),
    team: team.filter((m) => m.active).map((m) => ({ id: m.id, name: m.name })),
    summary: summaryRow,
    hidden: built.hidden,
    can: { decide: may('panel.decide') && !built.hidden, enter: may('panel.enter'), writeSummary: may('panel.summary'), remove: canInRound(actor, 'round.decide', access), reasonNeeded: access.state === 'closed' },
    myRecordId: liveRecordFor(input.records, actor.id)?.id ?? null,
    otherInterviews: others.map((o) => ({ id: o.id, date: o.scheduled_date, setName: o.name })),
  };
}

async function loadSummary(db: Executor, candidateId: string): Promise<WrittenSummaryJson | null> {
  const s = await db
    .selectFrom('written_summaries as w')
    .leftJoin('users as u', 'u.id', 'w.updated_by')
    .select(['w.text', 'w.updated_at', 'w.version', 'u.name', 'u.email'])
    .where('w.candidate_id', '=', candidateId)
    .executeTakeFirst();
  return s ? { text: s.text, updatedBy: nameOf(s.email ? { name: s.name, email: s.email } : null), updatedAt: s.updated_at.toISOString(), version: s.version } : null;
}

// ---------------------------------------------------------------------------------------------
// Checks shared by the changes

async function lockInterview(db: Executor, interviewId: string) {
  const i = await db.selectFrom('interviews').select(['id', 'round_id', 'state', 'question_set_id', 'candidate_id']).where('id', '=', interviewId).forUpdate().executeTakeFirst();
  if (!i || i.state === 'cancelled') throw notFound('That interview');
  return i;
}

/** The policy's answer for this interview (TEAM-7…TEAM-11, SUM-4); refused with 403 otherwise. */
async function mustMay(db: Executor, actor: Actor, action: PanelAction, access: RoundAccess, interviewIds: readonly string[]) {
  let onPanel = false;
  if (interviewIds.length) onPanel = !!(await db.selectFrom('interview_panel').select('user_id').where('interview_id', 'in', [...interviewIds]).where('user_id', '=', actor.id).executeTakeFirst());
  if (!canOnInterview(actor, action, access, onPanel)) {
    throw new ApiError(403, 'forbidden', access.state === 'closed' ? 'This round is closed. Only its organisers can change it, with a reason.' : 'Only the round’s organisers and this interview’s panel can do that.');
  }
}

/** ROUND-5: a change in a closed round needs a reason (organisers and administrators only, checked by the policy). */
function closedReason(access: RoundAccess, reason: string | undefined): string | null {
  const r = reason?.trim() || null;
  if (access.state === 'closed' && !r) throw invalid('This round is closed. Say why you are changing it.', { reason: 'Say why you are changing it.' });
  return r;
}

async function setQuestions(db: Executor, setId: string): Promise<Question[]> {
  const s = await db.selectFrom('question_sets').select('questions').where('id', '=', setId).executeTakeFirstOrThrow();
  return s.questions as Question[];
}

async function roundMembers(db: Executor, roundId: string): Promise<Map<string, string>> {
  const rows = await db.selectFrom('round_members as m').innerJoin('users as u', 'u.id', 'm.user_id').select(['u.id', 'u.name', 'u.email']).where('m.round_id', '=', roundId).execute();
  return new Map(rows.map((u) => [u.id, personName(u)]));
}

async function recordsOf(db: Executor, interviewId: string) {
  return db.selectFrom('records').select(['id', 'origin', 'owner_user_id', 'shared_with', 'names', 'state', 'entered_for']).where('interview_id', '=', interviewId).where('origin', 'in', ['live', 'entered']).execute();
}

const asInputs = (rows: Awaited<ReturnType<typeof recordsOf>>) => rows.map((r) => ({ origin: r.origin as 'live' | 'entered', ownerId: r.owner_user_id, sharedWith: r.shared_with, state: r.state, names: r.names, enteredFor: r.entered_for }));

async function hiddenFor(db: Executor, actor: Actor, interviewId: string): Promise<boolean> {
  const i = await db.selectFrom('interviews as i').innerJoin('rounds as r', 'r.id', 'i.round_id').select(['i.state', 'r.hide_others_scores']).where('i.id', '=', interviewId).executeTakeFirstOrThrow();
  return othersHidden(i.hide_others_scores, i.state as 'planned', asInputs(await recordsOf(db, interviewId)), actor.id);
}

function checkScores(scores: Record<string, unknown>, questions: readonly Question[], what: string) {
  const ids = new Set(questions.map((q) => q.id));
  for (const [id, v] of Object.entries(scores)) {
    if (!ids.has(id)) throw invalid(`${what}: a question is not in this interview.`);
    if (![1, 2, 3, 4].includes(v as number)) throw invalid(`${what}: scores are 1 to 4.`);
  }
}

// ---------------------------------------------------------------------------------------------
// The panel decision (TEAM-9…TEAM-12)

/**
 * TEAM-9, TEAM-10, TEAM-11: records the interview's panel decision, or changes it (with a reason and
 * the version it started from). Allowed with no judgements behind it, for a planned or finished
 * interview. Refused while the round hides other people's judgements from the person deciding. The
 * audit entry holds the values before and after; nobody's own record is touched.
 */
export async function saveDecision(db: Executor, actor: Actor, access: RoundAccess, interviewId: string, input: DecisionInput): Promise<DecisionJson> {
  const i = await lockInterview(db, interviewId);
  await mustMay(db, actor, 'panel.decide', access, [interviewId]);
  if (await hiddenFor(db, actor, interviewId)) throw conflict('This round hides other people’s judgements until you have submitted yours, so you cannot record the panel’s decision yet.');
  const rationale = input.rationale.trim();
  const errors: Record<string, string> = {};
  if (!rationale) errors.rationale = 'Write why, even one sentence.';
  else if (rationale.length > MAX_RATIONALE) errors.rationale = `Keep it under ${MAX_RATIONALE} characters.`;
  const members = await roundMembers(db, i.round_id);
  const seen = new Set<string>();
  const participants: Array<{ userId: string | null; name: string }> = [];
  for (const p of input.participants) {
    if (p.userId && !members.has(p.userId)) throw invalid('Everyone chosen from the team must be on this round.');
    const name = p.userId ? members.get(p.userId)! : cleanName(p.name);
    if (!name) continue;
    if (name.length > 200) errors.participants = 'A name is too long.';
    const key = p.userId ?? nameKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    participants.push({ userId: p.userId, name });
  }
  if (!participants.length) errors.participants = 'Name at least one person who took part.';
  else if (participants.length > 24) errors.participants = 'At most 24 people.';
  if (Object.keys(errors).length) throw invalid('The panel decision is not complete.', errors);
  checkScores(input.scores, await setQuestions(db, i.question_set_id), 'Agreed scores');
  const current = await db.selectFrom('panel_decisions').selectAll().where('interview_id', '=', interviewId).forUpdate().executeTakeFirst();
  const next = { recommendation: input.recommendation, rationale, participants, rating: input.rating, scores: Object.fromEntries(Object.entries(input.scores).sort(([a], [b]) => a.localeCompare(b))) };
  const now = new Date();
  if (!current) {
    if (input.baseVersion != null) throw conflict('The panel decision was removed meanwhile. Reload the page.');
    const reason = closedReason(access, input.reason);
    await db
      .insertInto('panel_decisions')
      .values({ interview_id: interviewId, recommendation: next.recommendation, rationale, participants: json(participants), overall_rating: next.rating, question_scores: json(next.scores), decided_by: actor.id, decided_at: now, created_by: actor.id, created_at: now })
      .execute();
    await appendAudit(db, actor, {
      action: 'decision.recorded',
      entity: 'interview',
      entityId: interviewId,
      roundId: i.round_id,
      after: { recommendation: next.recommendation, rating: next.rating, participants: participants.map((p) => p.name), agreedScores: next.scores, rationale },
      reason,
    });
  } else {
    if (input.baseVersion !== current.version) throw conflict('Someone else changed the panel decision meanwhile. Reload to see it, then make your change again.');
    const reason = input.reason?.trim();
    if (!reason) throw invalid('Say why you are changing the panel decision.', { reason: 'Say why you are changing it.' });
    const before = { recommendation: current.recommendation, rationale: current.rationale, participants: current.participants.map((p) => p.name), rating: current.overall_rating, agreedScores: current.question_scores };
    const after = { recommendation: next.recommendation, rationale, participants: participants.map((p) => p.name), rating: next.rating, agreedScores: next.scores };
    const changed = (Object.keys(after) as Array<keyof typeof after>).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (!changed.length) throw invalid('Nothing has changed.');
    await db
      .updateTable('panel_decisions')
      .set({ recommendation: next.recommendation, rationale, participants: json(participants), overall_rating: next.rating, question_scores: json(next.scores), decided_by: actor.id, decided_at: now, version: sql`version + 1` })
      .where('interview_id', '=', interviewId)
      .execute();
    await appendAudit(db, actor, {
      action: 'decision.changed',
      entity: 'interview',
      entityId: interviewId,
      roundId: i.round_id,
      before: Object.fromEntries(changed.map((k) => [k, before[k]])),
      after: Object.fromEntries(changed.map((k) => [k, after[k]])),
      reason,
    });
  }
  await RECORDS_TOPIC(db, interviewId);
  await ROUND_TOPIC(db, i.round_id, interviewId);
  const d = await db
    .selectFrom('panel_decisions as d')
    .leftJoin('users as cb', 'cb.id', 'd.created_by')
    .leftJoin('users as db', 'db.id', 'd.decided_by')
    .selectAll('d')
    .select(['cb.name as cb_name', 'cb.email as cb_email', 'db.name as db_name', 'db.email as db_email'])
    .where('d.interview_id', '=', interviewId)
    .executeTakeFirstOrThrow();
  return decisionJson(d);
}

// ---------------------------------------------------------------------------------------------
// Judgements entered on someone's behalf (TEAM-7, TEAM-8)

function enteredProblems(input: EnteredJudgementInput, questions: readonly Question[]): Record<string, string> {
  const e: Record<string, string> = {};
  const rationale = input.rationale.trim();
  if (!rationale) e.rationale = 'Write their rationale, even one sentence.';
  else if (rationale.length > MAX_RATIONALE) e.rationale = `Keep it under ${MAX_RATIONALE} characters.`;
  const ids = new Set(questions.map((q) => q.id));
  for (const [id, n] of Object.entries(input.notes)) {
    if (!ids.has(id)) e.scores = 'A note is for a question that is not in this interview.';
    else if (n.length > MAX_ENTERED_NOTE) e.scores = `Keep each note under ${MAX_ENTERED_NOTE} characters.`;
  }
  return e;
}

/** Answers and notes of an entered judgement: only questions with a score or a note (TEAM-7). */
async function writeEntered(db: Executor, recordId: string, input: Pick<EnteredJudgementInput, 'scores' | 'notes'>, questions: readonly Question[]) {
  await db.deleteFrom('notes').where('record_id', '=', recordId).execute();
  await db.deleteFrom('answers').where('record_id', '=', recordId).execute();
  for (const q of questions) {
    const score = input.scores[q.id] ?? null;
    const note = (input.notes[q.id] ?? '').trim();
    if (score == null && !note) continue;
    await db.insertInto('answers').values({ record_id: recordId, question_id: q.id, score }).execute();
    if (note) await db.insertInto('notes').values({ record_id: recordId, question_id: q.id, at_sec: 0, text: note, by_name: null }).execute();
  }
}

/** The judgement's values for the audit log (AUD-4): overall assessment and question scores and notes. */
async function enteredValues(db: Executor, recordId: string) {
  const r = await db.selectFrom('records').select(['names', 'overall_rating', 'recommendation', 'rationale']).where('id', '=', recordId).executeTakeFirstOrThrow();
  const answers = await db.selectFrom('answers').select(['question_id', 'score']).where('record_id', '=', recordId).execute();
  const notes = await db.selectFrom('notes').select(['question_id', 'text']).where('record_id', '=', recordId).execute();
  return {
    names: r.names,
    rating: r.overall_rating,
    recommendation: r.recommendation,
    rationale: r.rationale ?? '',
    scores: Object.fromEntries(answers.filter((a) => a.score != null).sort((a, b) => a.question_id.localeCompare(b.question_id)).map((a) => [a.question_id, a.score])),
    notes: Object.fromEntries(notes.sort((a, b) => a.question_id.localeCompare(b.question_id)).map((n) => [n.question_id, n.text])),
  };
}

/**
 * TEAM-7: a judgement entered on someone's behalf: a round member (refused when they have their own
 * record of this interview, or one was already entered for them: correct that instead), or a name for
 * someone without access (refused when that name already has a judgement here). Stored as a submitted
 * record with origin "entered", who entered it and when. A 1 or 4 needs no note. Allowed for any
 * interview that is not cancelled (planned ones too: an interview held outside the app).
 */
export async function enterJudgement(db: Executor, actor: Actor, access: RoundAccess, interviewId: string, input: EnteredJudgementInput): Promise<string> {
  const i = await lockInterview(db, interviewId);
  await mustMay(db, actor, 'panel.enter', access, [interviewId]);
  const reason = closedReason(access, input.reason);
  const questions = await setQuestions(db, i.question_set_id);
  const errors = enteredProblems(input, questions);
  checkScores(input.scores, questions, 'Question scores');
  const records = await recordsOf(db, interviewId);
  let name: string;
  if (input.forUserId) {
    const members = await roundMembers(db, i.round_id);
    if (!members.has(input.forUserId)) throw invalid('Choose someone on this round’s team, or type the name of someone who is not.');
    name = members.get(input.forUserId)!;
    if (liveRecordFor(asInputs(records), input.forUserId)) throw conflict(`${name} has their own record of this interview in the app, so a judgement cannot be entered for them.`);
    if (records.some((r) => r.origin === 'entered' && r.entered_for === input.forUserId)) throw conflict(`A judgement was already entered for ${name}. Correct that one instead.`);
  } else {
    name = cleanName(input.name ?? '');
    if (!name) errors.name = 'Choose the interviewer, or type their name.';
    else if (name.length > 200) errors.name = 'The name is too long.';
    else if (records.some((r) => r.names.some((n) => nameKey(n) === nameKey(name)))) throw conflict(`${name} already has a judgement for this interview. Correct that one instead.`);
  }
  if (Object.keys(errors).length) throw invalid('The judgement is not complete.', errors);
  const now = new Date();
  const rec = await db
    .insertInto('records')
    .values({
      interview_id: interviewId,
      owner_user_id: null,
      names: json([name]),
      origin: 'entered',
      entered_by: actor.id,
      entered_at: now,
      entered_for: input.forUserId,
      state: 'submitted',
      overall_rating: input.rating,
      recommendation: input.recommendation,
      rationale: input.rationale.trim(),
      submitted_at: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await writeEntered(db, rec.id, input, questions);
  await appendAudit(db, actor, {
    action: 'record.entered',
    entity: 'record',
    entityId: rec.id,
    roundId: i.round_id,
    after: { interviewId, onBehalfOf: name, member: !!input.forUserId, rating: input.rating, recommendation: input.recommendation, scored: Object.keys(input.scores).length },
    reason,
  });
  await RECORDS_TOPIC(db, interviewId);
  await ROUND_TOPIC(db, i.round_id, interviewId);
  return rec.id;
}

async function lockEntered(db: Executor, recordId: string) {
  const r = await db.selectFrom('records').select(['id', 'interview_id', 'origin', 'names', 'entered_for']).where('id', '=', recordId).forUpdate().executeTakeFirst();
  if (!r) throw notFound('That judgement');
  if (r.origin !== 'entered') throw new ApiError(403, 'forbidden', 'Only a judgement entered on someone’s behalf can be corrected here. Its owner amends their own record.');
  return r;
}

/** TEAM-8, AUD-4: corrects an entered judgement, with a reason; the audit entry holds what changed, before and after. */
export async function correctEntered(db: Executor, actor: Actor, access: RoundAccess, recordId: string, input: EnteredJudgementInput): Promise<void> {
  const r = await lockEntered(db, recordId);
  const i = await lockInterview(db, r.interview_id);
  await mustMay(db, actor, 'panel.enter', access, [i.id]);
  const reason = input.reason?.trim();
  if (!reason) throw invalid('Say why you are correcting it.', { reason: 'Say why you are correcting it.' });
  const questions = await setQuestions(db, i.question_set_id);
  const errors = enteredProblems(input, questions);
  if (Object.keys(errors).length) throw invalid('The judgement is not complete.', errors);
  checkScores(input.scores, questions, 'Question scores');
  const before = await enteredValues(db, recordId);
  await db
    .updateTable('records')
    .set({ overall_rating: input.rating, recommendation: input.recommendation, rationale: input.rationale.trim(), updated_at: new Date(), version: sql`version + 1` })
    .where('id', '=', recordId)
    .execute();
  await writeEntered(db, recordId, input, questions);
  const after = await enteredValues(db, recordId);
  const keys = (['rating', 'recommendation', 'rationale', 'scores', 'notes'] as const).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (!keys.length) throw invalid('Nothing has changed.');
  await appendAudit(db, actor, {
    action: 'record.corrected',
    entity: 'record',
    entityId: recordId,
    roundId: i.round_id,
    before: { onBehalfOf: before.names, ...Object.fromEntries(keys.map((k) => [k, before[k]])) },
    after: Object.fromEntries(keys.map((k) => [k, after[k]])),
    reason,
  });
  await RECORDS_TOPIC(db, i.id);
  await ROUND_TOPIC(db, i.round_id, i.id);
}

/** TEAM-8: an organiser removes an entered judgement (one superseded by the person's own record, or a mistake), with a reason. */
export async function removeEntered(db: Executor, actor: Actor, recordId: string, reason: string): Promise<void> {
  const r = await lockEntered(db, recordId);
  const i = await lockInterview(db, r.interview_id);
  if (!reason.trim()) throw invalid('Say why you are removing it.', { reason: 'Say why you are removing it.' });
  const before = await enteredValues(db, recordId);
  await db.deleteFrom('records').where('id', '=', recordId).execute();
  await appendAudit(db, actor, { action: 'record.removed', entity: 'record', entityId: recordId, roundId: i.round_id, before: { interviewId: i.id, onBehalfOf: before.names, rating: before.rating, recommendation: before.recommendation, scored: Object.keys(before.scores).length }, reason: reason.trim() });
  await RECORDS_TOPIC(db, i.id);
  await ROUND_TOPIC(db, i.round_id, i.id);
}

/** For the correction dialog: an entered judgement's values as the input form takes them. */
export async function enteredInput(db: Executor, actor: Actor, recordId: string): Promise<EnteredJudgementInput> {
  const r = await db.selectFrom('records').select(['id', 'interview_id', 'origin', 'names', 'entered_for', 'entered_by']).where('id', '=', recordId).executeTakeFirst();
  if (!r || r.origin !== 'entered') throw notFound('That judgement');
  if (r.entered_by !== actor.id && (await hiddenFor(db, actor, r.interview_id))) throw new ApiError(403, 'forbidden', 'This round hides other people’s scores until you have submitted yours.');
  const v = await enteredValues(db, recordId);
  return { forUserId: r.entered_for, name: r.names[0] ?? '', rating: v.rating as Score, recommendation: v.recommendation as Recommendation, rationale: v.rationale, scores: v.scores as Record<string, Score>, notes: v.notes };
}

// ---------------------------------------------------------------------------------------------
// Written summaries (SUM-4, manual)

/** A new audit entry starts when someone else edits, or after this long without an edit. */
const SUMMARY_SESSION_MS = 15 * 60_000;

/**
 * SUM-4: the candidate's written summary, saved as it is typed. Each save says which version it was
 * written on; if someone else saved meanwhile it is refused (409) so the browser can offer "reload" or
 * "keep mine" instead of silently overwriting. Audited without the text: one entry per editing session
 * (when someone else edited it last, or more than 15 minutes ago), and every save in a closed round.
 */
export async function saveSummary(db: Executor, actor: Actor, access: RoundAccess, candidateId: string, input: { text: string; baseVersion: number | null; reason?: string }): Promise<WrittenSummaryJson> {
  const c = await db.selectFrom('candidates').select(['id', 'round_id']).where('id', '=', candidateId).forUpdate().executeTakeFirst();
  if (!c) throw notFound('That candidate');
  const interviews = (await db.selectFrom('interviews').select('id').where('candidate_id', '=', candidateId).where('state', '!=', 'cancelled').execute()).map((x) => x.id);
  if (!interviews.length) throw notFound('That candidate');
  await mustMay(db, actor, 'panel.summary', access, interviews);
  const reason = closedReason(access, input.reason);
  if (input.text.length > MAX_SUMMARY) throw invalid(`Keep the summary under ${MAX_SUMMARY} characters.`);
  const current = await db.selectFrom('written_summaries').selectAll().where('candidate_id', '=', candidateId).forUpdate().executeTakeFirst();
  if ((current?.version ?? null) !== input.baseVersion) throw conflict('Someone else changed this summary while you were writing.');
  const now = new Date();
  if (current && current.text === input.text) return (await loadSummary(db, candidateId))!;
  const newSession = !current || current.updated_by !== actor.id || now.getTime() - current.updated_at.getTime() > SUMMARY_SESSION_MS;
  if (current) {
    await db.updateTable('written_summaries').set({ text: input.text, ai_draft: false, updated_by: actor.id, updated_at: now, version: sql`version + 1` }).where('candidate_id', '=', candidateId).execute();
  } else {
    await db.insertInto('written_summaries').values({ candidate_id: candidateId, text: input.text, updated_by: actor.id, updated_at: now }).execute();
  }
  if (newSession || reason) {
    await appendAudit(db, actor, { action: 'summary.edited', entity: 'candidate', entityId: candidateId, roundId: c.round_id, after: { characters: input.text.length }, reason });
  }
  for (const id of interviews) await RECORDS_TOPIC(db, id);
  await publish(db, { topic: `round:${c.round_id}`, kind: 'summary', id: candidateId });
  return (await loadSummary(db, candidateId))!;
}

// ---------------------------------------------------------------------------------------------
// The round report (SUM-5)

/**
 * SUM-5: the Summary view as Markdown, CSV or the data of the print layout, from the server's data,
 * for the rows the reader chose (in their order) and only as the reader may see them (LIVE-3). Every
 * interview must be in a round the reader can see (else 404). Audited once per round, without
 * candidate details.
 */
export async function report(db: Executor, actor: Actor, input: ReportInput): Promise<ReportResult> {
  const ids = [...new Set(input.interviewIds)];
  const rounds = await visibleRounds(db, actor);
  const visible = new Set(rounds.map((r) => r.id));
  const { byId } = await loadPanels(db, { interviewIds: ids });
  if (ids.some((id) => !byId.has(id) || !visible.has(byId.get(id)!.interview.roundId))) throw notFound('One of those interviews');
  const items = ids.map((id) => {
    const input0 = byId.get(id)!;
    const built = buildPanel(input0, actor.id);
    return { input: input0, row: built.row, detail: candidateDetail(input0, built) };
  });
  const candidateIds = [...new Set(items.map((x) => x.row.candidate.id))];
  const summaries = new Map<string, WrittenSummaryJson | null>();
  for (const cid of candidateIds) summaries.set(cid, await loadSummary(db, cid));
  const me = await db.selectFrom('users').select(['name', 'email']).where('id', '=', actor.id).executeTakeFirstOrThrow();
  const preparedBy = personName(me);
  const now = new Date();
  const perRound = new Map<string, number>();
  for (const x of items) perRound.set(x.row.roundId, (perRound.get(x.row.roundId) ?? 0) + 1);
  for (const [roundId, n] of perRound) await appendAudit(db, actor, { action: 'summary.exported', entity: 'round', entityId: roundId, roundId, after: { format: input.format, candidates: n } });
  if (input.format === 'print') {
    return { format: 'print', items: items.map((x) => ({ row: x.row, detail: x.detail, summary: summaries.get(x.row.candidate.id) ?? null })), preparedBy, preparedAt: now.toISOString() };
  }
  if (input.format === 'csv') {
    return { format: 'csv', fileName: exportFileName('round-report', 'summary', 'csv', now), mime: 'text/csv;charset=utf-8', text: summaryCsv(items.map((x) => ({ row: x.row, summary: summaries.get(x.row.candidate.id) ?? null }))) };
  }
  return {
    format: 'markdown',
    fileName: exportFileName('round-report', 'summary', 'md', now),
    mime: 'text/markdown;charset=utf-8',
    text: summaryMarkdown(
      items.map((x) => ({ row: x.row, detail: x.detail, summary: summaries.get(x.row.candidate.id) ?? null })),
      { preparedBy, scope: input.scope, now },
    ),
  };
}

/** For the scorecard (TEAM-12): the interview's panel decision, unless the round hides it from this reader. */
export async function decisionFor(db: Executor, actor: Actor, interviewId: string): Promise<DecisionJson | null> {
  if (await hiddenFor(db, actor, interviewId)) return null;
  const d = await db
    .selectFrom('panel_decisions as d')
    .leftJoin('users as cb', 'cb.id', 'd.created_by')
    .leftJoin('users as db', 'db.id', 'd.decided_by')
    .selectAll('d')
    .select(['cb.name as cb_name', 'cb.email as cb_email', 'db.name as db_name', 'db.email as db_email'])
    .where('d.interview_id', '=', interviewId)
    .executeTakeFirst();
  return d ? decisionJson(d) : null;
}

export type { NoteJson };
