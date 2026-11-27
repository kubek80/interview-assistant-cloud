// Interviewing together (LIVE-1…LIVE-8, FLOW-10…FLOW-25, HOST-5, HOST-6, AUD-4) in PostgreSQL.
//
// The shared interview is the `interviews` row: state, current question, lead, timers (accumulated
// time plus "running since", in the database's clock) and `version`. Every change to it locks the row
// (FOR UPDATE), so changes from several people and several server instances apply one at a time, and
// moves are conditional ("from question A to question B", src/domain/live.ts moveOutcome), so two
// simultaneous Nexts never skip two questions.
//
// Each panel member's own record is a `records` row with its `answers` and `notes`. Only its owner
// writes it. Changes arrive as RecordOps (set, never toggle) and are applied with the same function
// the browser uses for its optimistic view (applyRecordOp), so a resend is harmless (HOST-6).
//
// Live events carry ids only ({ topic: 'interview:<id>', kind }) and the browser refetches through
// these permission-checked reads; other people's marks are filtered here, by the reader (LIVE-3).
import { sql } from 'kysely';
import { json, type Executor } from '../db/pool';
import { appendAudit } from '../audit/audit';
import { publish } from '../live/bus';
import { ApiError, conflict, invalid, notFound } from '../http/errors';
import { canInRound, type Actor, type RoundAccess } from '../authz/policy';
import { loadInterview } from '../rounds/service';
import { personName } from '../../src/domain/rounds';
import { canFinish } from '../../src/domain/validation';
import {
  EMPTY_OVERALL,
  PRESENCE_TTL_MS,
  applyRecordOp,
  isComplete,
  moveOutcome,
  moveTimers,
  pauseTimers,
  questionSeconds,
  recordOpProblem,
  resolvedQuestions,
  resumeTimers,
  startTimers,
  stopAllTimers,
  toDomainAnswers,
  toDomainOverall,
  type SharedTimers,
} from '../../src/domain/live';
import type { Question, Recommendation, Score } from '../../src/domain/types';
import type {
  AmendInput,
  AnswerJson,
  LiveCommand,
  LivePanelMember,
  LiveRecords,
  LiveState,
  NoteJson,
  OtherRecord,
  PresentView,
  RecordData,
  RecordDetail,
  RecordOp,
  ScorecardData,
  TimerJson,
} from '../../src/shared/api';

// ---------------------------------------------------------------------------------------------
// Helpers

/** The database's clock (epoch ms): every timestamp of the shared interview uses it (RES-2, HOST-5). */
export async function dbNow(db: Executor): Promise<number> {
  const r = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(db);
  return r.rows[0].now.getTime();
}

const interviewEvent = (db: Executor, interviewId: string, kind: 'state' | 'records' | 'presence') => publish(db, { topic: `interview:${interviewId}`, kind });
const roundEvent = (db: Executor, roundId: string, interviewId: string) => publish(db, { topic: `round:${roundId}`, kind: 'interview', id: interviewId });

type InterviewRow = Awaited<ReturnType<typeof lockInterview>>;

async function lockInterview(db: Executor, id: string) {
  const i = await db.selectFrom('interviews').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  if (!i || i.state === 'cancelled') throw notFound('That interview');
  return i;
}

function timersOf(i: { timer_accumulated_ms: number; timer_running_since: Date | null; question_timers: Record<string, unknown> }): SharedTimers {
  return {
    timer: { accumulatedMs: Number(i.timer_accumulated_ms), runningSince: i.timer_running_since ? i.timer_running_since.getTime() : null },
    questionTimers: i.question_timers as Record<string, TimerJson>,
  };
}

function timerColumns(t: SharedTimers) {
  return {
    timer_accumulated_ms: Math.round(t.timer.accumulatedMs),
    timer_running_since: t.timer.runningSince == null ? null : new Date(t.timer.runningSince),
    question_timers: json(t.questionTimers),
  };
}

async function setQuestions(db: Executor, setId: string): Promise<Question[]> {
  const s = await db.selectFrom('question_sets').select('questions').where('id', '=', setId).executeTakeFirstOrThrow();
  return s.questions as Question[];
}

async function userNames(db: Executor, ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db.selectFrom('users').select(['id', 'name', 'email']).where('id', 'in', [...ids]).execute();
  return new Map(rows.map((u) => [u.id, personName(u)]));
}

const live = (s: string) => s === 'in_progress' || s === 'paused';

// ---------------------------------------------------------------------------------------------
// Reading

