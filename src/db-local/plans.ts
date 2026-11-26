import { db, SETTINGS, type CandidateDraftRecord } from './db';
import { RepoError, appendAudit, clock, getSetting, newId, nowIso, setSetting } from './util';
import {
  DEFAULT_QUOTAS,
  DEFAULT_TIME_BUDGET_MIN,
  MAX_CANDIDATE,
  addDays,
  cleanCandidate,
  drawBalanced,
  filterQuestions,
  isoDate,
  planCategoriesFrom,
  planFingerprint,
  type Quotas,
  type UnmetQuota,
} from '../domain/plan';
import { newSeed } from '../domain/random';
import { DEVICE_SETTINGS, getDefaultRetentionDays, getLastTrackId, getRecordingNoticeDefault } from './settings';
import { validateCandidateInput, type CandidateInput } from '../domain/validation';
import type { Answer, InterviewPlan, Session } from '../domain/types';
import { cleanName } from '../domain/interviewers';

/** Options for creating a local record. */
export interface RecordOptions {
  /** TEAM-1, TEAM-3: the planned interview (invitation) the record belongs to. */
  invitationId?: string;
  /** Remember the interviewer, role and recording choice as this device's defaults (default true). */
  remember?: boolean;
}

export type { CandidateInput as NewSessionInput } from '../domain/validation';

async function getPlanOrThrow(planId: string): Promise<InterviewPlan> {
  const plan = await db.plans.get(planId);
  if (!plan) throw new RepoError('not-found', 'Plan not found.');
  return plan;
}

/** FLOW-1/2: start a draft plan for a track, with the track's categories as defaults (FLOW-6). */
export async function createPlan(trackId: string, opts: { name?: string } = {}): Promise<string> {
  return db.transaction('rw', [db.plans, db.tracks, db.categories], async () => {
    const track = await db.tracks.get(trackId);
    if (!track) throw new RepoError('not-found', 'Track not found.');
    const categories = await db.categories.where('trackId').equals(trackId).toArray();
    const plan: InterviewPlan = {
      id: newId(),
      trackId,
      trackVersion: track.version,
      name: opts.name ?? `${track.name} interview`,
      questions: [],
      categories: planCategoriesFrom(categories),
      timeBudgetMin: DEFAULT_TIME_BUDGET_MIN,
      locked: false,
      lockedAt: null,
      fingerprint: null,
      createdAt: nowIso(),
    };
    await db.plans.add(plan);
    return plan.id;
  });
}

/** The track-dependent fields of a draft when its role changes (FLOW-33); the name follows if it was the default. */
async function trackDefaults(trackId: string, plan: InterviewPlan): Promise<Pick<InterviewPlan, 'trackId' | 'trackVersion' | 'categories' | 'name'>> {
  const [track, oldTrack] = await Promise.all([db.tracks.get(trackId), db.tracks.get(plan.trackId)]);
  if (!track) throw new RepoError('not-found', 'Track not found.');
  const categories = await db.categories.where('trackId').equals(trackId).toArray();
  const defaultName = !oldTrack || plan.name === `${oldTrack.name} interview`;
  return { trackId, trackVersion: track.version, categories: planCategoriesFrom(categories), name: defaultName ? `${track.name} interview` : plan.name };
}

export interface PlanDraftPatch {
  /** FLOW-33: a different role (track) for the draft; give `questionIds` from that track too. */
  trackId?: string;
  name?: string;
  /** Ordered question ids from the bank; replaces the selection. */
  questionIds?: string[];
  /** FLOW-6: per-category weight and must-have overrides. */
  categories?: Array<{ id: string; weight?: number; mustHave?: boolean }>;
  timeBudgetMin?: number;
}

