// TEAM-1…TEAM-5, TEAM-15: interviews planned ahead, invitation files, "Plan several".
//
// A planned interview is an ordinary local record (session, state "planned") on a locked plan, plus
// a PlannedInterview row keyed by its invitation id with the schedule, the expected interviewers
// and the note. Starting it is the usual ready screen (FLOW-10). The invitation id travels in
// invitation files and in the interview files exported from the record, so results can be matched.
import { db } from './db';
import { RepoError, appendAudit, clock, getSetting, newId, nowIso } from './util';
import { SETTINGS } from './db';
import { continueDraft, createPlan, createSessionFromPlan, drawDraft, lockPlan } from './plans';
import { getDefaultRetentionDays } from './settings';
import { addDays, candidateKey, cleanCandidate, formatCandidateKey, isoDate } from '../domain/plan';
import { interviewersOf } from '../domain/interviewers';
import { invitationFile, exportFileName, toJson } from '../domain/export';
import { scheduleProblems, uniqueNames, type ScheduleInput } from '../domain/team';
import { validateInvitationFile, type CandidateInput } from '../domain/validation';
import type { InterviewPlan, InvitationEntry, PlannedInterview, Session } from '../domain/types';
import type { BulkLine } from '../domain/bulkPlan';
import type { ExportedFile } from './transfer';

const TABLES = () => [
  db.plans,
  db.questions,
  db.sessions,
  db.answers,
  db.audit,
  db.settings,
  db.candidateDrafts,
  db.plannedInterviews,
  db.tracks,
  db.categories,
  db.transcripts,
  db.recordings,
  db.aiResults,
];

function checkSchedule(s: ScheduleInput): void {
  const errors = scheduleProblems(s);
  if (Object.keys(errors).length) throw new RepoError('invalid', 'Some details of the planned interview are not valid.', Object.values(errors) as string[]);
}

async function deviceName(): Promise<string> {
  const name = (await getSetting<string>(SETTINGS.interviewerName))?.trim();
  if (!name) throw new RepoError('name-required', 'Enter your name for this device first.');
  return name;
}

/** The plan as documented (DATA-1), without any extra fields a file may carry. */
function cleanPlan(p: InterviewPlan): InterviewPlan {
  return {
    id: p.id,
    trackId: p.trackId,
    trackVersion: p.trackVersion,
    name: p.name,
    questions: p.questions,
    categories: p.categories,
    timeBudgetMin: p.timeBudgetMin,
    locked: p.locked,
    lockedAt: p.lockedAt,
    fingerprint: p.fingerprint,
    createdAt: p.createdAt,
  };
}

async function newRecord(session: Session, plan: InterviewPlan, s: { date: string | null; time: string | null; expected: string[]; note: string; organiser: string }, id: string): Promise<PlannedInterview> {
  const now = nowIso();
  const record: PlannedInterview = {
    id,
    planId: plan.id,
    fingerprint: plan.fingerprint!,
    candidate: { initials: session.candidate.initials, requisitionId: session.candidate.requisitionId },
    retentionUntil: session.candidate.retentionUntil,
    date: s.date,
    time: s.date ? s.time : null,
    expected: uniqueNames(s.expected.length ? s.expected : interviewersOf(session)),
    recordingNotice: session.candidate.recordingNotice === true,
    note: s.note.trim(),
    organiser: s.organiser,
    createdAt: now,
    updatedAt: now,
    source: 'here',
    sessionId: session.id,
  };
  await db.plannedInterviews.add(record);
  await appendAudit({
    action: 'invitation.saved',
    entity: 'invitation',
    entityId: id,
    after: { sessionId: session.id, fingerprint: plan.fingerprint, date: record.date, time: record.time, expected: record.expected.length },
  });
  return record;
}

/**
 * TEAM-1: "Save for later" on the New interview screen. Like Continue (the questions are fixed,
 * FLOW-8, and the record is created ready to start) but the ready screen is not opened; the
 * interview is listed under Upcoming with its date, time, expected interviewers and note.
 * `schedule.expected` empty means the people at this machine (PANEL-1). Audited.
 */