/** LIVE-2, LIVE-3, LIVE-6: the shared state, the panel with presence, and what I may do. */
export async function loadLiveState(db: Executor, actor: Actor, interviewId: string, access: RoundAccess): Promise<LiveState> {
  const i = await db
    .selectFrom('interviews as i')
    .innerJoin('rounds as r', 'r.id', 'i.round_id')
    .leftJoin('users as cu', 'cu.id', 'i.consent_by')
    .selectAll('i')
    .select(['r.hide_others_scores', 'cu.name as consent_name', 'cu.email as consent_email'])
    .where('i.id', '=', interviewId)
    .where('i.state', '!=', 'cancelled')
    .executeTakeFirst();
  if (!i) throw notFound('That interview');
  const [panel, records, presence, now] = await Promise.all([
    db
      .selectFrom('interview_panel as p')
      .innerJoin('users as u', 'u.id', 'p.user_id')
      .select(['p.user_id', 'p.status', 'p.joined_at', 'u.name', 'u.email'])
      .where('p.interview_id', '=', interviewId)
      .orderBy(sql`p.joined_at NULLS LAST`)
      .orderBy(sql`lower(coalesce(u.name, u.email))`)
      .execute(),
    db.selectFrom('records').select(['id', 'owner_user_id', 'state', 'shared_with']).where('interview_id', '=', interviewId).where('origin', '=', 'live').execute(),
    db.selectFrom('interview_presence').select(['user_id', 'seen_at']).where('interview_id', '=', interviewId).execute(),
    dbNow(db),
  ]);
  const seen = new Map(presence.map((p) => [p.user_id, p.seen_at.getTime()]));
  const ownRecord = new Map(records.map((r) => [r.owner_user_id!, r]));
  const coveredBy = new Map<string, string>();
  for (const r of records) for (const u of r.shared_with) coveredBy.set(u, r.owner_user_id!);
  const members: LivePanelMember[] = panel.map((p) => {
    const rec = ownRecord.get(p.user_id) ?? null;
    return {
      id: p.user_id,
      name: personName(p),
      status: p.status,
      recordId: rec?.id ?? null,
      recordState: rec?.state ?? null,
      onRecordOf: coveredBy.get(p.user_id) ?? null,
      seenAt: seen.get(p.user_id) ?? null,
    };
  });
  const mine = members.find((m) => m.id === actor.id);
  const canPlan = canInRound(actor, 'round.plan', access);
  const takePart = canInRound(actor, 'interview.take_part', access);
  return {
    id: i.id,
    roundId: i.round_id,
    version: i.version,
    state: i.state as LiveState['state'],
    currentQuestionId: i.current_question_id,
    leadUserId: i.lead_user_id,
    ...timersOf(i),
    startedAt: i.started_at?.toISOString() ?? null,
    completedAt: i.completed_at?.toISOString() ?? null,
    consent: i.consent_at ? { at: i.consent_at.toISOString(), byName: i.consent_email ? personName({ name: i.consent_name, email: i.consent_email }) : 'Someone no longer here', recordingNotice: !!i.recording_consent_at } : null,
    panel: members,
    hideOthers: i.hide_others_scores,
    me: {
      onPanel: !!mine,
      status: mine?.status ?? null,
      recordId: mine?.recordId ?? null,
      onRecordOf: mine?.onRecordOf ?? null,
      canStart: i.state === 'planned' && takePart && ((!!mine && mine.status !== 'did_not_take_part') || canPlan),
      canMark: canPlan,
    },
    serverNow: now,
  };
}

async function recordData(db: Executor, recordId: string): Promise<{ answers: AnswerJson[]; notes: NoteJson[] }> {
  const [answers, notes] = await Promise.all([
    db.selectFrom('answers').selectAll().where('record_id', '=', recordId).execute(),
    db.selectFrom('notes').selectAll().where('record_id', '=', recordId).orderBy('created_at').orderBy('id').execute(),
  ]);
  return {
    answers: answers.map((a) => ({
      questionId: a.question_id,
      score: a.score as Score | null,
      coveredKeyPoints: a.covered_key_points,
      redFlagsSeen: a.red_flags_seen,
      probeHandled: a.probe_handled,
      flagged: a.flagged,
      skipped: a.skipped,
      skipReason: a.skip_reason,
    })),
    notes: notes.map((n) => ({ id: n.id, questionId: n.question_id, atSec: n.at_sec, text: n.text, by: n.by_name })),
  };
}

type RecordRow = { id: string; interview_id: string; owner_user_id: string | null; names: string[]; shared_with: string[]; state: 'draft' | 'submitted'; overall_rating: number | null; recommendation: Recommendation | null; rationale: string | null; submitted_at: Date | null; version: number };

async function recordDetail(db: Executor, r: RecordRow): Promise<RecordDetail> {
  const data = await recordData(db, r.id);
  return {
    id: r.id,
    interviewId: r.interview_id,
    ownerId: r.owner_user_id!,
    names: r.names,
    sharedWith: r.shared_with,
    state: r.state,
    submittedAt: r.submitted_at?.toISOString() ?? null,
    version: r.version,
    overall: { rating: (r.overall_rating as Score | null) ?? null, recommendation: r.recommendation ?? null, rationale: r.rationale ?? '' },
    ...data,
  };
}

