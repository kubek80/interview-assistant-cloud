// Finish checks (FLOW-16, FLOW-22) and import validators (SEC-2, BANK-7). Pure.
import compiledTrackSchema from './generated/trackSchemaValidator';
import { MAX_CANDIDATE, candidateKey, cleanCandidate, isValidCandidate, planFingerprint } from './plan';
import { MAX_INTERVIEWERS, interviewerNameProblems } from './interviewers';
import { MAX_EXPECTED, MAX_NOTE, isDay, isTimeOfDay } from './team';
import type {
  Answer,
  Category,
  InterviewPlan,
  InvitationFile,
  OverallAssessment,
  PanelFile,
  PlanFile,
  Question,
  SessionFile,
  TrackFile,
} from './types';
import { DIFFICULTIES, QUESTION_TYPES, RECOMMENDATIONS } from './types';

export type FinishProblemCode = 'unresolved' | 'note-required' | 'overall-rating' | 'recommendation' | 'rationale';

export interface FinishProblem {
  code: FinishProblemCode;
  questionId?: string;
  message: string;
}

export function hasNote(answer: Pick<Answer, 'notes'> | undefined): boolean {
  return !!answer?.notes.some((n) => n.text.trim().length > 0);
}

/** FLOW-16 / RUB-4: a score of 1 or 4 needs a note. */
export function needsNote(answer: Pick<Answer, 'score' | 'skipped' | 'notes'> | undefined): boolean {
  return !!answer && !answer.skipped && (answer.score === 1 || answer.score === 4) && !hasNote(answer);
}

/** FLOW-16, FLOW-22: returns every problem that blocks finishing; empty means the session can be submitted. */
export function canFinish(
  plan: Pick<InterviewPlan, 'questions'>,
  answers: readonly Answer[],
  overall: OverallAssessment,
): FinishProblem[] {
  const problems: FinishProblem[] = [];
  const byQ = new Map(answers.map((a) => [a.questionId, a]));
  plan.questions.forEach((q, i) => {
    const a = byQ.get(q.id);
    const label = `Question ${i + 1}`;
    if (!a || (!a.skipped && a.score == null)) {
      problems.push({ code: 'unresolved', questionId: q.id, message: `${label} is neither scored nor skipped.` });
    } else if (needsNote(a)) {
      problems.push({ code: 'note-required', questionId: q.id, message: `${label} is scored ${a.score} and needs a note of what the candidate said.` });
    }
  });
  if (overall.rating == null) problems.push({ code: 'overall-rating', message: 'Give an overall rating (1-4).' });
  if (overall.recommendation == null) problems.push({ code: 'recommendation', message: 'Choose a recommendation.' });
  if (!overall.rationale.trim()) problems.push({ code: 'rationale', message: 'Write a rationale for your recommendation.' });
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Import validation. Ajv's runtime compiler needs `eval`, which the CSP forbids, so imports are
// checked by the hand-rolled validators below; track files are additionally checked against
// schema/track.schema.json through a validator generated at build time (when the schema exists).

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

type Check = (v: unknown, path: string, errors: string[]) => void;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const push = (errors: string[], path: string, msg: string) => {
  if (errors.length < 50) errors.push(`${path || '(root)'} ${msg}`);
};

const str = (opts: { min?: number; max?: number; pattern?: RegExp } = {}): Check => (v, p, e) => {
  if (typeof v !== 'string') return push(e, p, 'must be a string');
  if (opts.min != null && v.length < opts.min) push(e, p, `must be at least ${opts.min} characters`);
  if (opts.max != null && v.length > opts.max) push(e, p, `must be at most ${opts.max} characters`);
  if (opts.pattern && !opts.pattern.test(v)) push(e, p, 'has an invalid format');
};
const num = (opts: { min?: number; max?: number; int?: boolean } = {}): Check => (v, p, e) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return push(e, p, 'must be a number');
  if (opts.int && !Number.isInteger(v)) push(e, p, 'must be an integer');
  if (opts.min != null && v < opts.min) push(e, p, `must be ≥ ${opts.min}`);
  if (opts.max != null && v > opts.max) push(e, p, `must be ≤ ${opts.max}`);
};
const bool: Check = (v, p, e) => {
  if (typeof v !== 'boolean') push(e, p, 'must be true or false');
};
const oneOf = (values: readonly unknown[]): Check => (v, p, e) => {
  if (!values.includes(v)) push(e, p, `must be one of ${values.map((x) => JSON.stringify(x)).join(', ')}`);
};
const nullable = (c: Check): Check => (v, p, e) => {
  if (v !== null) c(v, p, e);
};
const optional = (c: Check): Check => (v, p, e) => {
  if (v !== undefined) c(v, p, e);
};
const arr = (item: Check, opts: { min?: number; max?: number } = {}): Check => (v, p, e) => {
  if (!Array.isArray(v)) return push(e, p, 'must be an array');
  if (opts.min != null && v.length < opts.min) push(e, p, `must have at least ${opts.min} items`);
  if (opts.max != null && v.length > opts.max) push(e, p, `must have at most ${opts.max} items`);
  v.forEach((x, i) => item(x, `${p}[${i}]`, e));
};
const obj = (shape: Record<string, Check>): Check => (v, p, e) => {
  if (!isObj(v)) return push(e, p, 'must be an object');
  for (const [k, c] of Object.entries(shape)) c(v[k], p ? `${p}.${k}` : k, e);
};
/** PRIV-1: the candidate's name or initials. */
const candidateName: Check = (v, p, e) => {
  if (!isValidCandidate(v)) push(e, p, `must be a name or initials (1 to ${MAX_CANDIDATE} letters, spaces, hyphens, apostrophes or full stops)`);
};
const isoTs = str({ pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/ });
const isoDay = str({ pattern: /^\d{4}-\d{2}-\d{2}$/ });
const id = str({ min: 1, max: 200 });
const text = (max = 20_000) => str({ max });
const score = oneOf([1, 2, 3, 4]);
const timer = obj({ accumulatedMs: num({ min: 0 }), runningSince: nullable(num({ min: 0 })) });
const rubricOverride = nullable(obj({ '1': optional(text()), '2': optional(text()), '3': optional(text()), '4': optional(text()) }));

