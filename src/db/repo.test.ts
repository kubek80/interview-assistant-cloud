import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addNote,
  amendAnswer,
  amendOverall,
  createPlan,
  createSessionFromPlan,
  db,
  deleteCandidateData,
  eraseAllData,
  exportCandidateData,
  exportPlanFile,
  exportScorecard,
  exportSessionFile,
  exportTrackFile,
  goToQuestion,
  importPlanFile,
  importSessionFile,
  importTrackFile,
  loadPanel,
  loadComparison,
  loadSeeds,
  lockPlan,
  nextQuestion,
  pauseSession,
  purgeExpired,
  queryAudit,
  resumeSession,
  setOverall,
  setScore,
  skipQuestion,
  skipRemaining,
  confirmConsent,
  startSession,
  submitSession,
  toggleFlag,
  toggleKeyPoint,
  unskipQuestion,
  updateAnswer,
  updatePlanDraft,
  compareVersions,
  bundledSeeds,
  deletePlanDraft,
  getCandidateDraft,
  isBlinded,
  saveCandidateDraft,
  setIndependentScoring,
  type NewSessionInput,
} from './index';
import { clock } from './util';
import { makeTrackFile } from '../test/fixtures';
import { planFingerprint } from '../domain/plan';
import type { AuditEvent } from '../domain/types';

let now = Date.UTC(2026, 10, 24, 9, 0, 0);
const realNow = clock.now;
const advance = (ms: number) => (now += ms);

const details = (p: Partial<NewSessionInput> = {}): NewSessionInput => ({
  initials: 'ab',
  requisitionId: 'REQ-1',
  interviewerName: 'Pat',
  retentionUntil: '2027-02-22',
  ...p,
});

const actions = async () => (await db.audit.orderBy('id').toArray()).map((e) => e.action);

beforeEach(async () => {
  now = Date.UTC(2026, 10, 24, 9, 0, 0);
  clock.now = () => now;
  await db.delete();
  await db.open();
  await loadSeeds([makeTrackFile('tt', '2026.11', 4)]);
});

afterEach(() => {
  clock.now = realNow;
});

async function lockedSession(input = details()) {
  const planId = await createPlan('tt');
  await updatePlanDraft(planId, { questionIds: ['tt-1', 'tt-2', 'tt-3'] });
  const { sessionId } = await lockPlan(planId, input);
  return { planId, sessionId };
}

async function finishedSession(input = details()) {
  const ids = await lockedSession(input);
  const { sessionId } = ids;
  await confirmConsent(sessionId);
  await startSession(sessionId);
  await setScore(sessionId, 'tt-1', 3);
  await setScore(sessionId, 'tt-2', 4);
  await addNote(sessionId, 'tt-2', 'Gave numbers');
  await skipQuestion(sessionId, 'tt-3', 'Out of time');
  await setOverall(sessionId, { rating: 3, recommendation: 'hire', rationale: 'Good' });
  await submitSession(sessionId);
  return ids;
}

