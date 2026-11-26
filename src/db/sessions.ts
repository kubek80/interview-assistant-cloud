import { db } from './db';
import { RepoError, appendAudit, clock, nowIso } from './util';
import { elapsedMs, elapsedSec, pauseTimer, startTimer } from '../domain/timer';
import { canFinish } from '../domain/validation';
import type { Answer, InterviewPlan, NoteEntry, OverallAssessment, Score, Session } from '../domain/types';
import { cleanName, interviewerNameProblems, interviewersOf, nameKey } from '../domain/interviewers';

// Every function here writes straight to IndexedDB, so each change is saved as it is made (RES-1).

const T = () => [db.sessions, db.answers, db.plans, db.audit, db.settings];

async function load(sessionId: string): Promise<{ session: Session; plan: InterviewPlan }> {
  const session = await db.sessions.get(sessionId);
  if (!session) throw new RepoError('not-found', 'Interview not found.');
  const plan = await db.plans.get(session.planId);
  if (!plan) throw new RepoError('not-found', 'The plan for this interview is missing.');
  return { session, plan };
}

function assertEditable(session: Session): void {
  if (session.origin !== 'local') throw new RepoError('read-only', 'Imported panelist sessions are read-only.');
  if (session.state === 'submitted') throw new RepoError('submitted', 'This interview is submitted. Use Amend and give a reason to change it.');
}

async function getAnswer(sessionId: string, questionId: string, plan: InterviewPlan): Promise<Answer> {
  if (!plan.questions.some((q) => q.id === questionId)) throw new RepoError('not-found', 'Question is not in this plan.');
  return (
    (await db.answers.get([sessionId, questionId])) ?? {
      sessionId,
      questionId,
      score: null,
      coveredKeyPoints: [],
      redFlagsSeen: [],
      probeHandled: false,
      notes: [],
      flagged: false,
      skipped: false,
      skipReason: null,
      elapsedSec: 0,
      timer: { accumulatedMs: 0, runningSince: null },
    }
  );
}

function stopAnswerTimer(a: Answer, now: number): Answer {
  const timer = pauseTimer(a.timer ?? { accumulatedMs: 0, runningSince: null }, now);
  return { ...a, timer, elapsedSec: Math.floor(timer.accumulatedMs / 1000) };
}

async function stopCurrentQuestionTimer(session: Session, plan: InterviewPlan, now: number): Promise<void> {
  if (!session.currentQuestionId) return;
  const a = await getAnswer(session.id, session.currentQuestionId, plan);
  await db.answers.put(stopAnswerTimer(a, now));
}

async function startQuestionTimer(sessionId: string, questionId: string, plan: InterviewPlan, now: number): Promise<void> {
  const a = await getAnswer(sessionId, questionId, plan);
  await db.answers.put({ ...a, timer: startTimer(a.timer ?? { accumulatedMs: 0, runningSince: null }, now) });
}

/**
 * FLOW-7, PRIV-4, TR-4: on the ready screen, with the candidate present, the interviewer confirms
 * the candidate has been told the consent text. Stores the time. When the interview will be
 * recorded or transcribed (`recordingNotice`, default: the choice made at setup), the confirmation
 * covers the recording sentence too (recordingConsent, source 'setup'). Audited.
 */
export async function confirmConsent(sessionId: string, opts: { recordingNotice?: boolean } = {}): Promise<void> {
  await db.transaction('rw', T(), async () => {
    const { session } = await load(sessionId);
    assertEditable(session);
    if (session.state !== 'planned') throw new RepoError('invalid-state', 'This interview has already started.');
    const at = nowIso();
    const recording = opts.recordingNotice ?? session.candidate.recordingNotice === true;
    const { recordingConsent: _old, ...candidate } = session.candidate;
    await db.sessions.put({
      ...session,
      candidate: { ...candidate, consentAt: at, recordingNotice: recording || undefined, ...(recording ? { recordingConsent: { at, source: 'setup' as const } } : {}) },
    });
    await appendAudit({ action: 'session.consent_confirmed', entity: 'session', entityId: sessionId, after: { at, recordingNotice: recording }, actorFallback: session.interviewer.name });
  });
}

/**
 * FLOW-10: starts the overall timer and the first question's timer. Refused until consent has been
 * confirmed (FLOW-7, PRIV-4). Audited (AUD-2).
 */