const questionShape = {
  id,
  categoryId: id,
  number: num({ int: true, min: 1 }),
  text: text(),
  // Plan snapshots and plan/session files made before descriptions existed have none (BANK-8).
  description: optional(text()),
  difficulty: oneOf(DIFFICULTIES),
  type: oneOf(QUESTION_TYPES),
  lookFor: arr(text(2000)),
  redFlags: arr(text(2000)),
  probes: arr(text(2000)),
  timeMin: num({ min: 0, max: 600 }),
  version: num({ int: true, min: 1 }),
  status: oneOf(['active', 'retired']),
  rubricOverride,
};
const categoryShape = { id, name: str({ min: 1, max: 200 }), weight: num({ min: 0, max: 100 }), mustHave: bool };
const trackShape = obj({ id, name: str({ min: 1, max: 300 }), version: str({ min: 1, max: 50 }) });

const planCheck = obj({
  id,
  trackId: id,
  trackVersion: str({ max: 50 }),
  name: str({ max: 300 }),
  questions: arr(obj({ ...questionShape, trackId: id }), { max: 500 }),
  categories: arr(obj({ ...categoryShape, trackId: id }), { max: 200 }),
  timeBudgetMin: num({ min: 0, max: 24 * 60 }),
  locked: bool,
  lockedAt: nullable(isoTs),
  fingerprint: nullable(str({ pattern: /^[0-9a-f]{64}$/ })),
  createdAt: isoTs,
});