describe('bank loading', () => {
  it('BANK-6: seeds load on first start and are audited', async () => {
    expect(await db.questions.count()).toBe(4);
    expect(await db.categories.where('trackId').equals('tt').count()).toBe(2);
    expect(await actions()).toEqual(['bank.loaded']);
  });

  it('BANK-6, OV-2, MVP-4: the bundled seed files (when present) validate and load: four tracks of about 50 questions', async () => {
    const seeds = bundledSeeds();
    if (!seeds.length) return;
    await db.delete();
    await db.open();
    const result = await loadSeeds(seeds);
    expect(result.invalid).toEqual([]);
    expect(result.loaded).toHaveLength(seeds.length);
    expect(await db.questions.count()).toBe(seeds.reduce((n, s) => n + s.questions.length, 0));
    expect(Object.fromEntries(seeds.map((s) => [s.track.id, s.questions.length]))).toEqual({ aks: 50, edge: 53, qa: 50, web: 54 });
  });

  it('BANK-6: a seed reloads only when its version is newer', async () => {
    expect((await loadSeeds([makeTrackFile('tt', '2026.11', 5)])).loaded).toEqual([]);
    expect(await db.questions.count()).toBe(4);
    expect((await loadSeeds([makeTrackFile('tt', '2026.12', 5)])).loaded).toEqual([{ trackId: 'tt', from: '2026.11', to: '2026.12' }]);
    expect(await db.questions.count()).toBe(5);
    expect(compareVersions('2026.10', '2026.9')).toBe(1);
  });

  it('BANK-6, FLOW-8: reloading the bank never changes a locked plan', async () => {
    const { planId } = await lockedSession();
    const reloaded = makeTrackFile('tt', '2027.01', 4);
    reloaded.questions[0].text = 'Rewritten';
    reloaded.questions[0].version = 2;
    await loadSeeds([reloaded]);
    const plan = (await db.plans.get(planId))!;
    expect(plan.questions[0].text).toBe('Question 1 of tt');
    expect(plan.questions[0].version).toBe(1);
    expect(planFingerprint(plan)).toBe(plan.fingerprint);
  });

  it('BANK-7: track import is validated and audited; export is audited', async () => {
    await expect(importTrackFile({ nope: true })).rejects.toMatchObject({ code: 'invalid-file' });
    await importTrackFile(makeTrackFile('zz', '2027.01', 2));
    expect(await db.questions.where('trackId').equals('zz').count()).toBe(2);
    const out = await exportTrackFile('zz');
    expect(JSON.parse(out.text).questions).toHaveLength(2);
    expect((await actions()).slice(-2)).toEqual(['import', 'export']);
  });
});