/** FLOW-2..6: edit a draft plan. Throws if the plan is locked (FLOW-8). */
export async function updatePlanDraft(planId: string, patch: PlanDraftPatch): Promise<void> {
  await db.transaction('rw', [db.plans, db.questions, db.tracks, db.categories], async () => {
    const plan = await getPlanOrThrow(planId);
    if (plan.locked) throw new RepoError('locked', 'This plan is locked and cannot be changed.');
    const next: InterviewPlan = { ...plan };
    if (patch.trackId !== undefined && patch.trackId !== plan.trackId) Object.assign(next, await trackDefaults(patch.trackId, plan));
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.timeBudgetMin !== undefined) {
      if (!(patch.timeBudgetMin > 0)) throw new RepoError('invalid', 'The time budget must be more than 0 minutes.');
      next.timeBudgetMin = patch.timeBudgetMin;
    }
    if (patch.questionIds) {
      const unique = [...new Set(patch.questionIds)];
      const found = await db.questions.bulkGet(unique);
      const previous = new Map(plan.questions.map((q) => [q.id, q]));
      next.questions = unique.map((id, i) => found[i] ?? previous.get(id)).filter((q) => q !== undefined);
      if (next.questions.some((q) => q.trackId !== next.trackId)) throw new RepoError('invalid', 'Questions must come from the plan’s track.');
    } else if (next.trackId !== plan.trackId) {
      next.questions = [];
    }
    if (patch.categories) {
      const byId = new Map(patch.categories.map((c) => [c.id, c]));
      next.categories = next.categories.map((c) => {
        const p = byId.get(c.id);
        if (!p) return c;
        if (p.weight !== undefined && !(p.weight > 0)) throw new RepoError('invalid', 'Category weights must be more than 0.');
        return { ...c, weight: p.weight ?? c.weight, mustHave: p.mustHave ?? c.mustHave };
      });
    }
    await db.plans.put(next);
  });
}

function buildSession(plan: InterviewPlan, input: CandidateInput, origin: Session['origin'] = 'local', opts: RecordOptions = {}): { session: Session; answers: Answer[] } {
  const errors = validateCandidateInput(input, isoDate(new Date(clock.now())));
  if (Object.keys(errors).length) throw new RepoError('invalid', 'Some candidate details are missing or invalid.', Object.values(errors));
  const now = nowIso();
  const session: Session = {
    id: newId(),
    planId: plan.id,
    candidate: {
      initials: cleanCandidate(input.initials),
      requisitionId: input.requisitionId?.trim() || null,
      // FLOW-7, PRIV-4: consent is confirmed on the ready screen, with the candidate present (confirmConsent).
      consentAt: null,
      retentionUntil: input.retentionUntil,
      // TR-4: the ready screen adds the recording sentence; the consent confirmation then covers it.
      ...(input.recordingNotice ? { recordingNotice: true } : {}),
    },
    interviewer: { name: cleanName(input.interviewerName) },
    // DATA-5, PANEL-1: everyone running the interview at this machine, sharing this one record.
    interviewers: [input.interviewerName, ...(input.otherInterviewers ?? [])].map(cleanName),
    state: 'planned',
    currentQuestionId: plan.questions[0]?.id ?? null,
    timer: { accumulatedMs: 0, runningSince: null },
    overall: { rating: null, recommendation: null, rationale: '' },
    createdAt: now,
    startedAt: null,
    submittedAt: null,
    origin,
    ...(opts.invitationId ? { invitationId: opts.invitationId } : {}),
  };
  const answers: Answer[] = plan.questions.map((q) => ({
    sessionId: session.id,
    questionId: q.id,
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
  }));
  return { session, answers };
}

async function rememberInterviewer(name: string): Promise<void> {
  if (!(await getSetting<string>(SETTINGS.interviewerName))?.trim()) await setSetting(SETTINGS.interviewerName, name.trim());
}

/** TR-4: the "recorded or transcribed" choice is remembered for the next interview on this device. */
async function rememberRecordingNotice(input: CandidateInput): Promise<void> {
  await setSetting(DEVICE_SETTINGS.recordingNotice, input.recordingNotice === true);
}

/**
 * FLOW-8, FLOW-9 ("Continue" on the New interview screen): pins (locks) a draft plan and creates
 * the interview for it, ready to start. Questions are re-snapshotted from the bank at this moment
 * (version pinning). Consent is confirmed later, on the ready screen (FLOW-7, PRIV-4). Audited as
 * plan.locked (AUD-2).
 */
export async function lockPlan(planId: string, input: CandidateInput, opts: RecordOptions = {}): Promise<{ sessionId: string; fingerprint: string }> {
  return db.transaction('rw', [db.plans, db.questions, db.sessions, db.answers, db.audit, db.settings, db.candidateDrafts], async () => {
    const plan = await getPlanOrThrow(planId);
    if (plan.locked) throw new RepoError('locked', 'This plan is already locked.');
    if (!plan.questions.length) throw new RepoError('invalid', 'Add at least one question before locking the plan.');
    if (!(plan.timeBudgetMin > 0)) throw new RepoError('invalid', 'Set a time budget.');
    const current = await db.questions.bulkGet(plan.questions.map((q) => q.id));
    const questions = plan.questions.map((q, i) => ({ ...(current[i] ?? q) }));
    const lockedAt = nowIso();
    const locked: InterviewPlan = { ...plan, questions, locked: true, lockedAt, fingerprint: '' };
    locked.fingerprint = planFingerprint(locked);
    const { session, answers } = buildSession(locked, input, 'local', opts);
    await rememberInterviewer(input.interviewerName);
    await rememberRecordingNotice(input);
    await setSetting(DEVICE_SETTINGS.lastTrackId, plan.trackId);
    await db.plans.put(locked);
    await db.sessions.add(session);
    await db.answers.bulkAdd(answers);
    // The draft's candidate details now live on the session.
    await db.candidateDrafts.delete(planId);
    await appendAudit({
      action: 'plan.locked',
      entity: 'plan',
      entityId: plan.id,
      after: {
        fingerprint: locked.fingerprint,
        questions: questions.length,
        timeBudgetMin: locked.timeBudgetMin,
        ...(session.interviewers && session.interviewers.length > 1 ? { interviewers: session.interviewers } : {}),
      },
    });
    return { sessionId: session.id, fingerprint: locked.fingerprint };
  });
}