const sessionShape = {
  id,
  planId: id,
  candidate: obj({
    initials: candidateName,
    requisitionId: nullable(str({ max: 100 })),
    consentAt: isoTs,
    retentionUntil: isoDay,
    // TR-4: absent on files made before transcripts could be attached.
    recordingConsent: optional(obj({ at: isoTs, source: oneOf(['setup', 'later']) })),
    recordingNotice: optional(bool),
  }),
  interviewer: obj({ name: str({ min: 1, max: 200 }) }),
  // DATA-5: absent in files made before several interviewers could share a record.
  interviewers: optional(arr(str({ min: 1, max: 200 }), { min: 1, max: MAX_INTERVIEWERS })),
  state: oneOf(['planned', 'in_progress', 'paused', 'submitted']),
  currentQuestionId: nullable(id),
  timer,
  overall: obj({ rating: nullable(score), recommendation: nullable(oneOf(RECOMMENDATIONS)), rationale: text() }),
  createdAt: isoTs,
  startedAt: nullable(isoTs),
  submittedAt: nullable(isoTs),
  origin: oneOf(['local', 'imported']),
  // TEAM-5: absent on records that were not planned with an invitation.
  invitationId: optional(str({ min: 1, max: 100, pattern: /^[A-Za-z0-9-]+$/ })),
};
const sessionCheck = obj(sessionShape);

const answerCheck = obj({
  sessionId: id,
  questionId: id,
  score: nullable(score),
  coveredKeyPoints: arr(num({ int: true, min: 0 })),
  redFlagsSeen: arr(num({ int: true, min: 0 })),
  probeHandled: bool,
  notes: arr(obj({ atSec: num({ min: 0 }), text: text(), by: optional(str({ min: 1, max: 200 })) }), { max: 500 }),
  flagged: bool,
  skipped: bool,
  skipReason: nullable(text(2000)),
  elapsedSec: num({ min: 0 }),
  timer: optional(timer),
});

function run<T>(check: Check, value: unknown, extra?: (v: T, errors: string[]) => void): ValidationResult<T> {
  const errors: string[] = [];
  check(value, '', errors);
  if (!errors.length && extra) extra(value as T, errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: value as T };
}

function checkPlanConsistency(plan: InterviewPlan, errors: string[], path = 'plan') {
  const catIds = new Set(plan.categories.map((c) => c.id));
  const qIds = new Set<string>();
  for (const q of plan.questions) {
    if (qIds.has(q.id)) errors.push(`${path}.questions has duplicate id ${q.id}`);
    qIds.add(q.id);
    if (!catIds.has(q.categoryId)) errors.push(`${path}.questions ${q.id} refers to unknown category ${q.categoryId}`);
    if (q.trackId !== plan.trackId) errors.push(`${path}.questions ${q.id} belongs to another track`);
  }
  if (!plan.locked || !plan.fingerprint) errors.push(`${path} is not locked`);
  else if (planFingerprint(plan) !== plan.fingerprint) errors.push(`${path}.fingerprint does not match the plan contents`);
}

function envelope(kind: string, value: unknown, errors: string[]): boolean {
  if (!isObj(value)) {
    errors.push('The file is not a JSON object.');
    return false;
  }
  if (value.kind !== kind) {
    errors.push(`Expected a file of kind "${kind}" but found ${JSON.stringify(value.kind ?? null)}.`);
    return false;
  }
  if (value.formatVersion !== 1) {
    errors.push(`Unsupported formatVersion ${JSON.stringify(value.formatVersion ?? null)}.`);
    return false;
  }
  return true;
}

/** SEC-2: validates an exported plan file (DATA-4). Only locked plans with a matching fingerprint pass. */
export function validatePlanFile(value: unknown): ValidationResult<PlanFile> {
  const errors: string[] = [];
  if (!envelope('interview-plan', value, errors)) return { ok: false, errors };
  return run<PlanFile>(obj({ exportedAt: isoTs, plan: planCheck }), value, (v, e) => checkPlanConsistency(v.plan, e));
}