const RECORD_COLUMNS = ['id', 'interview_id', 'owner_user_id', 'names', 'shared_with', 'state', 'overall_rating', 'recommendation', 'rationale', 'submitted_at', 'version'] as const;

/** The record that speaks for `userId` in an interview: their own, or the one whose screen they share. */
async function recordFor(db: Executor, interviewId: string, userId: string): Promise<RecordRow | undefined> {
  const rows = await db.selectFrom('records').select(RECORD_COLUMNS).where('interview_id', '=', interviewId).where('origin', '=', 'live').execute();
  return rows.find((r) => r.owner_user_id === userId) ?? rows.find((r) => r.shared_with.includes(userId));
}

/**
 * LIVE-3, FLOW-27: whether others' marks are hidden from `actor`. When the round hides them, nobody
 * sees another person's marks until their own record (or the one they share) is submitted, or the
 * interview is complete. Organisers watching without a record of their own wait for completion.
 */
async function othersHidden(db: Executor, actor: Actor, interviewId: string): Promise<boolean> {
  const i = await db.selectFrom('interviews as i').innerJoin('rounds as r', 'r.id', 'i.round_id').select(['i.state', 'r.hide_others_scores']).where('i.id', '=', interviewId).executeTakeFirstOrThrow();
  if (!i.hide_others_scores || i.state === 'completed') return false;
  const mine = await recordFor(db, interviewId, actor.id);
  return mine?.state !== 'submitted';
}

/** LIVE-1, LIVE-3: my record in full, and the others' as the round lets me see them. */
export async function loadLiveRecords(db: Executor, actor: Actor, interviewId: string): Promise<LiveRecords> {
  const rows = await db.selectFrom('records').select(RECORD_COLUMNS).where('interview_id', '=', interviewId).where('origin', '=', 'live').orderBy('created_at').execute();
  const mineRow = rows.find((r) => r.owner_user_id === actor.id) ?? rows.find((r) => r.shared_with.includes(actor.id));
  const hidden = await othersHidden(db, actor, interviewId);
  const others: OtherRecord[] = [];
  for (const r of rows) {
    if (r === mineRow) continue;
    const data = await recordData(db, r.id);
    // The server never sends marks the reader may not see (LIVE-3): only which questions are resolved.
    others.push({ id: r.id, ownerId: r.owner_user_id!, names: r.names, state: r.state, resolved: resolvedQuestions(data), marks: hidden ? null : { ...data, overall: r.state === 'submitted' ? { rating: (r.overall_rating as Score | null) ?? null, recommendation: r.recommendation, rationale: r.rationale ?? '' } : EMPTY_OVERALL } });
  }
  return { mine: mineRow ? await recordDetail(db, mineRow) : null, others, hidden, serverNow: await dbNow(db) };
}

/** FLOW-11, LIVE-7: what the candidate window shows: the number and text of the panel's question, nothing else. */
export async function presentView(db: Executor, interviewId: string): Promise<PresentView> {
  const i = await db.selectFrom('interviews').select(['state', 'current_question_id', 'question_set_id']).where('id', '=', interviewId).executeTakeFirstOrThrow();
  const questions = await setQuestions(db, i.question_set_id);
  const index = questions.findIndex((q) => q.id === i.current_question_id);
  const showing = i.state === 'in_progress' && index >= 0;
  return { state: i.state as PresentView['state'], position: showing ? index + 1 : null, total: questions.length, text: showing ? questions[index].text : null };
}

// ---------------------------------------------------------------------------------------------
// Starting and joining (FLOW-7, FLOW-10, LIVE-6, LIVE-5)

async function panelRow(db: Executor, interviewId: string, userId: string) {
  return db.selectFrom('interview_panel').selectAll().where('interview_id', '=', interviewId).where('user_id', '=', userId).executeTakeFirst();
}

/** Creates my record and marks me (and anyone sharing my screen) as joined. */
async function joinRecord(db: Executor, actor: Actor, i: InterviewRow, scoringWith: readonly string[], now: number): Promise<string> {
  const me = await panelRow(db, i.id, actor.id);
  if (!me) throw new ApiError(403, 'forbidden', 'You are not on this interview’s panel.');
  if (me.status === 'did_not_take_part') throw conflict('You were marked as not taking part in this interview. Ask an organiser of the round to change that.');
  const existing = await recordFor(db, i.id, actor.id);
  if (existing) {
    if (existing.owner_user_id !== actor.id) {
      const owner = await userNames(db, [existing.owner_user_id!]);
      throw conflict(`You are scoring with ${owner.get(existing.owner_user_id!)} on their screen, so this interview is on their record.`);
    }
    return existing.id; // already joined: nothing changes (a second tab, a reload)
  }
  const others = [...new Set(scoringWith)].filter((u) => u !== actor.id);
  if (others.length) {
    const rows = await db.selectFrom('interview_panel').select(['user_id', 'status']).where('interview_id', '=', i.id).where('user_id', 'in', others).execute();
    if (rows.length !== others.length) throw invalid('Everyone you score with must be on this interview’s panel.');
    if (rows.some((r) => r.status !== 'expected')) throw invalid('Someone you chose has already joined on their own screen, or did not take part.');
  }
  const names = await userNames(db, [actor.id, ...others]);
  const rec = await db
    .insertInto('records')
    .values({ interview_id: i.id, owner_user_id: actor.id, origin: 'live', names: json([names.get(actor.id), ...others.map((u) => names.get(u))]), shared_with: json(others) })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .updateTable('interview_panel')
    .set({ status: 'joined', joined_at: new Date(now) })
    .where('interview_id', '=', i.id)
    .where('user_id', 'in', [actor.id, ...others])
    .execute();
  return rec.id;
}