/** FLOW-9 reuse: a new planned interview on an existing locked plan (same questions, comparable results). */
export async function createSessionFromPlan(planId: string, input: CandidateInput, opts: RecordOptions = {}): Promise<string> {
  return db.transaction('rw', [db.plans, db.sessions, db.answers, db.settings], async () => {
    const plan = await getPlanOrThrow(planId);
    if (!plan.locked) throw new RepoError('not-locked', 'Lock the plan before starting an interview from it.');
    const { session, answers } = buildSession(plan, input, 'local', opts);
    if (opts.remember !== false) {
      await rememberInterviewer(input.interviewerName);
      await rememberRecordingNotice(input);
      await setSetting(DEVICE_SETTINGS.lastTrackId, plan.trackId);
    }
    await db.sessions.add(session);
    await db.answers.bulkAdd(answers);
    return session.id;
  });
}

/**
 * FLOW-33, FLOW-8, FLOW-9: "Continue" on the New interview screen. Creates the interview, ready to
 * start: on the draft's own questions (pinned by lockPlan), or, when the draft reuses an existing
 * question set, on that locked plan (the draft is then removed).
 */
export async function continueDraft(planId: string, input: CandidateInput, opts: RecordOptions = {}): Promise<{ sessionId: string; planId: string }> {
  const draft = await db.candidateDrafts.get(planId);
  const reuse = draft?.reusePlanId ?? null;
  if (!reuse) return { sessionId: (await lockPlan(planId, input, opts)).sessionId, planId };
  return db.transaction('rw', [db.plans, db.sessions, db.answers, db.settings, db.candidateDrafts], async () => {
    const plan = await getPlanOrThrow(planId);
    if (plan.locked) throw new RepoError('locked', 'This plan is already locked.');
    const sessionId = await createSessionFromPlan(reuse, input, opts);
    await db.plans.delete(planId);
    await db.candidateDrafts.delete(planId);
    return { sessionId, planId: reuse };
  });
}

/** Copy any plan into a new editable draft (e.g. to change a locked plan's questions). */
export async function duplicatePlan(planId: string): Promise<string> {
  return db.transaction('rw', [db.plans], async () => {
    const plan = await getPlanOrThrow(planId);
    const copy: InterviewPlan = {
      ...structuredClone(plan),
      id: newId(),
      name: `${plan.name} (copy)`,
      locked: false,
      lockedAt: null,
      fingerprint: null,
      createdAt: nowIso(),
    };
    await db.plans.add(copy);
    return copy.id;
  });
}

/** Deletes a draft (unlocked) plan and its draft candidate details. Locked plans are kept because sessions refer to them. */
export async function deletePlanDraft(planId: string): Promise<void> {
  await db.transaction('rw', [db.plans, db.candidateDrafts], async () => {
    const plan = await getPlanOrThrow(planId);
    if (plan.locked) throw new RepoError('locked', 'Locked plans cannot be deleted.');
    await db.plans.delete(planId);
    await db.candidateDrafts.delete(planId);
  });
}

export type CandidateDraftInput = Omit<CandidateDraftRecord, 'planId' | 'updatedAt'>;

/**
 * FLOW-7, RES-1 (additive): saves the candidate details typed on a draft plan's New interview
 * screen, so closing the tab loses nothing. Ignored once the plan is locked or deleted (a save that
 * was still queued when the plan was locked must not bring the draft back).
 */