export async function startSession(sessionId: string): Promise<void> {
  await db.transaction('rw', T(), async () => {
    const { session, plan } = await load(sessionId);
    assertEditable(session);
    if (session.state !== 'planned') throw new RepoError('invalid-state', 'This interview has already started.');
    if (!session.candidate.consentAt) throw new RepoError('consent-required', 'Confirm the candidate has been told how their data is used before you start.');
    const now = clock.now();
    const currentQuestionId = session.currentQuestionId ?? plan.questions[0]?.id ?? null;
    await db.sessions.put({ ...session, state: 'in_progress', startedAt: nowIso(), timer: startTimer(session.timer, now), currentQuestionId });
    if (currentQuestionId) await startQuestionTimer(sessionId, currentQuestionId, plan, now);
    await appendAudit({ action: 'session.started', entity: 'session', entityId: sessionId, actorFallback: session.interviewer.name });
  });
}

/** FLOW-21: stops both timers. */
export async function pauseSession(sessionId: string): Promise<void> {
  await db.transaction('rw', T(), async () => {
    const { session, plan } = await load(sessionId);
    assertEditable(session);
    if (session.state !== 'in_progress') return;
    const now = clock.now();
    await stopCurrentQuestionTimer(session, plan, now);
    await db.sessions.put({ ...session, state: 'paused', timer: pauseTimer(session.timer, now) });
  });
}

/** FLOW-21 */
export async function resumeSession(sessionId: string): Promise<void> {
  await db.transaction('rw', T(), async () => {
    const { session, plan } = await load(sessionId);
    assertEditable(session);
    if (session.state !== 'paused') return;
    const now = clock.now();
    await db.sessions.put({ ...session, state: 'in_progress', timer: startTimer(session.timer, now) });
    if (session.currentQuestionId) await startQuestionTimer(sessionId, session.currentQuestionId, plan, now);
  });
}

/** FLOW-20: jump to any question; moves the per-question timer when the interview is running. */
export async function goToQuestion(sessionId: string, questionId: string): Promise<void> {
  await db.transaction('rw', T(), async () => {
    const { session, plan } = await load(sessionId);
    if (!plan.questions.some((q) => q.id === questionId)) throw new RepoError('not-found', 'Question is not in this plan.');
    if (session.currentQuestionId === questionId) return;
    // Navigation is allowed on submitted/imported sessions too (read-only review), without timers.
    if (session.origin === 'local' && session.state === 'in_progress') {
      const now = clock.now();
      await stopCurrentQuestionTimer(session, plan, now);
      await startQuestionTimer(sessionId, questionId, plan, now);
    }
    await db.sessions.put({ ...session, currentQuestionId: questionId });
  });
}

/** FLOW-20: offset +1 for next, -1 for previous. Returns the new question id, or null at either end. */
export async function stepQuestion(sessionId: string, offset: 1 | -1): Promise<string | null> {
  const { session, plan } = await load(sessionId);
  const i = plan.questions.findIndex((q) => q.id === session.currentQuestionId);
  const target = plan.questions[i + offset];
  if (!target) return null;
  await goToQuestion(sessionId, target.id);
  return target.id;
}
export const nextQuestion = (sessionId: string) => stepQuestion(sessionId, 1);
export const previousQuestion = (sessionId: string) => stepQuestion(sessionId, -1);

async function mutateAnswer(sessionId: string, questionId: string, fn: (a: Answer, session: Session) => Answer): Promise<void> {
  await db.transaction('rw', T(), async () => {
    const { session, plan } = await load(sessionId);
    assertEditable(session);
    const a = await getAnswer(sessionId, questionId, plan);
    await db.answers.put(fn(a, session));
  });
}

export type AnswerPatch = Partial<Pick<Answer, 'score' | 'coveredKeyPoints' | 'redFlagsSeen' | 'probeHandled' | 'flagged' | 'notes'>>;

/** RES-1 autosave of any answer fields. Setting a score on a skipped question unskips it. */
export async function updateAnswer(sessionId: string, questionId: string, patch: AnswerPatch): Promise<void> {
  await mutateAnswer(sessionId, questionId, (a) => {
    const next = { ...a, ...patch };
    if (patch.score != null) Object.assign(next, { skipped: false, skipReason: null });
    return next;
  });
}