/**
 * FLOW-10, LIVE-6: a panel member (or an organiser of the round) confirms consent and starts. Consent
 * is stored once for the interview: who, when, and whether the recording sentence was included. The
 * shared timers start from the database's clock. The starter leads (LIVE-2). Starting an interview
 * someone else has just started changes nothing: the caller then simply joins it.
 */
export async function startInterview(db: Executor, actor: Actor, interviewId: string, access: RoundAccess, input: { scoringWith?: string[] }): Promise<{ alreadyStarted: boolean }> {
  const i = await lockInterview(db, interviewId);
  if (i.state !== 'planned') {
    if (i.state === 'completed') throw conflict('This interview has finished.');
    return { alreadyStarted: true };
  }
  const me = await panelRow(db, interviewId, actor.id);
  const onPanel = !!me && me.status !== 'did_not_take_part';
  if (!onPanel && !canInRound(actor, 'round.plan', access)) throw new ApiError(403, 'forbidden', 'Only the interview’s panel or an organiser of the round can start it.');
  const questions = await setQuestions(db, i.question_set_id);
  const first = questions[0];
  if (!first) throw invalid('This interview has no questions.');
  const now = await dbNow(db);
  await db
    .updateTable('interviews')
    .set({
      state: 'in_progress',
      started_at: new Date(now),
      consent_at: new Date(now),
      consent_by: actor.id,
      recording_consent_at: i.recording_notice ? new Date(now) : null,
      current_question_id: first.id,
      lead_user_id: onPanel ? actor.id : null,
      ...timerColumns(startTimers(first.id, now)),
      updated_at: new Date(now),
      version: sql`version + 1`,
    })
    .where('id', '=', interviewId)
    .execute();
  // AUD-2: consent confirmed (with whether the recording notice was part of it), and the start.
  await appendAudit(db, actor, { action: 'interview.consent_confirmed', entity: 'interview', entityId: interviewId, roundId: i.round_id, after: { recordingNotice: i.recording_notice } });
  await appendAudit(db, actor, { action: 'interview.started', entity: 'interview', entityId: interviewId, roundId: i.round_id, after: { questions: questions.length } });
  if (onPanel) {
    await joinRecord(db, actor, { ...i, state: 'in_progress' }, input.scoringWith ?? [], now);
    await appendAudit(db, actor, { action: 'interview.joined', entity: 'interview', entityId: interviewId, roundId: i.round_id, after: { scoringWith: input.scoringWith ?? [] } });
  }
  await interviewEvent(db, interviewId, 'state');
  await roundEvent(db, i.round_id, interviewId);
  return { alreadyStarted: false };
}

/** LIVE-8: joining (on time or late) creates my record; joining again changes nothing. */
export async function joinInterview(db: Executor, actor: Actor, interviewId: string, input: { scoringWith?: string[] }): Promise<string> {
  const i = await lockInterview(db, interviewId);
  if (i.state === 'planned') throw conflict('This interview has not started yet.');
  if (i.state === 'completed') throw conflict('This interview has finished.');
  const before = await recordFor(db, interviewId, actor.id);
  const now = await dbNow(db);
  const id = await joinRecord(db, actor, i, input.scoringWith ?? [], now);
  if (!before) {
    // The first panel member to join leads when the interview was started by someone off the panel.
    if (!i.lead_user_id) await db.updateTable('interviews').set({ lead_user_id: actor.id, version: sql`version + 1`, updated_at: new Date(now) }).where('id', '=', interviewId).execute();
    await appendAudit(db, actor, { action: 'interview.joined', entity: 'interview', entityId: interviewId, roundId: i.round_id, after: { scoringWith: input.scoringWith ?? [] } });
    await interviewEvent(db, interviewId, 'state');
    await interviewEvent(db, interviewId, 'records');
    await roundEvent(db, i.round_id, interviewId);
  }
  return id;
}

// ---------------------------------------------------------------------------------------------
// The shared interview (LIVE-2)

/**
 * LIVE-2: the lead's Next, Previous, jumps, Pause and Resume move everyone; any panel member who has
 * joined can take the lead. Moves are conditional (moveOutcome), pause and resume are idempotent.
 */