/** SEC-2, FLOW-27: validates a session file; only submitted sessions are accepted. */
export function validateSessionFile(value: unknown): ValidationResult<SessionFile> {
  const errors: string[] = [];
  if (!envelope('interview-session', value, errors)) return { ok: false, errors };
  return run<SessionFile>(
    obj({ exportedAt: isoTs, plan: planCheck, session: sessionCheck, answers: arr(answerCheck, { max: 500 }) }),
    value,
    (v, e) => {
      checkPlanConsistency(v.plan, e);
      checkRecord(v.plan, v.session, v.answers, e, 'session');
    },
  );
}

/** FLOW-26, TEAM-13: a submitted record and its answers fit the plan they claim. */
function checkRecord(plan: InterviewPlan, session: SessionFile['session'], answers: readonly Answer[], e: string[], path: string) {
  if (session.planId !== plan.id) e.push(`${path}.planId does not match the embedded plan`);
  if (session.state !== 'submitted' || !session.submittedAt) e.push('Only submitted interviews can be imported.');
  if (session.interviewers) {
    if (interviewerNameProblems(session.interviewers).some(Boolean)) e.push(`${path}.interviewers must be different, non-empty names`);
    if (session.interviewers[0] !== session.interviewer.name) e.push(`${path}.interviewers must start with ${path}.interviewer.name`);
  }
  const byId = new Map(plan.questions.map((q) => [q.id, q]));
  const seen = new Set<string>();
  for (const a of answers) {
    if (a.sessionId !== session.id) e.push(`answer for ${a.questionId} belongs to another session`);
    const q = byId.get(a.questionId);
    if (!q) e.push(`answer refers to unknown question ${a.questionId}`);
    else {
      // Tick indexes must point into the question's own lists (otherwise "5 of 4 key points").
      if (a.coveredKeyPoints.some((i) => i >= q.lookFor.length)) e.push(`answer for ${a.questionId} ticks a key point that does not exist`);
      if (a.redFlagsSeen.some((i) => i >= q.redFlags.length)) e.push(`answer for ${a.questionId} ticks a red flag that does not exist`);
      if (a.skipped && a.score != null) e.push(`answer for ${a.questionId} is both skipped and scored`);
    }
    // PANEL-3: a note's author is one of the session's interviewers.
    const names = session.interviewers ?? [session.interviewer.name];
    if (a.notes.some((n) => n.by !== undefined && !names.includes(n.by))) e.push(`answer for ${a.questionId} has a note by someone who is not one of the interviewers`);
    if (seen.has(a.questionId)) e.push(`duplicate answer for ${a.questionId}`);
    seen.add(a.questionId);
  }
}

// ---------------------------------------------------------------------------------------------
// TEAM-13: panel files

/** The most panels one panel file may carry, and judgements per panel. */
export const MAX_PANELS_PER_FILE = 200;
export const MAX_JUDGEMENTS_PER_PANEL = 50;