export async function saveForLater(planId: string, input: CandidateInput, schedule: ScheduleInput): Promise<{ invitationId: string; sessionId: string }> {
  checkSchedule(schedule);
  return db.transaction('rw', TABLES(), async () => {
    const invitationId = newId();
    const { sessionId, planId: lockedId } = await continueDraft(planId, input, { invitationId });
    const session = (await db.sessions.get(sessionId))!;
    const plan = (await db.plans.get(lockedId))!;
    const organiser = (await getSetting<string>(SETTINGS.interviewerName))?.trim() || interviewersOf(session)[0];
    await newRecord(session, plan, { date: schedule.date || null, time: schedule.time || null, expected: schedule.expected, note: schedule.note, organiser }, invitationId);
    return { invitationId, sessionId };
  });
}

async function getPlanned(id: string): Promise<{ planned: PlannedInterview; session: Session | undefined }> {
  const planned = await db.plannedInterviews.get(id);
  if (!planned) throw new RepoError('not-found', 'That planned interview is not on this device.');
  return { planned, session: await db.sessions.get(planned.sessionId) };
}

const notStarted = (s: Session | undefined) => !s || s.state === 'planned';

/** TEAM-2: "Change": the date, time, expected interviewers and note (never the questions). Audited (field names only). */
export async function changePlanned(id: string, schedule: ScheduleInput): Promise<void> {
  checkSchedule(schedule);
  await db.transaction('rw', TABLES(), async () => {
    const { planned, session } = await getPlanned(id);
    if (!notStarted(session)) throw new RepoError('started', 'This interview has started; it can no longer be changed here.');
    const next: PlannedInterview = {
      ...planned,
      date: schedule.date || null,
      time: schedule.date ? schedule.time || null : null,
      expected: uniqueNames(schedule.expected),
      note: schedule.note.trim(),
      updatedAt: nowIso(),
    };
    const fields = (['date', 'time', 'expected', 'note'] as const).filter((k) => JSON.stringify(planned[k]) !== JSON.stringify(next[k]));
    if (!fields.length) return;
    await db.plannedInterviews.put(next);
    // AUD-1: field names only; the note may mention the candidate.
    await appendAudit({ action: 'invitation.changed', entity: 'invitation', entityId: id, after: { fields } });
  });
}

/** TEAM-2: "Cancel": removes a planned interview that has not started, with its record. Audited. */
export async function cancelPlanned(id: string): Promise<void> {
  await db.transaction('rw', TABLES(), async () => {
    const { planned, session } = await getPlanned(id);
    if (!notStarted(session)) throw new RepoError('started', 'This interview has started, so it cannot be cancelled.');
    if (session) {
      await db.answers.where('sessionId').equals(session.id).delete();
      await db.sessions.delete(session.id);
      await Promise.all([db.transcripts.delete(session.id), db.recordings.delete(session.id), db.aiResults.delete(session.id)]);
    }
    await db.plannedInterviews.delete(planned.id);
    await appendAudit({ action: 'invitation.cancelled', entity: 'invitation', entityId: id, after: { sessionId: planned.sessionId } });
  });
}

/**
 * TEAM-3: one invitation file for one or more planned interviews (questions, candidate's name or
 * initials and requisition id, schedule, expected interviewers, recording option, note, organiser;
 * no scores). Audited (FLOW-32).
 */
export async function exportInvitations(ids: readonly string[]): Promise<ExportedFile & { count: number }> {
  if (!ids.length) throw new RepoError('invalid', 'Choose at least one planned interview.');
  return db.transaction('rw', TABLES(), async () => {
    const items: Array<{ planned: PlannedInterview; plan: InterviewPlan }> = [];
    for (const id of new Set(ids)) {
      const { planned } = await getPlanned(id);
      const plan = await db.plans.get(planned.planId);
      if (!plan?.locked) throw new RepoError('not-found', 'The questions of a planned interview are missing.');
      items.push({ planned, plan: cleanPlan(plan) });
    }
    const file = invitationFile(items, new Date(clock.now()));
    // TEAM-3: remember the export, so a later change shows as "changed since the invitation was sent".
    const exportedAt = nowIso();
    await db.plannedInterviews.bulkPut(items.map((i) => ({ ...i.planned, exportedAt })));
    await appendAudit({
      action: 'export',
      entity: 'invitation',
      entityId: items.length === 1 ? items[0].planned.id : null,
      after: { format: 'invitation-json', interviews: items.length, invitationIds: items.map((i) => i.planned.id) },
    });
    return { fileName: exportFileName('invitation', items[0].planned.id, 'json', new Date(clock.now())), mime: 'application/json', text: toJson(file), count: items.length };
  });
}