export async function command(db: Executor, actor: Actor, interviewId: string, cmd: LiveCommand): Promise<void> {
  const i = await lockInterview(db, interviewId);
  if (!live(i.state)) throw conflict(i.state === 'planned' ? 'This interview has not started yet.' : 'This interview has finished.');
  const me = await panelRow(db, interviewId, actor.id);
  if (!me) throw new ApiError(403, 'forbidden', 'You are not on this interview’s panel.');
  if (me.status !== 'joined') throw conflict(me.status === 'submitted' ? 'You have submitted your record, so you no longer lead.' : 'Join the interview first.');
  const now = await dbNow(db);
  const t = timersOf(i);
  const update = (set: Record<string, unknown>) =>
    db
      .updateTable('interviews')
      .set({ ...set, updated_at: new Date(now), version: sql`version + 1` })
      .where('id', '=', interviewId)
      .execute();

  if (cmd.type === 'lead') {
    if (i.lead_user_id === actor.id) return;
    await update({ lead_user_id: actor.id });
    await interviewEvent(db, interviewId, 'state');
    return;
  }
  if (i.lead_user_id !== actor.id) {
    const lead = i.lead_user_id ? (await userNames(db, [i.lead_user_id])).get(i.lead_user_id) : null;
    throw conflict(lead ? `${lead} is leading now. Take the lead to move everyone.` : 'Take the lead to move everyone.');
  }
  if (cmd.type === 'move') {
    const questions = await setQuestions(db, i.question_set_id);
    if (!questions.some((q) => q.id === cmd.to)) throw invalid('That question is not in this interview.');
    const outcome = moveOutcome(i.current_question_id, cmd.from, cmd.to);
    if (outcome === 'already-there') return;
    if (outcome === 'stale') {
      const at = questions.findIndex((q) => q.id === i.current_question_id) + 1;
      throw conflict(`The panel has already moved to question ${at}.`);
    }
    await update({ current_question_id: cmd.to, ...timerColumns(moveTimers(t, cmd.from, cmd.to, i.state === 'in_progress', now)) });
  } else if (cmd.type === 'pause') {
    if (i.state === 'paused') return;
    await update({ state: 'paused', ...timerColumns(pauseTimers(t, i.current_question_id, now)) });
    await roundEvent(db, i.round_id, interviewId);
  } else {
    if (i.state === 'in_progress') return;
    await update({ state: 'in_progress', ...timerColumns(resumeTimers(t, i.current_question_id, now)) });
    await roundEvent(db, i.round_id, interviewId);
  }
  await interviewEvent(db, interviewId, 'state');
}

/**
 * LIVE-3: a heartbeat from an open interview screen (or `here: false` when it closes). Stored in the
 * database so every instance sees the same; an event goes out only when someone arrives or leaves.
 */
export async function heartbeat(db: Executor, actor: Actor, interviewId: string, here: boolean): Promise<void> {
  const onPanel = await panelRow(db, interviewId, actor.id);
  if (!onPanel) return; // only the panel is shown as present
  if (!here) {
    const gone = await db.deleteFrom('interview_presence').where('interview_id', '=', interviewId).where('user_id', '=', actor.id).executeTakeFirst();
    if (Number(gone.numDeletedRows)) await interviewEvent(db, interviewId, 'presence');
    return;
  }
  const prev = await db
    .selectFrom('interview_presence')
    .select(sql<boolean>`seen_at > clock_timestamp() - ${PRESENCE_TTL_MS}::int * interval '1 millisecond'`.as('fresh'))
    .where('interview_id', '=', interviewId)
    .where('user_id', '=', actor.id)
    .executeTakeFirst();
  await sql`INSERT INTO interview_presence (interview_id, user_id, seen_at) VALUES (${interviewId}, ${actor.id}, clock_timestamp())
    ON CONFLICT (interview_id, user_id) DO UPDATE SET seen_at = EXCLUDED.seen_at`.execute(db);
  if (!prev?.fresh) await interviewEvent(db, interviewId, 'presence');
}

/** LIVE-4: an organiser marks a panel member who never joined as "did not take part", or takes that back. */
export async function markPanel(db: Executor, actor: Actor, interviewId: string, userId: string, didNotTakePart: boolean): Promise<void> {
  const i = await lockInterview(db, interviewId);
  const p = await panelRow(db, interviewId, userId);
  if (!p) throw notFound('That panel member');
  if (didNotTakePart) {
    if (p.status === 'did_not_take_part') return;
    if (p.status !== 'expected') throw conflict('They have joined the interview, so they took part.');
  } else if (p.status !== 'did_not_take_part') return;
  await db
    .updateTable('interview_panel')
    .set({ status: didNotTakePart ? 'did_not_take_part' : 'expected', marked_by: actor.id })
    .where('interview_id', '=', interviewId)
    .where('user_id', '=', userId)
    .execute();
  await appendAudit(db, actor, { action: didNotTakePart ? 'interview.marked_did_not_take_part' : 'interview.unmarked_did_not_take_part', entity: 'interview', entityId: interviewId, roundId: i.round_id, after: { user: userId } });
  await interviewEvent(db, interviewId, 'state');
  await roundEvent(db, i.round_id, interviewId);
}