const nameStr = str({ min: 1, max: 200 });
/** A record in a panel file: like an interview file's, but it may be one entered by hand (TEAM-8, no consent here). */
const panelSessionCheck = obj({
  ...sessionShape,
  candidate: obj({
    initials: candidateName,
    requisitionId: nullable(str({ max: 100 })),
    consentAt: nullable(isoTs),
    retentionUntil: isoDay,
    recordingConsent: optional(obj({ at: isoTs, source: oneOf(['setup', 'later']) })),
    recordingNotice: optional(bool),
  }),
  origin: oneOf(['local', 'imported', 'entered']),
  enteredBy: optional(nameStr),
  enteredAt: optional(isoTs),
});
const scoresMap: Check = (v, p, e) => {
  if (!isObj(v)) return push(e, p, 'must be an object');
  if (Object.keys(v).length > 500) push(e, p, 'has too many entries');
  for (const [k, x] of Object.entries(v)) {
    id(k, `${p} key`, e);
    score(x, `${p}.${k}`, e);
  }
};
const decisionCheck = obj({
  recommendation: oneOf(RECOMMENDATIONS),
  rationale: str({ min: 1, max: 5000 }),
  participants: arr(nameStr, { min: 1, max: 2 * MAX_INTERVIEWERS }),
  rating: nullable(score),
  scores: scoresMap,
  recordedBy: nameStr,
  recordedAt: isoTs,
  changedBy: optional(nameStr),
  changedAt: optional(isoTs),
});
const summaryCheck = obj({ text: str({ max: 10_000 }), updatedBy: nameStr, updatedAt: isoTs });
const sharedAiCheck = obj({
  model: str({ min: 1, max: 200 }),
  createdAt: isoTs,
  questions: arr(obj({ questionId: id, covered: bool, score: nullable(score), rationale: optional(text(2000)) }), { max: 500 }),
});
const sharedCheck = obj({
  sessionId: id,
  interviewers: arr(nameStr, { max: 2 * MAX_INTERVIEWERS }),
  transcript: optional(obj({ format: str({ max: 20 }), text: str({ max: 500_000 }), speakers: arr(str({ max: 200 }), { max: 50 }) })),
  aiSecondOpinion: optional(sharedAiCheck),
});
const panelEntryCheck = obj({
  plan: planCheck,
  candidate: obj({ initials: candidateName, requisitionId: nullable(str({ max: 100 })) }),
  retentionUntil: isoDay,
  expected: arr(nameStr, { max: MAX_EXPECTED }),
  date: nullable(str({ pattern: /^\d{4}-\d{2}-\d{2}$/ })),
  time: nullable(str({ pattern: /^\d{2}:\d{2}$/ })),
  judgements: arr(obj({ session: panelSessionCheck, answers: arr(answerCheck, { max: 500 }) }), { max: MAX_JUDGEMENTS_PER_PANEL }),
  decision: nullable(decisionCheck),
  summary: nullable(summaryCheck),
  shared: optional(arr(sharedCheck, { max: MAX_JUDGEMENTS_PER_PANEL })),
});

/**
 * TEAM-13, SEC-2: validates a panel file. Every plan must be locked with a matching fingerprint;
 * every record must be submitted, belong to that plan and to the panel's candidate; agreed scores
 * must name the plan's questions. Unknown fields are ignored (the importer copies documented ones).
 */
export function validatePanelFile(value: unknown): ValidationResult<PanelFile> {
  const errors: string[] = [];
  if (!envelope('interview-panel', value, errors)) return { ok: false, errors };
  return run<PanelFile>(obj({ exportedAt: isoTs, exportedBy: nameStr, panels: arr(panelEntryCheck, { min: 1, max: MAX_PANELS_PER_FILE }) }), value, (v, e) => {
    const keys = new Set<string>();
    v.panels.forEach((p, i) => {
      const path = `panels[${i}]`;
      checkPlanConsistency(p.plan, e, `${path}.plan`);
      const key = `${candidateKey(p.candidate)}#${p.plan.fingerprint}`;
      if (keys.has(key)) e.push(`${path} repeats a panel already in the file`);
      keys.add(key);
      if (p.date !== null && !isDay(p.date)) e.push(`${path}.date is not a real day`);
      if (p.time !== null && !isTimeOfDay(p.time)) e.push(`${path}.time is not a time of day`);
      if (interviewerNameProblems(p.expected).some(Boolean)) e.push(`${path}.expected must be different, non-empty names`);
      const ids = new Set<string>();
      p.judgements.forEach((j, k) => {
        const jp = `${path}.judgements[${k}].session`;
        checkRecord(p.plan, j.session, j.answers, e, jp);
        if (candidateKey(j.session.candidate) !== candidateKey(p.candidate)) e.push(`${jp} is for a different candidate`);
        if (ids.has(j.session.id)) e.push(`${jp}.id is repeated`);
        ids.add(j.session.id);
        if (j.session.origin === 'entered' && (!j.session.enteredBy || !j.session.enteredAt)) e.push(`${jp} is entered by hand but does not say by whom and when`);
      });
      const qIds = new Set(p.plan.questions.map((q) => q.id));
      if (p.decision && Object.keys(p.decision.scores).some((q) => !qIds.has(q))) e.push(`${path}.decision.scores names a question that is not in the plan`);
      for (const s of p.shared ?? []) if (s.aiSecondOpinion?.questions.some((q) => !qIds.has(q.questionId))) e.push(`${path}.shared names a question that is not in the plan`);
    });
  });
}