export type InvitationOutcome = 'added' | 'updated' | 'unchanged' | 'started' | 'submitted' | 'conflict';

export interface InvitationImportItem {
  invitationId: string;
  /** Display text, e.g. "Ana Diaz · REQ-1". */
  candidate: string;
  date: string | null;
  time: string | null;
  outcome: InvitationOutcome;
  /** The local record (absent on a conflict). */
  sessionId?: string;
  /** For 'updated': which details changed. */
  changed?: string[];
  /** For 'conflict': why nothing was done. */
  message?: string;
}

export interface InvitationImportResult {
  organiser: string;
  items: InvitationImportItem[];
}

/**
 * TEAM-4, SEC-2: imports an invitation file. The whole file is validated first (nothing is added
 * when it is not valid). Each interview is then:
 *   - new here: added to Upcoming, with this device's interviewer as the one who will score it;
 *   - already here and not started: updated (date, time, interviewers, note, recording option);
 *   - already here and started or submitted: left alone, and reported.
 * The questions come with the file (plan snapshot and fingerprint), so the results group with
 * everyone else's (FLOW-29). Audited.
 */
export async function importInvitationFile(json: unknown): Promise<InvitationImportResult> {
  const v = validateInvitationFile(json);
  if (!v.ok) throw new RepoError('invalid-file', 'The invitation file is not valid.', v.errors);
  const file = v.value;
  return db.transaction('rw', TABLES(), async () => {
    const me = await deviceName();
    const today = isoDate(new Date(clock.now()));
    const fallbackRetention = isoDate(addDays(new Date(clock.now()), await getDefaultRetentionDays()));
    const items: InvitationImportItem[] = [];
    for (const e of file.interviews) items.push(await importEntry(e, me, e.retentionUntil >= today ? e.retentionUntil : fallbackRetention));
    const count = (o: InvitationOutcome) => items.filter((i) => i.outcome === o).length;
    await appendAudit({
      action: 'import',
      entity: 'invitation',
      entityId: items.length === 1 ? items[0].invitationId : null,
      after: {
        format: 'invitation-json',
        added: count('added'),
        updated: count('updated'),
        unchanged: count('unchanged'),
        leftAlone: count('started') + count('submitted'),
        conflicts: count('conflict'),
        invitationIds: items.map((i) => i.invitationId),
      },
    });
    return { organiser: file.interviews[0].organiser, items };
  });
}