// ---------------------------------------------------------------------------------------------
// My record (LIVE-1, FLOW-13…FLOW-18, RES-1, HOST-6)

async function lockRecord(db: Executor, recordId: string) {
  const r = await db.selectFrom('records').select(RECORD_COLUMNS).where('id', '=', recordId).where('origin', '=', 'live').forUpdate().executeTakeFirst();
  if (!r) throw notFound('That record');
  return r;
}

/** LIVE-1: only its owner writes a record. Not the other panel members, not an organiser, not an administrator. */
function mustOwn(actor: Actor, r: { owner_user_id: string | null }) {
  if (r.owner_user_id !== actor.id) throw new ApiError(403, 'forbidden', 'Only the person whose record this is can change it.');
}

/** Saves a changed record: the answers that changed, the notes added, edited and removed, the overall assessment. */
async function writeRecord(db: Executor, recordId: string, before: RecordData, after: RecordData, now: number): Promise<void> {
  for (const a of after.answers) {
    const b = before.answers.find((x) => x.questionId === a.questionId);
    if (b && JSON.stringify(b) === JSON.stringify(a)) continue;
    await db
      .insertInto('answers')
      .values({
        record_id: recordId,
        question_id: a.questionId,
        score: a.score,
        covered_key_points: json(a.coveredKeyPoints),
        red_flags_seen: json(a.redFlagsSeen),
        probe_handled: a.probeHandled,
        flagged: a.flagged,
        skipped: a.skipped,
        skip_reason: a.skipReason,
      })
      .onConflict((oc) =>
        oc.columns(['record_id', 'question_id']).doUpdateSet({
          score: a.score,
          covered_key_points: json(a.coveredKeyPoints),
          red_flags_seen: json(a.redFlagsSeen),
          probe_handled: a.probeHandled,
          flagged: a.flagged,
          skipped: a.skipped,
          skip_reason: a.skipReason,
          version: sql`answers.version + 1`,
          updated_at: new Date(now),
        }),
      )
      .execute();
  }
  const gone = before.notes.filter((n) => !after.notes.some((x) => x.id === n.id)).map((n) => n.id);
  if (gone.length) await db.deleteFrom('notes').where('record_id', '=', recordId).where('id', 'in', gone).execute();
  for (const n of after.notes) {
    const b = before.notes.find((x) => x.id === n.id);
    if (!b) await db.insertInto('notes').values({ id: n.id, record_id: recordId, question_id: n.questionId, at_sec: n.atSec, text: n.text, by_name: n.by }).execute();
    else if (b.text !== n.text || b.by !== n.by) await db.updateTable('notes').set({ text: n.text, by_name: n.by, updated_at: new Date(now) }).where('id', '=', n.id).where('record_id', '=', recordId).execute();
  }
  const o = after.overall;
  await db
    .updateTable('records')
    .set({ overall_rating: o.rating, recommendation: o.recommendation, rationale: o.rationale || null, updated_at: new Date(now), version: sql`version + 1` })
    .where('id', '=', recordId)
    .execute();
}

/**
 * RES-1, HOST-6: applies a batch of changes to my own draft record, in order, in one transaction.
 * Every op is checked against the question set first; one bad op refuses the batch. Notes carry ids
 * chosen by the browser, so a batch sent twice stores each note once.
 */
export async function applyOps(db: Executor, actor: Actor, recordId: string, ops: readonly RecordOp[]): Promise<RecordDetail> {
  const r = await lockRecord(db, recordId);
  mustOwn(actor, r);
  if (r.state === 'submitted') throw conflict('This record is submitted. To change it, use Amend and give a reason.');
  const i = await db.selectFrom('interviews').select(['id', 'question_set_id', 'state']).where('id', '=', r.interview_id).executeTakeFirstOrThrow();
  const questions = await setQuestions(db, i.question_set_id);
  const before: RecordData = { ...(await recordData(db, recordId)), overall: { rating: (r.overall_rating as Score | null) ?? null, recommendation: r.recommendation, rationale: r.rationale ?? '' } };
  let after = before;
  for (const op of ops) {
    const problem = recordOpProblem(op, questions);
    if (problem) throw invalid(problem);
    if (op.t === 'note.add' && !before.notes.some((n) => n.id === op.id)) {
      const elsewhere = await db.selectFrom('notes').select('record_id').where('id', '=', op.id).executeTakeFirst();
      if (elsewhere && elsewhere.record_id !== recordId) throw conflict('That note belongs to another record.');
    }
    after = applyRecordOp(after, op);
  }
  const now = await dbNow(db);
  await writeRecord(db, recordId, before, after, now);
  await interviewEvent(db, r.interview_id, 'records');
  return recordDetail(db, await lockRecord(db, recordId));
}