const invitationEntryCheck = obj({
  invitationId: str({ min: 1, max: 100, pattern: /^[A-Za-z0-9-]+$/ }),
  createdAt: isoTs,
  updatedAt: isoTs,
  organiser: str({ min: 1, max: 200 }),
  // PRIV-1, TEAM-14: initials and requisition id only.
  candidate: obj({ initials: candidateName, requisitionId: nullable(str({ max: 100 })) }),
  date: nullable(str({ pattern: /^\d{4}-\d{2}-\d{2}$/ })),
  time: nullable(str({ pattern: /^\d{2}:\d{2}$/ })),
  expectedInterviewers: arr(str({ min: 1, max: 200 }), { max: MAX_EXPECTED }),
  recordingNotice: bool,
  note: str({ max: MAX_NOTE }),
  retentionUntil: isoDay,
  plan: planCheck,
});

/** The most interviews one invitation file may carry. */
export const MAX_INVITATIONS_PER_FILE = 50;

/**
 * TEAM-3, TEAM-4, SEC-2: validates an invitation file. Every embedded plan must be locked with a
 * fingerprint that matches its contents; ids, dates, times and names are checked; sizes are
 * bounded. Unknown fields are ignored (the importer copies only the documented ones).
 */
export function validateInvitationFile(value: unknown): ValidationResult<InvitationFile> {
  const errors: string[] = [];
  if (!envelope('interview-invitation', value, errors)) return { ok: false, errors };
  return run<InvitationFile>(obj({ exportedAt: isoTs, interviews: arr(invitationEntryCheck, { min: 1, max: MAX_INVITATIONS_PER_FILE }) }), value, (v, e) => {
    const ids = new Set<string>();
    v.interviews.forEach((it, i) => {
      const path = `interviews[${i}]`;
      if (ids.has(it.invitationId)) e.push(`${path}.invitationId is repeated in the file`);
      ids.add(it.invitationId);
      if (it.date !== null && !isDay(it.date)) e.push(`${path}.date is not a real day`);
      if (it.time !== null && !isTimeOfDay(it.time)) e.push(`${path}.time is not a time of day`);
      if (it.time !== null && it.date === null) e.push(`${path}.time is given without a date`);
      if (interviewerNameProblems(it.expectedInterviewers).some(Boolean)) e.push(`${path}.expectedInterviewers must be different, non-empty names`);
      checkPlanConsistency(it.plan, e, `${path}.plan`);
    });
  });
}

/**
 * BANK-7, SEC-2: validates a track file (seed shape). Uses the build-time compiled JSON Schema
 * when schema/track.schema.json exists, plus structural and referential checks.
 */
export function validateTrackFile(value: unknown): ValidationResult<TrackFile> {
  const errors: string[] = [];
  if (compiledTrackSchema && !compiledTrackSchema(value)) {
    for (const err of compiledTrackSchema.errors ?? []) push(errors, err.instancePath, err.message ?? 'is invalid');
  }
  const result = run<TrackFile>(
    obj({
      track: trackShape,
      categories: arr(obj({ ...categoryShape, trackId: optional(id) }), { min: 1, max: 200 }),
      // BANK-1: every question in a track file has a description.
      questions: arr(obj({ ...questionShape, description: str({ min: 1, max: 20_000 }), trackId: optional(id) }), { min: 1, max: 1000 }),
    }),
    value,
    (v, e) => {
      const catIds = new Set<string>();
      for (const c of v.categories) {
        if (catIds.has(c.id)) e.push(`duplicate category id ${c.id}`);
        catIds.add(c.id);
        if (c.trackId && c.trackId !== v.track.id) e.push(`category ${c.id} belongs to another track`);
      }
      const qIds = new Set<string>();
      const numbers = new Set<number>();
      for (const q of v.questions) {
        if (qIds.has(q.id)) e.push(`duplicate question id ${q.id}`);
        if (numbers.has(q.number)) e.push(`duplicate question number ${q.number}`);
        qIds.add(q.id);
        numbers.add(q.number);
        if (!catIds.has(q.categoryId)) e.push(`question ${q.id} refers to unknown category ${q.categoryId}`);
        if (q.trackId && q.trackId !== v.track.id) e.push(`question ${q.id} belongs to another track`);
        if (q.probes.length < 1) e.push(`question ${q.id} needs at least one probe`);
        if (!q.description.trim()) e.push(`question ${q.id} needs a description`);
      }
    },
  );
  if (!result.ok) return { ok: false, errors: [...errors, ...result.errors] };
  return errors.length ? { ok: false, errors } : result;
}

