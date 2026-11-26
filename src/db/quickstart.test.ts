import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  confirmConsent,
  continueDraft,
  createDraftInterview,
  db,
  discardInterview,
  drawDraft,
  getCandidateDraft,
  getLastTrackId,
  loadSeeds,
  queryAudit,
  saveCandidateDraft,
  setDefaultRetentionDays,
  setInterviewerName,
  setLastTrackId,
  startSession,
  updatePlanDraft,
} from './index';
import { clock } from './util';
import { DEFAULT_QUOTAS, drawBalanced, filterQuestions, planFingerprint, totalTimeMin } from '../domain/plan';
import { makeTrackFile } from '../test/fixtures';
import type { TrackFile } from '../domain/types';

const now = Date.UTC(2026, 10, 24, 9, 0, 0);
const realNow = clock.now;

/** A track with enough questions of every type to meet the default quotas. */
function fullTrack(id = 'qs', count = 20): TrackFile {
  const t = makeTrackFile(id, '2026.11', count);
  const types = ['knowledge', 'knowledge', 'scenario', 'design', 'behavioural'] as const;
  t.questions = t.questions.map((q, i) => ({ ...q, type: types[i % types.length] }));
  // With 20: 8 knowledge, 4 of each other type: knowledge (9) cannot be met fully.
  return t;
}

const candidate = (p: Partial<Parameters<typeof continueDraft>[1]> = {}) => ({
  initials: 'ab',
  requisitionId: ' REQ-9 ',
  interviewerName: 'Pat',
  retentionUntil: '2027-02-22',
  ...p,
});

beforeEach(async () => {
  clock.now = () => now;
  await db.delete();
  await db.open();
  await loadSeeds([fullTrack(), fullTrack('zz', 30)]);
});

afterEach(() => {
  clock.now = realNow;
});