export async function saveCandidateDraft(planId: string, draft: CandidateDraftInput): Promise<void> {
  await db.transaction('rw', [db.plans, db.candidateDrafts], async () => {
    const plan = await db.plans.get(planId);
    if (!plan || plan.locked) return;
    const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
    const reuse = typeof draft.reusePlanId === 'string' && draft.reusePlanId ? (await db.plans.get(draft.reusePlanId)) : undefined;
    await db.candidateDrafts.put({
      planId,
      initials: clip(draft.initials, MAX_CANDIDATE),
      requisitionId: clip(draft.requisitionId, 100),
      interviewerName: clip(draft.interviewerName, 200),
      otherInterviewers: Array.isArray(draft.otherInterviewers) ? draft.otherInterviewers.slice(0, 12).map((n) => clip(n, 200)) : [],
      retentionUntil: clip(draft.retentionUntil, 10),
      recordingNotice: draft.recordingNotice === true,
      // FLOW-9: reuse only an existing locked question set of the same role.
      reusePlanId: reuse?.locked && reuse.trackId === plan.trackId ? reuse.id : null,
      updatedAt: nowIso(),
    });
  });
}

/** The saved candidate details of a draft plan, or null. */
export async function getCandidateDraft(planId: string): Promise<CandidateDraftInput | null> {
  const d = await db.candidateDrafts.get(planId);
  if (!d) return null;
  const { planId: _p, updatedAt: _u, ...rest } = d;
  return rest;
}

/** A draft with nothing typed for a candidate yet: "New interview" picks it up instead of starting another. */
async function untouchedDraft(): Promise<InterviewPlan | undefined> {
  const drafts = (await db.plans.toArray()).filter((p) => !p.locked).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const p of drafts) {
    const d = await db.candidateDrafts.get(p.id);
    if (!d || (!d.initials.trim() && !d.requisitionId.trim() && !(d.otherInterviewers ?? []).some((n) => n.trim()) && !d.reusePlanId)) return p;
  }
  return undefined;
}

export interface NewInterviewOptions {
  /** Role (track); default: the one used last on this device, else the first. */
  trackId?: string;
  /** FLOW-9: start from an existing locked question set ("Use the same questions as…"). */
  reusePlanId?: string;
  /** Seed for the random draw (FLOW-3), for repeatable tests. */
  seed?: number;
  /** Pick up the newest draft that has no candidate details yet instead of creating another (default true). */
  resume?: boolean;
}

/**
 * FLOW-33, UX-2: the draft behind the New interview screen. It arrives with a balanced question set
 * already drawn with the default quotas (FLOW-3), preferring a draw that fits the default time
 * budget (FLOW-4). With `reusePlanId`, the draft reuses that locked set (FLOW-9).
 */
export async function createDraftInterview(opts: NewInterviewOptions = {}): Promise<{ planId: string; unmet: UnmetQuota[] }> {
  return db.transaction('rw', [db.plans, db.tracks, db.categories, db.questions, db.settings, db.candidateDrafts], async () => {
    const reuse = opts.reusePlanId ? await db.plans.get(opts.reusePlanId) : undefined;
    if (opts.reusePlanId && (!reuse || !reuse.locked)) throw new RepoError('not-found', 'That question set is not on this device.');
    if (!reuse && opts.resume !== false) {
      const existing = await untouchedDraft();
      if (existing && (!opts.trackId || existing.trackId === opts.trackId) && existing.questions.length) return { planId: existing.id, unmet: [] };
    }
    const tracks = (await db.tracks.toArray()).sort((a, b) => a.id.localeCompare(b.id));
    const last = await getLastTrackId();
    const trackId = reuse?.trackId ?? opts.trackId ?? (last && tracks.some((t) => t.id === last) ? last : tracks[0]?.id);
    if (!trackId) throw new RepoError('not-found', 'No question bank is loaded.');
    const id = await createPlan(trackId);
    if (reuse) {
      await db.plans.update(id, { questions: structuredClone(reuse.questions), categories: structuredClone(reuse.categories), timeBudgetMin: reuse.timeBudgetMin });
      await db.candidateDrafts.put({
        planId: id,
        initials: '',
        requisitionId: '',
        interviewerName: (await getSetting<string>(SETTINGS.interviewerName))?.trim() ?? '',
        otherInterviewers: [],
        retentionUntil: isoDate(addDays(new Date(clock.now()), await getDefaultRetentionDays())),
        recordingNotice: await getRecordingNoticeDefault(),
        reusePlanId: reuse.id,
        updatedAt: nowIso(),
      });
      return { planId: id, unmet: [] };
    }
    const { unmet } = await drawDraft(id, { seed: opts.seed });
    return { planId: id, unmet };
  });
}

export interface DrawOptions {
  /** FLOW-33: change the role at the same time (the set is redrawn from that role's bank). */
  trackId?: string;
  /** FLOW-3: the mix; default quotas when omitted. */
  quotas?: Partial<Quotas>;
  /** FLOW-2, FLOW-3: draw only from these categories (empty: all). */
  categoryIds?: string[];
  seed?: number;
}