/** Normalises a validated track file into database rows. */
export function trackFileRows(file: TrackFile): { categories: Category[]; questions: Question[] } {
  const trackId = file.track.id;
  return {
    categories: file.categories.map((c) => ({ id: c.id, trackId, name: c.name, weight: c.weight, mustHave: c.mustHave })),
    questions: file.questions.map((q) => ({
      id: q.id,
      trackId,
      categoryId: q.categoryId,
      number: q.number,
      text: q.text,
      description: q.description,
      difficulty: q.difficulty,
      type: q.type,
      lookFor: [...q.lookFor],
      redFlags: [...q.redFlags],
      probes: [...q.probes],
      timeMin: q.timeMin,
      version: q.version,
      status: q.status,
      rubricOverride: q.rubricOverride ?? null,
    })),
  };
}

export interface CandidateInput {
  initials: string;
  requisitionId?: string | null;
  /** FLOW-7: this device's interviewer, the first of the interviewers (PANEL-1). */
  interviewerName: string;
  /** PANEL-1: more interviewers running the interview together at this machine. */
  otherInterviewers?: string[];
  retentionUntil: string;
  /**
   * TR-4: "This interview will be recorded or transcribed". When true, the consent text on the
   * ready screen includes RECORDING_CONSENT_TEXT and the confirmation covers it (stored as
   * candidate.recordingConsent when consent is confirmed). Consent itself is confirmed on the
   * ready screen (FLOW-7, PRIV-4), not here.
   */
  recordingNotice?: boolean;
}

/** FLOW-7, PRIV-1: field errors keyed by field name; empty object means valid. */
export function validateCandidateInput(input: CandidateInput, today: string): Partial<Record<keyof CandidateInput, string>> {
  const errors: Partial<Record<keyof CandidateInput, string>> = {};
  if (!input.initials.trim()) errors.initials = 'Enter the candidate’s name or initials.';
  else if (cleanCandidate(input.initials).length > MAX_CANDIDATE) errors.initials = `Use at most ${MAX_CANDIDATE} characters.`;
  else if (!isValidCandidate(input.initials)) errors.initials = 'Use letters, spaces, hyphens, apostrophes and full stops only.';
  if ((input.requisitionId ?? '').length > 100) errors.requisitionId = 'Requisition id is too long.';
  if (!input.interviewerName.trim()) errors.interviewerName = 'Enter the interviewer name.';
  const others = input.otherInterviewers ?? [];
  if (others.length >= MAX_INTERVIEWERS) errors.otherInterviewers = `At most ${MAX_INTERVIEWERS} interviewers.`;
  else if (others.length) {
    const problems = interviewerNameProblems([input.interviewerName, ...others]).slice(1);
    const i = problems.findIndex(Boolean);
    if (i >= 0) errors.otherInterviewers = `Interviewer ${i + 2}: ${problems[i]}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.retentionUntil)) errors.retentionUntil = 'Enter a retention date.';
  else if (input.retentionUntil < today) errors.retentionUntil = 'The retention date cannot be in the past.';
  return errors;
}