/** When the lead submits, the lead passes to whoever joined first among those still interviewing. */
async function handOnLead(db: Executor, i: InterviewRow, leaving: readonly string[]): Promise<boolean> {
  if (!i.lead_user_id || !leaving.includes(i.lead_user_id)) return false;
  const next = await db
    .selectFrom('interview_panel')
    .select('user_id')
    .where('interview_id', '=', i.id)
    .where('status', '=', 'joined')
    .where('user_id', 'not in', [...leaving])
    .orderBy('joined_at')
    .executeTakeFirst();
  await db.updateTable('interviews').set({ lead_user_id: next?.user_id ?? i.lead_user_id, version: sql`version + 1` }).where('id', '=', i.id).execute();
  return !!next;
}

/** LIVE-4: completes the interview when everyone who joined has submitted; the timers stop. */
async function completeIfDone(db: Executor, actor: Actor, interviewId: string): Promise<boolean> {
  const i = await lockInterview(db, interviewId);
  if (!live(i.state)) return false;
  const statuses = (await db.selectFrom('interview_panel').select('status').where('interview_id', '=', interviewId).execute()).map((p) => p.status);
  if (!isComplete(statuses)) return false;
  const now = await dbNow(db);
  await db
    .updateTable('interviews')
    .set({ state: 'completed', completed_at: new Date(now), ...timerColumns(stopAllTimers(timersOf(i), now)), updated_at: new Date(now), version: sql`version + 1` })
    .where('id', '=', interviewId)
    .execute();
  await appendAudit(db, actor, { action: 'interview.completed', entity: 'interview', entityId: interviewId, roundId: i.round_id, after: { submitted: statuses.filter((s) => s === 'submitted').length } });
  return true;
}

/** FLOW-22, FLOW-23, LIVE-4: submits my record (every question resolved, a note for each 1 or 4, the overall assessment); it is then read-only. */
export async function submitRecord(db: Executor, actor: Actor, recordId: string): Promise<void> {
  const r = await lockRecord(db, recordId);
  mustOwn(actor, r);
  if (r.state === 'submitted') return;
  const i = await lockInterview(db, r.interview_id);
  if (!live(i.state)) throw conflict('This interview is not running.');
  const questions = await setQuestions(db, i.question_set_id);
  const data = await recordData(db, recordId);
  const overall = { rating: (r.overall_rating as Score | null) ?? null, recommendation: r.recommendation, rationale: r.rationale ?? '' };
  const problems = canFinish({ questions }, toDomainAnswers(data, recordId), toDomainOverall(overall));
  if (problems.length) throw invalid('The record cannot be submitted yet.', problems.map((p) => p.message));
  const now = await dbNow(db);
  await db.updateTable('records').set({ state: 'submitted', submitted_at: new Date(now), updated_at: new Date(now), version: sql`version + 1` }).where('id', '=', recordId).execute();
  const people = [actor.id, ...r.shared_with];
  await db.updateTable('interview_panel').set({ status: 'submitted' }).where('interview_id', '=', i.id).where('user_id', 'in', people).execute();
  await appendAudit(db, actor, {
    action: 'record.submitted',
    entity: 'record',
    entityId: recordId,
    roundId: i.round_id,
    after: { interviewId: i.id, scored: data.answers.filter((a) => a.score != null).length, skipped: data.answers.filter((a) => a.skipped).length, rating: overall.rating, recommendation: overall.recommendation },
  });
  await db.deleteFrom('interview_presence').where('interview_id', '=', i.id).where('user_id', 'in', people).execute();
  if (!(await completeIfDone(db, actor, i.id))) await handOnLead(db, i, people);
  await interviewEvent(db, i.id, 'state');
  await interviewEvent(db, i.id, 'records');
  await roundEvent(db, i.round_id, i.id);
}

/**
 * AUD-4, FLOW-23: the owner changes a submitted record: a question's score or notes, or the overall
 * assessment. A reason is required; the audit entry holds the values before and after. The finish
 * rules still hold afterwards (a 1 or 4 keeps its note).
 */