describe('plans', () => {
  it('FLOW-6: category weights and must-have can be changed before locking', async () => {
    const planId = await createPlan('tt');
    await updatePlanDraft(planId, { categories: [{ id: 'tt-alpha', weight: 1.5, mustHave: true }], timeBudgetMin: 45 });
    const plan = (await db.plans.get(planId))!;
    expect(plan.categories.find((c) => c.id === 'tt-alpha')).toMatchObject({ weight: 1.5, mustHave: true });
    expect(plan.timeBudgetMin).toBe(45);
  });

  it('FLOW-7 FLOW-8 FLOW-10 PRIV-4 DATA-6: Continue creates the interview without consent; it cannot start until consent is confirmed, and the time is stored then', async () => {
    const planId = await createPlan('tt');
    await updatePlanDraft(planId, { questionIds: ['tt-1'] });
    const { sessionId } = await lockPlan(planId, details());
    let s = (await db.sessions.get(sessionId))!;
    expect(s.candidate.consentAt).toBeNull();
    expect(s.candidate.initials).toBe('ab');
    await expect(startSession(sessionId)).rejects.toMatchObject({ code: 'consent-required' });
    expect((await db.sessions.get(sessionId))!.state).toBe('planned');
    now += 120_000;
    await confirmConsent(sessionId);
    s = (await db.sessions.get(sessionId))!;
    expect(s.candidate.consentAt).toBe(new Date(now).toISOString());
    const [entry] = await queryAudit({ actions: ['session.consent_confirmed'] });
    expect(entry).toMatchObject({ entity: 'session', entityId: sessionId });
    await startSession(sessionId);
    expect((await db.sessions.get(sessionId))!.state).toBe('in_progress');
    await expect(confirmConsent(sessionId)).rejects.toMatchObject({ code: 'invalid-state' });
  });

  it('PRIV-1: a name or initials up to 60 characters is stored as typed (trimmed); anything else is rejected', async () => {
    const planId = await createPlan('tt');
    await updatePlanDraft(planId, { questionIds: ['tt-1'] });
    await expect(lockPlan(planId, details({ initials: 'alice@example.com' }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(lockPlan(planId, details({ initials: 'A'.repeat(61) }))).rejects.toMatchObject({ code: 'invalid' });
    const { sessionId } = await lockPlan(planId, details({ initials: '  Ana   Diaz ' }));
    expect((await db.sessions.get(sessionId))!.candidate.initials).toBe('Ana Diaz');
  });

  it('FLOW-8, FLOW-9: a locked plan has a fingerprint, snapshots, an audit entry, and cannot change', async () => {
    const { planId, sessionId } = await lockedSession();
    const plan = (await db.plans.get(planId))!;
    expect(plan.locked).toBe(true);
    expect(plan.fingerprint).toBe(planFingerprint(plan));
    expect(plan.questions.map((q) => q.id)).toEqual(['tt-1', 'tt-2', 'tt-3']);
    await expect(updatePlanDraft(planId, { timeBudgetMin: 30 })).rejects.toMatchObject({ code: 'locked' });
    expect(await actions()).toContain('plan.locked');
    expect(await db.answers.where('sessionId').equals(sessionId).count()).toBe(3);
  });

  it('FLOW-9: a locked plan can be reused for another candidate', async () => {
    const { planId } = await lockedSession();
    const second = await createSessionFromPlan(planId, details({ initials: 'CD' }));
    expect((await db.sessions.get(second))!.planId).toBe(planId);
  });

  it('PRIV-3: session ids are random UUIDs, not candidate data', async () => {
    const { sessionId } = await lockedSession();
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('live interview', () => {
  it('FLOW-10, AUD-2: starting starts the overall and question timers and is audited', async () => {
    const { sessionId } = await lockedSession();
    await confirmConsent(sessionId);
    await startSession(sessionId);
    const s = (await db.sessions.get(sessionId))!;
    expect(s.state).toBe('in_progress');
    expect(s.timer.runningSince).toBe(now);
    expect((await db.answers.get([sessionId, 'tt-1']))!.timer.runningSince).toBe(now);
    expect(await actions()).toContain('session.started');
  });

  it('FLOW-20, DATA-3: navigating moves the per-question timer', async () => {
    const { sessionId } = await lockedSession();
    await confirmConsent(sessionId);
    await startSession(sessionId);
    advance(30_000);
    await nextQuestion(sessionId);
    const a1 = (await db.answers.get([sessionId, 'tt-1']))!;
    expect(a1.timer).toEqual({ accumulatedMs: 30_000, runningSince: null });
    expect(a1.elapsedSec).toBe(30);
    expect((await db.answers.get([sessionId, 'tt-2']))!.timer.runningSince).toBe(now);
    expect((await db.sessions.get(sessionId))!.currentQuestionId).toBe('tt-2');
  });

  it('FLOW-21, RES-2: pause stops both timers; resume restarts them from stored values', async () => {
    const { sessionId } = await lockedSession();
    await confirmConsent(sessionId);
    await startSession(sessionId);
    advance(10_000);
    await pauseSession(sessionId);
    advance(60_000);
    await resumeSession(sessionId);
    advance(5_000);
    const s = (await db.sessions.get(sessionId))!;
    expect(s.timer.accumulatedMs + (now - s.timer.runningSince!)).toBe(15_000);
  });

  it('FLOW-15: notes are stamped with elapsed interview time', async () => {
    const { sessionId } = await lockedSession();
    await confirmConsent(sessionId);
    await startSession(sessionId);
    advance(95_000);
    await addNote(sessionId, 'tt-1', '  Mentioned overlay  ');
    expect((await db.answers.get([sessionId, 'tt-1']))!.notes).toEqual([{ atSec: 95, text: 'Mentioned overlay' }]);
  });

  it('RES-1: ticks, score, flags and current question are saved immediately', async () => {
    const { sessionId } = await lockedSession();
    await confirmConsent(sessionId);
    await startSession(sessionId);
    await toggleKeyPoint(sessionId, 'tt-1', 1);
    await toggleKeyPoint(sessionId, 'tt-1', 0);
    await updateAnswer(sessionId, 'tt-1', { redFlagsSeen: [0], probeHandled: true });
    await setScore(sessionId, 'tt-1', 2);
    await toggleFlag(sessionId, 'tt-1');
    await goToQuestion(sessionId, 'tt-3');
    // Simulate a reload: read straight from the database.
    const a = (await db.answers.get([sessionId, 'tt-1']))!;
    expect(a).toMatchObject({ coveredKeyPoints: [0, 1], redFlagsSeen: [0], probeHandled: true, score: 2, flagged: true });
    expect((await db.sessions.get(sessionId))!.currentQuestionId).toBe('tt-3');
  });

  it('FLOW-17: skipping needs a reason, clears the score, and can be undone', async () => {
    const { sessionId } = await lockedSession();
    await setScore(sessionId, 'tt-1', 3);
    await expect(skipQuestion(sessionId, 'tt-1', ' ')).rejects.toMatchObject({ code: 'reason-required' });
    await skipQuestion(sessionId, 'tt-1', 'Ran out of time');
    expect((await db.answers.get([sessionId, 'tt-1']))!).toMatchObject({ skipped: true, score: null, skipReason: 'Ran out of time' });
    await unskipQuestion(sessionId, 'tt-1');
    expect((await db.answers.get([sessionId, 'tt-1']))!).toMatchObject({ skipped: false, skipReason: null });
  });

  it('UX-6 FLOW-17: "skip the remaining" skips every unanswered question with one reason in one go; each can be undone', async () => {
    const planId = await createPlan('tt');
    await updatePlanDraft(planId, { questionIds: ['tt-1', 'tt-2', 'tt-3', 'tt-4'] });
    const { sessionId } = await lockPlan(planId, details());
    await confirmConsent(sessionId);
    await startSession(sessionId);
    await setScore(sessionId, 'tt-1', 3);
    await skipQuestion(sessionId, 'tt-3', 'Own reason');
    await toggleFlag(sessionId, 'tt-4');
    await expect(skipRemaining(sessionId, '  ')).rejects.toMatchObject({ code: 'reason-required' });
    expect(await skipRemaining(sessionId, ' Ran out of time ')).toEqual(['tt-2', 'tt-4']);
    const get = async (q: string) => (await db.answers.get([sessionId, q]))!;
    expect(await get('tt-1')).toMatchObject({ score: 3, skipped: false });
    expect(await get('tt-2')).toMatchObject({ skipped: true, skipReason: 'Ran out of time', score: null });
    expect(await get('tt-3')).toMatchObject({ skipped: true, skipReason: 'Own reason' });
    expect(await get('tt-4')).toMatchObject({ skipped: true, skipReason: 'Ran out of time', flagged: true });
    // Nothing left: a second call skips nothing.
    expect(await skipRemaining(sessionId, 'Again')).toEqual([]);
    // Undo still works per question before submitting.
    await unskipQuestion(sessionId, 'tt-2');
    expect(await get('tt-2')).toMatchObject({ skipped: false, skipReason: null });
    await setOverall(sessionId, { rating: 3, recommendation: 'hire', rationale: 'ok' });
    await skipRemaining(sessionId, 'Ran out of time');
    await submitSession(sessionId);
    await expect(skipRemaining(sessionId, 'Late')).rejects.toMatchObject({ code: 'submitted' });
  });

  it('UX-6: "skip the remaining" is all or nothing', async () => {
    const { sessionId } = await lockedSession();
    await confirmConsent(sessionId);
    await startSession(sessionId);
    const put = db.answers.put.bind(db.answers);
    let calls = 0;
    db.answers.put = ((...args: Parameters<typeof put>) => {
      if (++calls === 2) throw new Error('disk full');
      return put(...args);
    }) as typeof db.answers.put;
    try {
      await expect(skipRemaining(sessionId, 'Out of time')).rejects.toThrow('disk full');
    } finally {
      db.answers.put = put;
    }
    for (const q of ['tt-1', 'tt-2', 'tt-3']) expect((await db.answers.get([sessionId, q]))?.skipped ?? false).toBe(false);
  });

  it('FLOW-16, FLOW-22: submit is blocked until complete; a 4 needs a note', async () => {
    const { sessionId } = await lockedSession();
    await confirmConsent(sessionId);
    await startSession(sessionId);
    await setScore(sessionId, 'tt-1', 4);
    await setScore(sessionId, 'tt-2', 2);
    await skipQuestion(sessionId, 'tt-3', 'n/a');
    await setOverall(sessionId, { rating: 3, recommendation: 'hire', rationale: 'ok' });
    await expect(submitSession(sessionId)).rejects.toMatchObject({ code: 'cannot-finish' });
    await addNote(sessionId, 'tt-1', 'Quantified the outcome');
    await submitSession(sessionId);
    expect((await db.sessions.get(sessionId))!.state).toBe('submitted');
  });

  it('FLOW-23, AUD-2: submitting locks the record, stops timers and is audited', async () => {
    const { sessionId } = await finishedSession();
    const s = (await db.sessions.get(sessionId))!;
    expect(s.submittedAt).not.toBeNull();
    expect(s.timer.runningSince).toBeNull();
    expect(await actions()).toContain('session.submitted');
    await expect(setScore(sessionId, 'tt-1', 1)).rejects.toMatchObject({ code: 'submitted' });
    await expect(addNote(sessionId, 'tt-1', 'x')).rejects.toMatchObject({ code: 'submitted' });
  });

  it('AUD-4: amending after submission needs a reason and records before and after', async () => {
    const { sessionId } = await finishedSession();
    await expect(amendAnswer(sessionId, 'tt-1', { score: 2 }, '')).rejects.toMatchObject({ code: 'reason-required' });
    await amendAnswer(sessionId, 'tt-1', { score: 2 }, 'Mis-click');
    const ev = (await queryAudit({ actions: ['session.amended'] }))[0];
    expect(ev).toMatchObject({ entityId: sessionId, before: { questionId: 'tt-1', score: 3 }, after: { questionId: 'tt-1', score: 2 }, reason: 'Mis-click', actor: 'Pat' });
    await amendOverall(sessionId, { recommendation: 'lean_no_hire' }, 'Reconsidered');
    expect((await db.sessions.get(sessionId))!.overall.recommendation).toBe('lean_no_hire');
    await expect(amendAnswer(sessionId, 'tt-1', { score: 4 }, 'No note')).rejects.toMatchObject({ code: 'cannot-finish' });
  });

  it('AUD-1: audit entries have time, actor, action and entity', async () => {
    await finishedSession();
    const all: AuditEvent[] = await queryAudit();
    expect(all[0].id).toBeGreaterThan(all[all.length - 1].id!);
    for (const e of all) expect(e).toMatchObject({ ts: expect.any(String), actor: expect.any(String), action: expect.any(String), entity: expect.any(String) });
  });
});

describe('files and panels', () => {
  it('FLOW-26, FLOW-32: a submitted session exports with its plan; the export is audited', async () => {
    const { sessionId } = await finishedSession();
    const file = await exportSessionFile(sessionId);
    const json = JSON.parse(file.text);
    expect(json).toMatchObject({ kind: 'interview-session', formatVersion: 1 });
    expect(json.plan.id).toBe(json.session.planId);
    expect(file.fileName).not.toContain('AB');
    expect((await actions()).at(-1)).toBe('export');
  });

  it('FLOW-31, FLOW-32: scorecard exports (Markdown, CSV, print) are audited', async () => {
    const { sessionId } = await finishedSession();
    expect((await exportScorecard(sessionId, 'markdown')).text).toContain('# Scorecard');
    expect((await exportScorecard(sessionId, 'csv')).text).toContain('Question id');
    expect(await exportScorecard(sessionId, 'print')).toBeNull();
    const exports = await queryAudit({ actions: ['export'] });
    expect(exports.map((e) => (e.after as { format: string }).format)).toEqual(['scorecard-print', 'scorecard-csv', 'scorecard-markdown']);
  });

  it('FLOW-9: plan files export and import (idempotently) on another device', async () => {
    const { planId } = await lockedSession();
    const text = (await exportPlanFile(planId)).text;
    await db.delete();
    await db.open();
    expect(await importPlanFile(JSON.parse(text))).toEqual({ planId, alreadyPresent: false });
    expect(await importPlanFile(JSON.parse(text))).toEqual({ planId, alreadyPresent: true });
    expect(await actions()).toEqual(['import']);
  });

  it('FLOW-27, FLOW-28, FLOW-29: with independent scoring on, imported panelist sessions are hidden until your own is submitted', async () => {
    // Panelist B's device.
    const b = await finishedSession(details({ interviewerName: 'Bo' }));
    const planText = (await exportPlanFile(b.planId)).text;
    const sessionText = (await exportSessionFile(b.sessionId)).text;
    // Your device: import the shared plan, interview the same candidate.
    await db.delete();
    await db.open();
    await loadSeeds([makeTrackFile('tt', '2026.11', 4)]);
    await setIndependentScoring(true); // FLOW-27: independent scoring turned on for this device
    await importPlanFile(JSON.parse(planText));
    const mine = await createSessionFromPlan(b.planId, details());
    await importSessionFile(JSON.parse(sessionText));
    const imported = (await db.sessions.get(b.sessionId))!;
    expect(imported.origin).toBe('imported');

    let view = (await loadPanel(mine))!;
    expect(view.entries).toHaveLength(2);
    const hidden = view.entries.find((e) => e.session.origin === 'imported')!;
    expect(hidden.hidden).toBe(true);
    expect(hidden.scorecard).toBeNull();
    expect(view.panel.members).toHaveLength(0);

    await confirmConsent(mine);

    await startSession(mine);
    await setScore(mine, 'tt-1', 2);
    await setScore(mine, 'tt-2', 2);
    await setScore(mine, 'tt-3', 2);
    await setOverall(mine, { rating: 2, recommendation: 'lean_no_hire', rationale: 'Shallow' });
    await submitSession(mine);

    view = (await loadPanel(mine))!;
    expect(view.entries.every((e) => !e.hidden)).toBe(true);
    expect(view.panel.members).toHaveLength(2);
    expect(view.panel.median).toBeCloseTo((100 / 3 + 250 / 3) / 2, 6);
    expect(view.panel.spreadFlag).toBe(true);

    // A different candidate key does not join the panel.
    const other = await createSessionFromPlan(b.planId, details({ initials: 'ZZ' }));
    expect((await loadPanel(other))!.entries).toHaveLength(1);

    const comparison = (await loadComparison(view.plan.fingerprint!))!;
    expect(comparison.rows).toHaveLength(2);
  });

  it('FLOW-27, SEC-2: unsubmitted or invalid session files are rejected', async () => {
    await expect(importSessionFile({ kind: 'interview-session', formatVersion: 1 })).rejects.toMatchObject({ code: 'invalid-file' });
  });

  it('FLOW-26: your own session file cannot be re-imported as a panelist', async () => {
    const { sessionId } = await finishedSession();
    const text = (await exportSessionFile(sessionId)).text;
    await expect(importSessionFile(JSON.parse(text))).rejects.toMatchObject({ code: 'own-session' });
  });
});

describe('privacy', () => {
  it('PRIV-5: sessions past their retention date are purged and the purge is audited without candidate details', async () => {
    const { sessionId } = await lockedSession(details({ retentionUntil: '2026-12-01' }));
    await lockedSession(details({ initials: 'KEEP', retentionUntil: '2027-12-01' }));
    expect(await purgeExpired('2026-12-01')).toBe(0);
    expect(await purgeExpired('2026-12-02')).toBe(1);
    expect(await db.sessions.get(sessionId)).toBeUndefined();
    expect(await db.answers.where('sessionId').equals(sessionId).count()).toBe(0);
    const ev = (await queryAudit({ actions: ['retention.purged'] }))[0];
    expect(JSON.stringify(ev)).not.toMatch(/"AB"|REQ-1/);
  });

  it('PRIV-6: access request exports everything for one candidate key, audited without details', async () => {
    await finishedSession();
    await lockedSession(details({ initials: 'XY' }));
    const out = await exportCandidateData('ab', 'req-1');
    expect(out.sessionCount).toBe(1);
    const json = JSON.parse(out.text);
    expect(json.kind).toBe('candidate-data');
    expect(json.sessions[0].answers).toHaveLength(3);
    const ev = (await queryAudit({ actions: ['privacy.access_request'] }))[0];
    expect(JSON.stringify(ev)).not.toMatch(/AB|REQ-1/);
  });

  it('PRIV-6: deletion request removes one candidate key only, and is audited', async () => {
    await finishedSession();
    await lockedSession(details({ initials: 'XY' }));
    expect(await deleteCandidateData('AB', 'REQ-1')).toBe(1);
    const left = await db.sessions.toArray();
    expect(left.map((s) => s.candidate.initials)).toEqual(['XY']);
    expect(await actions()).toContain('privacy.deletion_request');
  });

  it('PRIV-6, AUD-1: erase all clears everything including the audit log, then records the erase', async () => {
    await finishedSession();
    await expect(eraseAllData('nope' as 'ERASE')).rejects.toMatchObject({ code: 'confirmation-required' });
    await eraseAllData('ERASE');
    expect(await db.sessions.count()).toBe(0);
    expect(await db.plans.count()).toBe(0);
    // Bundled seeds (if present) are reloaded afterwards and logged as bank.loaded.
    const log = (await queryAudit()).filter((e) => e.action !== 'bank.loaded');
    expect(log.map((e) => e.action)).toEqual(['data.erased']);
    expect(log[0].actor).toBe('Pat');
  });
});

describe('verification additions', () => {
  const draft = (p: Partial<Parameters<typeof saveCandidateDraft>[1]> = {}) => ({
    initials: 'DR',
    requisitionId: 'req-9',
    interviewerName: 'Pat',
    retentionUntil: '2027-02-22',
    ...p,
  });

  it('RES-1, FLOW-7: draft candidate details persist in IndexedDB and are removed on lock', async () => {
    const planId = await createPlan('tt');
    await updatePlanDraft(planId, { questionIds: ['tt-1'] });
    await saveCandidateDraft(planId, draft());
    expect(await getCandidateDraft(planId)).toMatchObject({ initials: 'DR', requisitionId: 'req-9' });
    await lockPlan(planId, details({ initials: 'DR' }));
    expect(await getCandidateDraft(planId)).toBeNull();
    // A save still queued after locking does not bring the draft back.
    await saveCandidateDraft(planId, draft());
    expect(await getCandidateDraft(planId)).toBeNull();
  });

  it('RES-1, PRIV-6: deleting a draft plan deletes its candidate details', async () => {
    const planId = await createPlan('tt');
    await saveCandidateDraft(planId, draft());
    await deletePlanDraft(planId);
    expect(await db.candidateDrafts.count()).toBe(0);
  });

  it('PRIV-6: access and deletion requests include draft candidate details for the key', async () => {
    const planId = await createPlan('tt');
    await saveCandidateDraft(planId, draft());
    const other = await createPlan('tt');
    await saveCandidateDraft(other, draft({ initials: 'ZZ' }));
    const access = JSON.parse((await exportCandidateData('dr', 'REQ-9')).text);
    expect(access.drafts).toHaveLength(1);
    expect(access.drafts[0].planId).toBe(planId);
    await deleteCandidateData('DR', 'REQ-9');
    expect((await db.candidateDrafts.toArray()).map((d) => d.planId)).toEqual([other]);
  });

  it('PRIV-5: draft candidate details past their retention date are purged; the date is the last day kept', async () => {
    const planId = await createPlan('tt');
    await saveCandidateDraft(planId, draft({ retentionUntil: '2026-12-01' }));
    await purgeExpired('2026-12-01');
    expect(await getCandidateDraft(planId)).not.toBeNull();
    await purgeExpired('2026-12-02');
    expect(await getCandidateDraft(planId)).toBeNull();
  });

  it('PRIV-6, AUD-1: a deletion request redacts candidate text in that session’s amendment entries but keeps the entries', async () => {
    const { sessionId } = await finishedSession();
    const keep = await finishedSession(details({ initials: 'KP' }));
    await amendAnswer(sessionId, 'tt-2', { notes: [{ atSec: 0, text: 'SECRET candidate quote' }] }, 'Typo in SECRET quote');
    await amendOverall(sessionId, { rationale: 'SECRET rationale' }, 'Clarify');
    await amendOverall(keep.sessionId, { rationale: 'Kept rationale' }, 'Clarify kept');
    const before = await db.audit.count();
    await deleteCandidateData('AB', 'REQ-1');
    const log = await db.audit.toArray();
    expect(log).toHaveLength(before + 1);
    expect(JSON.stringify(log)).not.toContain('SECRET');
    const amended = log.filter((e) => e.action === 'session.amended' && e.entityId === sessionId);
    expect(amended).toHaveLength(2);
    expect(amended[0]).toMatchObject({ before: { redacted: true, questionId: 'tt-2', fields: ['notes'] }, reason: '[redacted]', actor: 'Pat' });
    expect(amended[1]).toMatchObject({ after: { redacted: true, fields: ['rationale'] } });
    // Other candidates' entries are untouched.
    expect(JSON.stringify(log)).toContain('Kept rationale');
  });

  it('PRIV-5, AUD-1: the retention purge redacts amendment text of purged sessions', async () => {
    const { sessionId } = await finishedSession(details({ retentionUntil: '2026-12-01' }));
    await amendOverall(sessionId, { rationale: 'SECRET rationale' }, 'SECRET reason');
    await purgeExpired('2026-12-02');
    expect(JSON.stringify(await db.audit.toArray())).not.toContain('SECRET');
  });

  it('FLOW-27: with independent scoring on, the data layer keeps a blinded panelist session out of exports and bundles', async () => {
    const b = await finishedSession(details({ interviewerName: 'Bo' }));
    const planText = (await exportPlanFile(b.planId)).text;
    const sessionText = (await exportSessionFile(b.sessionId)).text;
    await db.delete();
    await db.open();
    await loadSeeds([makeTrackFile('tt', '2026.11', 4)]);
    await setIndependentScoring(true); // FLOW-27: independent scoring turned on for this device
    await importPlanFile(JSON.parse(planText));
    const mine = await createSessionFromPlan(b.planId, details());
    await importSessionFile(JSON.parse(sessionText));
    const imported = (await db.sessions.get(b.sessionId))!;
    expect(await isBlinded(imported)).toBe(true);
    await expect(exportScorecard(b.sessionId, 'markdown')).rejects.toMatchObject({ code: 'blinded' });
    await expect(exportSessionFile(b.sessionId)).rejects.toMatchObject({ code: 'blinded' });
    await confirmConsent(mine);
    await startSession(mine);
    for (const q of ['tt-1', 'tt-2', 'tt-3']) await setScore(mine, q, 3);
    await setOverall(mine, { rating: 3, recommendation: 'hire', rationale: 'ok' });
    await submitSession(mine);
    expect(await isBlinded(imported)).toBe(false);
    await expect(exportScorecard(b.sessionId, 'markdown')).resolves.toBeTruthy();
  });

  it('DATA-1, DATA-2: stored records carry the documented fields, states and origin', async () => {
    const { planId, sessionId } = await finishedSession();
    const has = (o: object, keys: string[]) => expect(Object.keys(o)).toEqual(expect.arrayContaining(keys));
    const plan = (await db.plans.get(planId))!;
    has(plan, ['id', 'trackId', 'trackVersion', 'name', 'questions', 'categories', 'timeBudgetMin', 'locked', 'lockedAt', 'fingerprint', 'createdAt']);
    has(plan.questions[0], ['id', 'trackId', 'categoryId', 'number', 'text', 'description', 'difficulty', 'type', 'lookFor', 'redFlags', 'probes', 'timeMin', 'version', 'status', 'rubricOverride']);
    has(plan.categories[0], ['id', 'trackId', 'name', 'weight', 'mustHave']);
    const session = (await db.sessions.get(sessionId))!;
    has(session, ['id', 'planId', 'candidate', 'interviewer', 'state', 'currentQuestionId', 'timer', 'overall', 'createdAt', 'startedAt', 'submittedAt', 'origin']);
    has(session.candidate, ['initials', 'requisitionId', 'consentAt', 'retentionUntil']);
    has(session.timer, ['accumulatedMs', 'runningSince']);
    expect(session.state).toBe('submitted');
    expect(session.origin).toBe('local');
    const answer = (await db.answers.where('sessionId').equals(sessionId).first())!;
    has(answer, ['sessionId', 'questionId', 'score', 'coveredKeyPoints', 'redFlagsSeen', 'probeHandled', 'notes', 'flagged', 'skipped', 'skipReason', 'elapsedSec']);
    has((await db.audit.toArray())[0], ['id', 'ts', 'actor', 'action', 'entity', 'entityId', 'before', 'after', 'reason']);
    has((await db.tracks.toArray())[0], ['id', 'name', 'version']);
    const { sessionId: s2 } = await lockedSession(details({ initials: 'ST' }));
    expect((await db.sessions.get(s2))!.state).toBe('planned');
    await confirmConsent(s2);
    await startSession(s2);
    expect((await db.sessions.get(s2))!.state).toBe('in_progress');
    await pauseSession(s2);
    expect((await db.sessions.get(s2))!.state).toBe('paused');
  });

  it('PRIV-6: erase all also removes draft candidate details', async () => {
    const planId = await createPlan('tt');
    await saveCandidateDraft(planId, draft());
    await eraseAllData('ERASE');
    expect(await db.candidateDrafts.count()).toBe(0);
  });
});