/** FLOW-14: the interviewer chooses the score (null clears it). */
export const setScore = (sessionId: string, questionId: string, score: Score | null) => updateAnswer(sessionId, questionId, { score });

const toggleIn = (xs: number[], i: number) => (xs.includes(i) ? xs.filter((x) => x !== i) : [...xs, i].sort((a, b) => a - b));

/** FLOW-13 */
export const toggleKeyPoint = (sessionId: string, questionId: string, index: number) =>
  mutateAnswer(sessionId, questionId, (a) => ({ ...a, coveredKeyPoints: toggleIn(a.coveredKeyPoints, index) }));
/** FLOW-13 */
export const toggleRedFlag = (sessionId: string, questionId: string, index: number) =>
  mutateAnswer(sessionId, questionId, (a) => ({ ...a, redFlagsSeen: toggleIn(a.redFlagsSeen, index) }));
/** FLOW-13 */
export const setProbeHandled = (sessionId: string, questionId: string, probeHandled: boolean) => updateAnswer(sessionId, questionId, { probeHandled });

/** FLOW-18 */
export const toggleFlag = (sessionId: string, questionId: string) => mutateAnswer(sessionId, questionId, (a) => ({ ...a, flagged: !a.flagged }));

/** FLOW-17: a reason is required; a skipped question has no score. */
export async function skipQuestion(sessionId: string, questionId: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new RepoError('reason-required', 'Give a reason for skipping this question.');
  await mutateAnswer(sessionId, questionId, (a) => ({ ...a, skipped: true, skipReason: reason.trim(), score: null }));
}

/**
 * FLOW-17, UX-6: skips every question that is neither scored nor skipped, with one reason, in one
 * transaction (all or nothing). Scored and already skipped questions are left as they are. Each skip
 * can still be undone one by one before submitting. Returns the ids of the questions skipped, in
 * interview order.
 */
export async function skipRemaining(sessionId: string, reason: string): Promise<string[]> {
  if (!reason.trim()) throw new RepoError('reason-required', 'Give a reason for skipping these questions.');
  return db.transaction('rw', T(), async () => {
    const { session, plan } = await load(sessionId);
    assertEditable(session);
    const skipped: string[] = [];
    for (const q of plan.questions) {
      const a = await getAnswer(sessionId, q.id, plan);
      if (a.skipped || a.score != null) continue;
      await db.answers.put({ ...a, skipped: true, skipReason: reason.trim(), score: null });
      skipped.push(q.id);
    }
    return skipped;
  });
}

/** FLOW-17: undo a skip before finishing. */
export const unskipQuestion = (sessionId: string, questionId: string) =>
  mutateAnswer(sessionId, questionId, (a) => ({ ...a, skipped: false, skipReason: null }));

/** Session elapsed time in whole seconds at `now`. */
export function sessionElapsedSec(session: Pick<Session, 'timer'>, now = clock.now()): number {
  return elapsedSec(session.timer, now);
}

/** PANEL-3: the note's author, checked against the session's interviewers; undefined when not given. */
function noteAuthor(session: Session, by: string | null | undefined): string | undefined {
  if (by == null || by === '') return undefined;
  const match = interviewersOf(session).find((n) => nameKey(n) === nameKey(by));
  if (!match) throw new RepoError('invalid', 'That name is not one of this interview’s interviewers.');
  return match;
}

function note(atSec: number, text: string, by: string | undefined): NoteEntry {
  return by ? { atSec, text, by } : { atSec, text };
}

/** FLOW-15: adds a note stamped with the elapsed interview time; PANEL-3: optionally marked with who made it. */
export async function addNote(sessionId: string, questionId: string, text: string, by?: string | null): Promise<void> {
  if (!text.trim()) return;
  await mutateAnswer(sessionId, questionId, (a, session) => ({
    ...a,
    notes: [...a.notes, note(Math.floor(elapsedMs(session.timer, clock.now()) / 1000), text.trim(), noteAuthor(session, by))],
  }));
}

/**
 * FLOW-15, RES-1 (additive): like addNote, but returns the new entry's index (or null for empty text)
 * so a note can be saved while it is still being typed and then updated with editNote.
 */