async function importEntry(e: InvitationEntry, me: string, retentionUntil: string): Promise<InvitationImportItem> {
  const base = { invitationId: e.invitationId, candidate: formatCandidateKey(e.candidate), date: e.date, time: e.time };
  const conflict = (message: string): InvitationImportItem => ({ ...base, outcome: 'conflict', message });
  const plan = cleanPlan(e.plan);
  const existingPlan = await db.plans.get(plan.id);
  if (existingPlan && existingPlan.fingerprint !== plan.fingerprint) return conflict('Its questions clash with a different question set on this device.');
  const existing = await db.plannedInterviews.get(e.invitationId);
  const candidate = { initials: cleanCandidate(e.candidate.initials), requisitionId: e.candidate.requisitionId?.trim() || null };
  const details = { date: e.date, time: e.time, expected: uniqueNames(e.expectedInterviewers), note: e.note.trim(), recordingNotice: e.recordingNotice, organiser: e.organiser.trim() };

  if (existing) {
    if (candidateKey(existing.candidate) !== candidateKey(candidate) || existing.fingerprint !== plan.fingerprint) {
      return conflict('An interview with the same invitation is on this device for a different candidate or different questions.');
    }
    const session = await db.sessions.get(existing.sessionId);
    if (session && session.state !== 'planned') return { ...base, outcome: session.state === 'submitted' ? 'submitted' : 'started', sessionId: session.id };
    const changed = (Object.keys(details) as Array<keyof typeof details>).filter((k) => JSON.stringify(existing[k]) !== JSON.stringify(details[k]));
    if (!changed.length) return { ...base, outcome: 'unchanged', sessionId: existing.sessionId };
    await db.plannedInterviews.put({ ...existing, ...details, updatedAt: e.updatedAt, importedAt: nowIso() });
    if (session && changed.includes('recordingNotice')) {
      await db.sessions.put({ ...session, candidate: { ...session.candidate, recordingNotice: e.recordingNotice || undefined } });
    }
    return { ...base, outcome: 'updated', sessionId: existing.sessionId, changed };
  }

  if (!existingPlan) await db.plans.add(plan);
  const sessionId = await createSessionFromPlan(
    plan.id,
    { initials: candidate.initials, requisitionId: candidate.requisitionId, interviewerName: me, otherInterviewers: [], retentionUntil, recordingNotice: e.recordingNotice },
    { invitationId: e.invitationId, remember: false },
  );
  await db.plannedInterviews.add({
    id: e.invitationId,
    planId: plan.id,
    fingerprint: plan.fingerprint!,
    candidate,
    retentionUntil,
    ...details,
    time: details.date ? details.time : null,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    source: 'invitation',
    importedAt: nowIso(),
    sessionId,
  });
  return { ...base, outcome: 'added', sessionId };
}

export interface PlanSeveralInput {
  trackId: string;
  /** TEAM-15: true (default): one question set, fixed once and shared by all, so they can be compared. */
  sameQuestions: boolean;
  /** Lines from parseBulkPlan without problems. */
  lines: ReadonlyArray<Pick<BulkLine, 'candidate' | 'requisitionId' | 'date' | 'time' | 'interviewers'>>;
  recordingNotice?: boolean;
  note?: string;
  /** For repeatable draws in tests. */
  seed?: number;
}

/**
 * TEAM-15: creates one planned interview per line for one role, all or nothing. With
 * `sameQuestions` one set is drawn and fixed once (one fingerprint for all, FLOW-9); otherwise each
 * gets its own draw. This device's interviewer is the one who scores each here; the expected
 * interviewers are the line's names (or this device's interviewer). Each is audited.
 */
export async function planSeveral(input: PlanSeveralInput): Promise<{ invitationIds: string[]; planIds: string[] }> {
  if (!input.lines.length) throw new RepoError('invalid', 'There is nothing to plan.');
  const note = input.note ?? '';
  for (const l of input.lines) checkSchedule({ date: l.date ?? '', time: l.time ?? '', expected: l.interviewers, note });
  return db.transaction('rw', TABLES(), async () => {
    const me = await deviceName();
    const retentionUntil = isoDate(addDays(new Date(clock.now()), await getDefaultRetentionDays()));
    const invitationIds: string[] = [];
    const planIds = new Set<string>();
    let shared: string | null = null;
    let n = 0;
    for (const line of input.lines) {
      const invitationId = newId();
      const candidateInput: CandidateInput = {
        initials: line.candidate,
        requisitionId: line.requisitionId,
        interviewerName: me,
        otherInterviewers: [],
        retentionUntil,
        recordingNotice: input.recordingNotice === true,
      };
      let sessionId: string;
      if (input.sameQuestions && shared) {
        sessionId = await createSessionFromPlan(shared, candidateInput, { invitationId, remember: false });
      } else {
        const draft = await createPlan(input.trackId);
        await drawDraft(draft, { seed: input.seed === undefined ? undefined : input.seed + n++ });
        sessionId = (await lockPlan(draft, candidateInput, { invitationId })).sessionId;
        shared = draft;
      }
      const session = (await db.sessions.get(sessionId))!;
      const plan = (await db.plans.get(session.planId))!;
      planIds.add(plan.id);
      await newRecord(session, plan, { date: line.date, time: line.time, expected: line.interviewers.length ? line.interviewers : [me], note, organiser: me }, invitationId);
      invitationIds.push(invitationId);
    }
    return { invitationIds, planIds: [...planIds] };
  });
}