describe('New interview (FLOW-33)', () => {
  it('FLOW-33 UX-2 FLOW-3 FLOW-4: arrives with a set drawn with the default quotas, preferring one that fits the time budget, for the role used last', async () => {
    await setLastTrackId('zz');
    const { planId, unmet } = await createDraftInterview({ seed: 42 });
    const plan = (await db.plans.get(planId))!;
    expect(plan).toMatchObject({ trackId: 'zz', locked: false, timeBudgetMin: 60 });
    const bank = await db.questions.where('trackId').equals('zz').sortBy('number');
    const expected = drawBalanced(filterQuestions(bank, {}), DEFAULT_QUOTAS, 60, 42);
    expect(plan.questions.map((q) => q.id)).toEqual(expected.questions.map((q) => q.id));
    expect(totalTimeMin(plan.questions)).toBeLessThanOrEqual(60);
    expect(unmet).toEqual(expected.unmet);
    // Opening New interview again picks up the same untouched draft instead of starting another.
    expect((await createDraftInterview()).planId).toBe(planId);
    await saveCandidateDraft(planId, { initials: 'AB', requisitionId: '', interviewerName: 'Pat', retentionUntil: '2027-02-22' });
    expect((await createDraftInterview()).planId).not.toBe(planId);
  });

  it('FLOW-33 UX-2 FLOW-3: changing the role or shuffling redraws; a quota that cannot be met is reported; the category filter is respected', async () => {
    const { planId } = await createDraftInterview({ trackId: 'zz', seed: 1 });
    const role = await drawDraft(planId, { trackId: 'qs', seed: 2 });
    const plan = (await db.plans.get(planId))!;
    expect(plan.trackId).toBe('qs');
    expect(plan.name).toBe('Track qs interview');
    expect(plan.categories.map((c) => c.id)).toEqual(['qs-alpha', 'qs-beta']);
    expect(plan.questions.every((q) => q.trackId === 'qs')).toBe(true);
    expect(role.unmet).toEqual([{ type: 'knowledge', wanted: 9, got: 8 }]);
    expect(await getLastTrackId()).toBe('qs');
    const only = await drawDraft(planId, { categoryIds: ['qs-alpha'], quotas: { knowledge: 8, scenario: 0, design: 0, behavioural: 0 } });
    const drawn = (await db.plans.get(planId))!.questions;
    expect(drawn.every((q) => q.categoryId === 'qs-alpha')).toBe(true);
    expect(only.unmet).toEqual([{ type: 'knowledge', wanted: 8, got: drawn.length }]);
    // A role change with chosen questions (as when reusing an earlier set of another role).
    await updatePlanDraft(planId, { trackId: 'zz', questionIds: ['zz-1', 'zz-2'] });
    expect((await db.plans.get(planId))!).toMatchObject({ trackId: 'zz', name: 'Track zz interview' });
    await expect(updatePlanDraft(planId, { trackId: 'qs', questionIds: ['zz-1'] })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('FLOW-33 FLOW-8 FLOW-10 PRIV-4: Continue pins the set and creates the interview without consent; Start waits for the consent confirmation', async () => {
    await setInterviewerName('Pat');
    const { planId } = await createDraftInterview({ trackId: 'zz', seed: 3 });
    const { sessionId } = await continueDraft(planId, candidate());
    const plan = (await db.plans.get(planId))!;
    expect(plan.locked).toBe(true);
    expect(plan.fingerprint).toBe(planFingerprint(plan));
    const session = (await db.sessions.get(sessionId))!;
    expect(session).toMatchObject({ planId, state: 'planned', interviewer: { name: 'Pat' } });
    expect(session.candidate).toMatchObject({ initials: 'ab', requisitionId: 'REQ-9', consentAt: null });
    expect(await getCandidateDraft(planId)).toBeNull();
    const audit = await queryAudit({});
    expect(audit.find((e) => e.action === 'plan.locked')).toMatchObject({ actor: 'Pat', entityId: planId });
    expect(JSON.stringify(audit)).not.toContain('REQ-9');
    await expect(startSession(sessionId)).rejects.toMatchObject({ code: 'consent-required' });
    await confirmConsent(sessionId);
    await startSession(sessionId);
    expect((await db.sessions.get(sessionId))!.state).toBe('in_progress');
  });

  it('FLOW-33 PRIV-1 AUD-1: a valid name or initials and an interviewer are required; nothing is written otherwise; the first name given is kept for the device', async () => {
    const { planId } = await createDraftInterview({ trackId: 'zz', seed: 4 });
    await expect(continueDraft(planId, candidate({ initials: '<Alice>' }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(continueDraft(planId, candidate({ interviewerName: ' ' }))).rejects.toMatchObject({ code: 'invalid' });
    expect((await db.plans.get(planId))!.locked).toBe(false);
    expect(await db.sessions.count()).toBe(0);
    const { sessionId } = await continueDraft(planId, candidate({ interviewerName: '  Sam  ' }));
    expect((await db.sessions.get(sessionId))!.interviewer.name).toBe('Sam');
    expect((await db.settings.get('interviewerName'))!.value).toBe('Sam');
  });

  it('FLOW-9 FLOW-33: "Use the same questions as…" creates the interview on that set, so the results are comparable; the draft goes', async () => {
    await setInterviewerName('Pat');
    const first = await createDraftInterview({ trackId: 'zz', seed: 5 });
    await continueDraft(first.planId, candidate());
    await setDefaultRetentionDays(30);
    const { planId } = await createDraftInterview({ reusePlanId: first.planId });
    expect(await getCandidateDraft(planId)).toMatchObject({ reusePlanId: first.planId, interviewerName: 'Pat', retentionUntil: '2026-12-24' });
    expect((await db.plans.get(planId))!.questions.map((q) => q.id)).toEqual((await db.plans.get(first.planId))!.questions.map((q) => q.id));
    const { sessionId } = await continueDraft(planId, candidate({ initials: 'CD' }));
    expect((await db.sessions.get(sessionId))!.planId).toBe(first.planId);
    expect(await db.plans.get(planId)).toBeUndefined();
    await expect(createDraftInterview({ reusePlanId: 'missing' })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('FLOW-8 FLOW-33: an interview that has not started can be discarded and set up again; its set returns to a draft with the details filled in', async () => {
    await setInterviewerName('Pat');
    const { planId } = await createDraftInterview({ trackId: 'zz', seed: 6 });
    const { sessionId } = await continueDraft(planId, { ...candidate(), otherInterviewers: ['Ben'], recordingNotice: true });
    const back = await discardInterview(sessionId);
    expect(back.planId).toBe(planId);
    expect(await db.sessions.get(sessionId)).toBeUndefined();
    expect(await db.answers.where('sessionId').equals(sessionId).count()).toBe(0);
    expect((await db.plans.get(planId))!).toMatchObject({ locked: false, fingerprint: null, lockedAt: null });
    expect(await getCandidateDraft(planId)).toMatchObject({ initials: 'ab', requisitionId: 'REQ-9', interviewerName: 'Pat', otherInterviewers: ['Ben'], recordingNotice: true, reusePlanId: null });
    expect((await queryAudit({ actions: ['session.discarded'] }))[0]).toMatchObject({ entityId: sessionId });

    // A set that other interviews use stays as it is; the new draft reuses it.
    const a = await continueDraft(planId, candidate());
    const reuse = await createDraftInterview({ reusePlanId: planId });
    const b = await continueDraft(reuse.planId, candidate({ initials: 'CD' }));
    const again = await discardInterview(b.sessionId);
    expect(again.planId).not.toBe(planId);
    expect((await db.plans.get(planId))!.locked).toBe(true);
    expect(await getCandidateDraft(again.planId)).toMatchObject({ initials: 'CD', reusePlanId: planId });
    // A started interview cannot be discarded.
    await confirmConsent(a.sessionId);
    await startSession(a.sessionId);
    await expect(discardInterview(a.sessionId)).rejects.toMatchObject({ code: 'invalid-state' });
  });
});