export async function amendRecord(db: Executor, actor: Actor, recordId: string, input: AmendInput): Promise<RecordDetail> {
  const r = await lockRecord(db, recordId);
  mustOwn(actor, r);
  if (r.state !== 'submitted') throw conflict('This record is not submitted yet; change it in the interview.');
  const reason = input.reason.trim();
  if (!reason) throw invalid('Say why you are changing it.', { reason: 'Say why you are changing it.' });
  const i = await db.selectFrom('interviews').select(['id', 'round_id', 'question_set_id']).where('id', '=', r.interview_id).executeTakeFirstOrThrow();
  const questions = await setQuestions(db, i.question_set_id);
  const beforeOverall = { rating: (r.overall_rating as Score | null) ?? null, recommendation: r.recommendation, rationale: r.rationale ?? '' };
  const before: RecordData = { ...(await recordData(db, recordId)), overall: beforeOverall };
  let after = before;
  const auditBefore: Record<string, unknown> = {};
  const auditAfter: Record<string, unknown> = {};
  if (input.question) {
    const q = input.question;
    if (!questions.some((x) => x.id === q.id)) throw invalid('That question is not in this interview.');
    const prev = before.answers.find((a) => a.questionId === q.id);
    if (q.score !== undefined && (prev?.score ?? null) !== q.score) {
      after = applyRecordOp(after, { t: 'score', q: q.id, v: q.score });
      auditBefore.score = prev?.score ?? null;
      auditAfter.score = q.score;
    }
    if (q.notes) {
      const old = before.notes.filter((n) => n.questionId === q.id);
      const next: NoteJson[] = q.notes
        .filter((n) => n.text.trim())
        .map((n) => ({ id: n.id && old.some((o) => o.id === n.id) ? n.id : crypto.randomUUID(), questionId: q.id, atSec: Math.max(0, Math.floor(n.atSec)), text: n.text.trim(), by: n.by ?? old.find((o) => o.id === n.id)?.by ?? null }));
      const same = old.length === next.length && old.every((o, k) => o.id === next[k].id && o.text === next[k].text);
      if (!same) {
        after = { ...after, notes: [...after.notes.filter((n) => n.questionId !== q.id), ...next] };
        auditBefore.notes = old.map((n) => n.text);
        auditAfter.notes = next.map((n) => n.text);
      }
    }
    if (Object.keys(auditAfter).length) {
      auditBefore.question = q.id;
      auditAfter.question = q.id;
    }
  }
  if (input.overall) {
    const o = input.overall;
    const next = { ...after.overall, ...(o.rating !== undefined ? { rating: o.rating } : {}), ...(o.recommendation !== undefined ? { recommendation: o.recommendation } : {}), ...(o.rationale !== undefined ? { rationale: o.rationale.trim() } : {}) };
    for (const k of ['rating', 'recommendation', 'rationale'] as const) {
      if (next[k] !== beforeOverall[k]) {
        auditBefore[k] = beforeOverall[k];
        auditAfter[k] = next[k];
      }
    }
    after = { ...after, overall: next };
  }
  if (!Object.keys(auditAfter).length) throw invalid('Nothing has changed.');
  const problems = canFinish({ questions }, toDomainAnswers(after, recordId), toDomainOverall(after.overall));
  if (problems.length) throw invalid('That change would break a rule of a submitted record.', problems.map((p) => p.message));
  const now = await dbNow(db);
  await writeRecord(db, recordId, before, after, now);
  await appendAudit(db, actor, { action: 'record.amended', entity: 'record', entityId: recordId, roundId: i.round_id, before: auditBefore, after: auditAfter, reason });
  await interviewEvent(db, i.id, 'records');
  return recordDetail(db, await lockRecord(db, recordId));
}

// ---------------------------------------------------------------------------------------------
// Scorecards (FLOW-24, FLOW-31, FLOW-32)

/**
 * FLOW-24, LIVE-3: one record with what its scorecard needs. Its owner (and anyone sharing it) can
 * always read it; another member of the round only once it is submitted and, when the round hides
 * scores, once their own record is submitted too (or the interview is complete).
 */
export async function loadScorecard(db: Executor, actor: Actor, recordId: string): Promise<ScorecardData> {
  const r = await db.selectFrom('records').select(RECORD_COLUMNS).where('id', '=', recordId).where('origin', '=', 'live').executeTakeFirst();
  if (!r) throw notFound('That record');
  const ownish = r.owner_user_id === actor.id || r.shared_with.includes(actor.id);
  if (!ownish) {
    if (r.state !== 'submitted') throw notFound('That record');
    if (await othersHidden(db, actor, r.interview_id)) throw new ApiError(403, 'forbidden', 'This round hides other people’s scores until you have submitted yours.');
  }
  const i = await db.selectFrom('interviews').selectAll().where('id', '=', r.interview_id).executeTakeFirstOrThrow();
  const [interview, record, now] = await Promise.all([loadInterview(db, actor, r.interview_id), recordDetail(db, r), dbNow(db)]);
  return { record, interview, elapsedSec: questionSeconds(timersOf(i), now), startedAt: i.started_at?.toISOString() ?? null, mine: r.owner_user_id === actor.id };
}

/** FLOW-32: every export of a scorecard is recorded. */
export async function recordExported(db: Executor, actor: Actor, recordId: string, format: string): Promise<void> {
  const sc = await loadScorecard(db, actor, recordId);
  await appendAudit(db, actor, { action: 'scorecard.exported', entity: 'record', entityId: recordId, roundId: sc.interview.roundId, after: { format } });
}