export async function addNoteEntry(sessionId: string, questionId: string, text: string, by?: string | null): Promise<number | null> {
  if (!text.trim()) return null;
  let index: number | null = null;
  await mutateAnswer(sessionId, questionId, (a, session) => {
    index = a.notes.length;
    return { ...a, notes: [...a.notes, note(Math.floor(elapsedMs(session.timer, clock.now()) / 1000), text, noteAuthor(session, by))] };
  });
  return index;
}

/** FLOW-15: changes a note's text; PANEL-3: `by` changes who made it (null clears it, undefined keeps it). */
export const editNote = (sessionId: string, questionId: string, index: number, text: string, by?: string | null) =>
  mutateAnswer(sessionId, questionId, (a, session) => ({
    ...a,
    notes: a.notes.map((n, i) => (i !== index ? n : by === undefined ? { ...n, text } : note(n.atSec, text, noteAuthor(session, by)))),
  }));

export const deleteNote = (sessionId: string, questionId: string, index: number) =>
  mutateAnswer(sessionId, questionId, (a) => ({ ...a, notes: a.notes.filter((_, i) => i !== index) }));

/**
 * PANEL-1: adds an interviewer to the shared record in the live interview, until it is submitted.
 * Names must differ. Audited (AUD-2).
 */
export async function addInterviewer(sessionId: string, name: string): Promise<void> {
  await db.transaction('rw', T(), async () => {
    const { session } = await load(sessionId);
    assertEditable(session);
    const current = interviewersOf(session);
    const problem = interviewerNameProblems([...current, name]).at(-1);
    if (problem) throw new RepoError('invalid', problem);
    const interviewers = [...current, cleanName(name)];
    await db.sessions.put({ ...session, interviewers });
    await appendAudit({ action: 'session.interviewer_added', entity: 'session', entityId: sessionId, before: { interviewers: current }, after: { interviewers } });
  });
}

/**
 * PANEL-1: removes an interviewer from the shared record until it is submitted. At least one
 * interviewer remains; if the first is removed, the next becomes `interviewer.name`. Notes they
 * made keep their name. Audited (AUD-2).
 */
export async function removeInterviewer(sessionId: string, name: string): Promise<void> {
  await db.transaction('rw', T(), async () => {
    const { session } = await load(sessionId);
    assertEditable(session);
    const current = interviewersOf(session);
    const interviewers = current.filter((n) => nameKey(n) !== nameKey(name));
    if (interviewers.length === current.length) throw new RepoError('not-found', 'That name is not one of this interview’s interviewers.');
    if (!interviewers.length) throw new RepoError('last-interviewer', 'An interview needs at least one interviewer.');
    await db.sessions.put({ ...session, interviewers, interviewer: { name: interviewers[0] } });
    await appendAudit({ action: 'session.interviewer_removed', entity: 'session', entityId: sessionId, before: { interviewers: current }, after: { interviewers } });
  });
}

/** FLOW-22: autosave the overall rating, recommendation and rationale before finishing. */
export async function setOverall(sessionId: string, patch: Partial<OverallAssessment>): Promise<void> {
  await db.transaction('rw', T(), async () => {
    const { session } = await load(sessionId);
    assertEditable(session);
    await db.sessions.put({ ...session, overall: { ...session.overall, ...patch } });
  });
}

/** FLOW-16, FLOW-22, FLOW-23: submits and locks the record. Throws with the blocking problems. */
export async function submitSession(sessionId: string): Promise<void> {
  await db.transaction('rw', T(), async () => {
    const { session, plan } = await load(sessionId);
    assertEditable(session);
    const answers = await db.answers.where('sessionId').equals(sessionId).toArray();
    const problems = canFinish(plan, answers, session.overall);
    if (problems.length) throw new RepoError('cannot-finish', 'The interview cannot be finished yet.', problems.map((p) => p.message));
    const now = clock.now();
    await db.answers.bulkPut(answers.map((a) => stopAnswerTimer(a, now)));
    await db.sessions.put({ ...session, state: 'submitted', submittedAt: nowIso(), timer: pauseTimer(session.timer, now) });
    await appendAudit({ action: 'session.submitted', entity: 'session', entityId: sessionId, actorFallback: session.interviewer.name });
  });
}

export type AmendAnswerPatch = Partial<Pick<Answer, 'score' | 'notes' | 'skipped' | 'skipReason' | 'coveredKeyPoints' | 'redFlagsSeen' | 'probeHandled' | 'flagged'>>;