/**
 * FLOW-3, UX-2: (re)draws a draft's question set: "Shuffle", a role change, or a new mix. Spreads
 * picks across categories and never exceeds what the category filter allows; reports quotas that
 * could not be met. Prefers a set that fits the draft's time budget (FLOW-4).
 */
export async function drawDraft(planId: string, opts: DrawOptions = {}): Promise<{ questionIds: string[]; unmet: UnmetQuota[] }> {
  return db.transaction('rw', [db.plans, db.tracks, db.categories, db.questions, db.settings], async () => {
    const plan = await getPlanOrThrow(planId);
    if (plan.locked) throw new RepoError('locked', 'This plan is locked and cannot be changed.');
    const trackId = opts.trackId ?? plan.trackId;
    const bank = await db.questions.where('trackId').equals(trackId).sortBy('number');
    const pool = filterQuestions(bank, { categoryIds: opts.categoryIds ?? [] });
    const draw = drawBalanced(pool, opts.quotas ?? DEFAULT_QUOTAS, plan.timeBudgetMin, opts.seed ?? newSeed());
    const next: InterviewPlan = { ...plan, ...(trackId !== plan.trackId ? await trackDefaults(trackId, plan) : {}), questions: draw.questions.map((q) => ({ ...q })) };
    await db.plans.put(next);
    if (opts.trackId) await setSetting(DEVICE_SETTINGS.lastTrackId, trackId);
    return { questionIds: next.questions.map((q) => q.id), unmet: draw.unmet };
  });
}

/**
 * FLOW-8 ("until the interview is started it can be discarded and set up again"): removes an
 * interview that has not started. Its question set returns to a draft with the candidate details
 * filled in, so it can be changed and continued again; when other interviews use the same set, it
 * stays as it is and a new draft reusing it is made instead. Returns the draft to open. Audited.
 */
export async function discardInterview(sessionId: string): Promise<{ planId: string }> {
  return db.transaction('rw', [db.plans, db.sessions, db.answers, db.audit, db.settings, db.candidateDrafts, db.tracks, db.categories, db.transcripts, db.recordings, db.aiResults, db.plannedInterviews], async () => {
    const session = await db.sessions.get(sessionId);
    if (!session) throw new RepoError('not-found', 'Interview not found.');
    if (session.origin !== 'local') throw new RepoError('read-only', 'Imported panelist sessions are read-only.');
    if (session.state !== 'planned') throw new RepoError('invalid-state', 'Only an interview that has not started can be discarded.');
    // TEAM-1, TEAM-4: an interview from someone else's invitation keeps the questions everyone shares.
    const planned = session.invitationId ? await db.plannedInterviews.get(session.invitationId) : undefined;
    if (planned?.source === 'invitation') {
      throw new RepoError('invitation', 'This interview comes from an invitation, so everyone on the panel has the same questions. To drop it, cancel it on the Dashboard.');
    }
    // Planned here: setting it up again makes a new interview; the old invitation is withdrawn.
    if (planned) await db.plannedInterviews.delete(planned.id);
    const plan = await getPlanOrThrow(session.planId);
    await db.answers.where('sessionId').equals(sessionId).delete();
    await db.sessions.delete(sessionId);
    await Promise.all([db.transcripts.delete(sessionId), db.recordings.delete(sessionId), db.aiResults.delete(sessionId)]);
    const shared = (await db.sessions.where('planId').equals(plan.id).count()) > 0;
    let planId = plan.id;
    if (shared) {
      planId = await createPlan(plan.trackId);
      await db.plans.update(planId, { questions: structuredClone(plan.questions), categories: structuredClone(plan.categories), timeBudgetMin: plan.timeBudgetMin });
    } else {
      await db.plans.put({ ...plan, locked: false, lockedAt: null, fingerprint: null });
    }
    const names = session.interviewers?.length ? session.interviewers : [session.interviewer.name];
    await db.candidateDrafts.put({
      planId,
      initials: session.candidate.initials,
      requisitionId: session.candidate.requisitionId ?? '',
      interviewerName: names[0] ?? '',
      otherInterviewers: names.slice(1),
      retentionUntil: session.candidate.retentionUntil,
      recordingNotice: session.candidate.recordingNotice === true,
      reusePlanId: shared ? plan.id : null,
      updatedAt: nowIso(),
    });
    await appendAudit({ action: 'session.discarded', entity: 'session', entityId: sessionId, after: { planId: plan.id, returnedToDraft: !shared }, actorFallback: session.interviewer.name });
    return { planId };
  });
}