function changed<T extends object>(before: T, patch: Partial<T>): { before: Partial<T>; after: Partial<T> } {
  const b: Partial<T> = {};
  const a: Partial<T> = {};
  for (const k of Object.keys(patch) as (keyof T)[]) {
    if (JSON.stringify(before[k]) !== JSON.stringify(patch[k])) {
      b[k] = before[k];
      a[k] = patch[k];
    }
  }
  return { before: b, after: a };
}

async function loadSubmittedLocal(sessionId: string, reason: string) {
  if (!reason.trim()) throw new RepoError('reason-required', 'Give a reason for changing a submitted interview.');
  const loaded = await load(sessionId);
  if (loaded.session.origin !== 'local') throw new RepoError('read-only', 'Imported panelist sessions are read-only.');
  if (loaded.session.state !== 'submitted') throw new RepoError('invalid-state', 'Only submitted interviews are amended; edit this one directly.');
  return loaded;
}

/**
 * AUD-4, FLOW-23: change a submitted answer. Requires a reason; writes before/after to the audit
 * log. The amended record must still satisfy the finish rules (FLOW-16, FLOW-22).
 */
export async function amendAnswer(sessionId: string, questionId: string, patch: AmendAnswerPatch, reason: string): Promise<void> {
  await db.transaction('rw', T(), async () => {
    const { session, plan } = await loadSubmittedLocal(sessionId, reason);
    const a = await getAnswer(sessionId, questionId, plan);
    const next: Answer = { ...a, ...patch };
    if (patch.score != null && patch.skipped === undefined) Object.assign(next, { skipped: false, skipReason: null });
    if (next.skipped) next.score = null;
    const diff = changed(a, next);
    if (!Object.keys(diff.after).length) return;
    const answers = (await db.answers.where('sessionId').equals(sessionId).toArray()).map((x) => (x.questionId === questionId ? next : x));
    const problems = canFinish(plan, answers, session.overall);
    if (problems.length) throw new RepoError('cannot-finish', 'That change would leave the record incomplete.', problems.map((p) => p.message));
    await db.answers.put(next);
    await appendAudit({
      action: 'session.amended',
      entity: 'answer',
      entityId: sessionId,
      before: { questionId, ...diff.before },
      after: { questionId, ...diff.after },
      reason: reason.trim(),
      actorFallback: session.interviewer.name,
    });
  });
}

/** AUD-4: change the overall rating, recommendation or rationale of a submitted interview. */
export async function amendOverall(sessionId: string, patch: Partial<OverallAssessment>, reason: string): Promise<void> {
  await db.transaction('rw', T(), async () => {
    const { session, plan } = await loadSubmittedLocal(sessionId, reason);
    const overall = { ...session.overall, ...patch };
    const diff = changed(session.overall, overall);
    if (!Object.keys(diff.after).length) return;
    const answers = await db.answers.where('sessionId').equals(sessionId).toArray();
    const problems = canFinish(plan, answers, overall);
    if (problems.length) throw new RepoError('cannot-finish', 'That change would leave the record incomplete.', problems.map((p) => p.message));
    await db.sessions.put({ ...session, overall });
    await appendAudit({
      action: 'session.amended',
      entity: 'session',
      entityId: sessionId,
      before: diff.before,
      after: diff.after,
      reason: reason.trim(),
      actorFallback: session.interviewer.name,
    });
  });
}

/** Deletes a session that has not been submitted (e.g. created by mistake). Not audited: no AUD-2 action covers it. */
export async function deleteDraftSession(sessionId: string): Promise<void> {
  await db.transaction('rw', [...T(), db.transcripts, db.recordings, db.aiResults, db.plannedInterviews], async () => {
    const { session } = await load(sessionId);
    if (session.state === 'submitted') throw new RepoError('submitted', 'Submitted interviews can only be removed by a deletion request or retention purge.');
    await db.answers.where('sessionId').equals(sessionId).delete();
    await db.sessions.delete(sessionId);
    // TEAM-1: a planned interview goes with its record.
    await db.plannedInterviews.where('sessionId').equals(sessionId).delete();
    // TR-3: anything attached goes with the record.
    await Promise.all([db.transcripts.delete(sessionId), db.recordings.delete(sessionId), db.aiResults.delete(sessionId)]);
  });
}
