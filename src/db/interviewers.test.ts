// DATA-5, PANEL-1…PANEL-5: several interviewers at one machine sharing one record.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addInterviewer,
  addNote,
  addNoteEntry,
  amendAnswer,
  createPlan,
  createSessionFromPlan,
  db,
  editNote,
  exportPlanFile,
  exportScorecard,
  exportSessionFile,
  getCandidateDraft,
  importPlanFile,
  importSessionFile,
  loadPanel,
  loadSeeds,
  lockPlan,
  queryAudit,
  createDraftInterview,
  continueDraft,
  removeInterviewer,
  saveCandidateDraft,
  setInterviewerName,
  setOverall,
  setScore,
  confirmConsent,
  startSession,
  submitSession,
  updatePlanDraft,
  setIndependentScoring,
  type NewSessionInput,
} from './index';
import { clock } from './util';
import { makeTrackFile } from '../test/fixtures';
import { interviewersOf } from '../domain/interviewers';
import { validateSessionFile } from '../domain/validation';

let now = Date.UTC(2026, 10, 24, 9, 0, 0);
const realNow = clock.now;

const details = (p: Partial<NewSessionInput> = {}): NewSessionInput => ({
  initials: 'ab',
  requisitionId: 'REQ-1',
  interviewerName: 'Ana',
  otherInterviewers: ['Ben'],
  retentionUntil: '2027-02-22',
  ...p,
});

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

async function shared(input = details()) {
  const planId = await createPlan('tt');
  await updatePlanDraft(planId, { questionIds: ['tt-1', 'tt-2', 'tt-3'] });
  const { sessionId } = await lockPlan(planId, input);
  return { planId, sessionId };
}

async function finish(sessionId: string, s: 2 | 3 = 3) {
  await confirmConsent(sessionId);
  await startSession(sessionId);
  for (const q of ['tt-1', 'tt-2', 'tt-3']) await setScore(sessionId, q, s);
  await setOverall(sessionId, { rating: s, recommendation: 'hire', rationale: 'Agreed together' });
  await submitSession(sessionId);
}

describe('DATA-5: interviewers on the session', () => {
  it('DATA-5, PANEL-2: one session holds every interviewer, the device’s first; interviewer.name is the first name', async () => {
    const { sessionId } = await shared(details({ otherInterviewers: ['  Ben  ', 'Cy'] }));
    const s = (await db.sessions.get(sessionId))!;
    expect(s.interviewers).toEqual(['Ana', 'Ben', 'Cy']);
    expect(s.interviewer.name).toBe('Ana');
    expect(await db.sessions.count()).toBe(1); // PANEL-2: one record, not one per interviewer
    expect((await queryAudit({ actions: ['plan.locked'] }))[0].after).toMatchObject({ interviewers: ['Ana', 'Ben', 'Cy'] });
  });

  it('DATA-5: sessions and files made before DATA-5 (no interviewers) read as their one interviewer and still import', async () => {
    const { planId, sessionId } = await shared(details({ otherInterviewers: [] }));
    await finish(sessionId);
    const file = JSON.parse((await exportSessionFile(sessionId)).text);
    expect(file.formatVersion).toBe(1);
    expect(file.session.interviewers).toEqual(['Ana']);
    const planText = (await exportPlanFile(planId)).text;
    const legacy = structuredClone(file);
    delete legacy.session.interviewers;
    legacy.session.id = 'legacy-1';
    for (const a of legacy.answers) a.sessionId = 'legacy-1';
    await db.delete();
    await db.open();
    await importPlanFile(JSON.parse(planText));
    await importSessionFile(legacy);
    const imported = (await db.sessions.get('legacy-1'))!;
    expect(imported.interviewers).toBeUndefined();
    expect(interviewersOf(imported)).toEqual(['Ana']);
  });

  it('DATA-5, SEC-2: session files bound the new fields: interviewers must differ and start with interviewer.name; note authors are short text', async () => {
    const { sessionId } = await shared();
    await confirmConsent(sessionId);
    await startSession(sessionId);
    await addNote(sessionId, 'tt-1', 'By Ben', 'Ben');
    for (const q of ['tt-1', 'tt-2', 'tt-3']) await setScore(sessionId, q, 3);
    await setOverall(sessionId, { rating: 3, recommendation: 'hire', rationale: 'ok' });
    await submitSession(sessionId);
    const file = JSON.parse((await exportSessionFile(sessionId)).text);
    expect(validateSessionFile(file).ok).toBe(true);
    const dup = structuredClone(file);
    dup.session.interviewers = ['Ana', 'ana'];
    expect(validateSessionFile(dup).ok).toBe(false);
    const wrongFirst = structuredClone(file);
    wrongFirst.session.interviewers = ['Ben', 'Ana'];
    expect(validateSessionFile(wrongFirst).ok).toBe(false);
    const longBy = structuredClone(file);
    longBy.answers.find((a: { notes: unknown[] }) => a.notes.length).notes[0].by = 'x'.repeat(201);
    expect(validateSessionFile(longBy).ok).toBe(false);
    const stranger = structuredClone(file);
    stranger.answers.find((a: { notes: unknown[] }) => a.notes.length).notes[0].by = 'Zed';
    expect(validateSessionFile(stranger).ok).toBe(false);
  });
});

describe('PANEL-1: naming interviewers', () => {
  it('PANEL-1: names must differ; the New interview screen (a new set or the same questions as before) takes more interviewers; one stays the default', async () => {
    const { planId } = await shared();
    await expect(createSessionFromPlan(planId, details({ otherInterviewers: ['ANA'] }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(createSessionFromPlan(planId, details({ otherInterviewers: [' '] }))).rejects.toMatchObject({ code: 'invalid' });
    const two = await createSessionFromPlan(planId, details({ initials: 'CD', otherInterviewers: ['Cy'] }));
    expect((await db.sessions.get(two))!.interviewers).toEqual(['Ana', 'Cy']);
    await setInterviewerName('Ana');
    const a = await createDraftInterview({ trackId: 'tt', seed: 1 });
    const qs = await continueDraft(a.planId, details({ initials: 'QS', otherInterviewers: ['Ben'] }));
    expect((await db.sessions.get(qs.sessionId))!.interviewers).toEqual(['Ana', 'Ben']);
    const b = await createDraftInterview({ trackId: 'tt', seed: 1 });
    const solo = await continueDraft(b.planId, details({ initials: 'QT', otherInterviewers: [] }));
    expect((await db.sessions.get(solo.sessionId))!.interviewers).toEqual(['Ana']);
  });

  it('PANEL-1, RES-1: extra interviewers typed on a draft plan are saved with its candidate details', async () => {
    const planId = await createPlan('tt');
    await saveCandidateDraft(planId, { initials: 'DR', requisitionId: '', interviewerName: 'Ana', otherInterviewers: ['Ben'], retentionUntil: '2027-01-01' });
    expect(await getCandidateDraft(planId)).toMatchObject({ otherInterviewers: ['Ben'] });
  });

  it('PANEL-1, AUD-2: interviewers are added and removed in the live interview until it is submitted; each change is audited', async () => {
    const { sessionId } = await shared();
    await confirmConsent(sessionId);
    await startSession(sessionId);
    await expect(addInterviewer(sessionId, 'ben')).rejects.toMatchObject({ code: 'invalid' });
    await addInterviewer(sessionId, ' Cy ');
    expect((await db.sessions.get(sessionId))!.interviewers).toEqual(['Ana', 'Ben', 'Cy']);
    await removeInterviewer(sessionId, 'Ben');
    expect((await db.sessions.get(sessionId))!.interviewers).toEqual(['Ana', 'Cy']);
    // Removing the first moves interviewer.name to the next; the last cannot be removed.
    await removeInterviewer(sessionId, 'Ana');
    expect((await db.sessions.get(sessionId))!).toMatchObject({ interviewers: ['Cy'], interviewer: { name: 'Cy' } });
    await expect(removeInterviewer(sessionId, 'Cy')).rejects.toMatchObject({ code: 'last-interviewer' });
    const log = await queryAudit({ actions: ['session.interviewer_added', 'session.interviewer_removed'] });
    expect(log.map((e) => e.action)).toEqual(['session.interviewer_removed', 'session.interviewer_removed', 'session.interviewer_added']);
    expect(log[2]).toMatchObject({ entity: 'session', entityId: sessionId, before: { interviewers: ['Ana', 'Ben'] }, after: { interviewers: ['Ana', 'Ben', 'Cy'] } });
    await addInterviewer(sessionId, 'Di');
    for (const q of ['tt-1', 'tt-2', 'tt-3']) await setScore(sessionId, q, 3);
    await setOverall(sessionId, { rating: 3, recommendation: 'hire', rationale: 'ok' });
    await submitSession(sessionId);
    await expect(addInterviewer(sessionId, 'Ed')).rejects.toMatchObject({ code: 'submitted' });
    await expect(removeInterviewer(sessionId, 'Di')).rejects.toMatchObject({ code: 'submitted' });
  });
});

describe('PANEL-3: who made a note', () => {
  it('PANEL-3: a note can carry one of the interviewers’ names; it is optional, checked and kept through edits and amendments', async () => {
    const { sessionId } = await shared();
    await confirmConsent(sessionId);
    await startSession(sessionId);
    now += 65_000;
    await addNote(sessionId, 'tt-1', 'Quantified it', 'ben');
    await addNote(sessionId, 'tt-1', 'Unattributed');
    await expect(addNote(sessionId, 'tt-1', 'x', 'Zed')).rejects.toMatchObject({ code: 'invalid' });
    const i = (await addNoteEntry(sessionId, 'tt-2', 'Typing…', 'Ana'))!;
    await editNote(sessionId, 'tt-2', i, 'Typing done');
    await editNote(sessionId, 'tt-2', i, 'Typing done', 'Ben');
    expect((await db.answers.get([sessionId, 'tt-1']))!.notes).toEqual([
      { atSec: 65, text: 'Quantified it', by: 'Ben' },
      { atSec: 65, text: 'Unattributed' },
    ]);
    expect((await db.answers.get([sessionId, 'tt-2']))!.notes).toEqual([{ atSec: 65, text: 'Typing done', by: 'Ben' }]);
    for (const q of ['tt-1', 'tt-2', 'tt-3']) await setScore(sessionId, q, 3);
    await setOverall(sessionId, { rating: 3, recommendation: 'hire', rationale: 'ok' });
    await submitSession(sessionId);
    await amendAnswer(sessionId, 'tt-1', { score: 2 }, 'Agreed lower');
    expect((await db.answers.get([sessionId, 'tt-1']))!.notes[0].by).toBe('Ben');
  });

  it('PANEL-3, PANEL-4, FLOW-31: exports show the interviewers and who made each note', async () => {
    const { sessionId } = await shared();
    await confirmConsent(sessionId);
    await startSession(sessionId);
    await addNote(sessionId, 'tt-1', 'Gave numbers', 'Ben');
    for (const q of ['tt-1', 'tt-2', 'tt-3']) await setScore(sessionId, q, 3);
    await setOverall(sessionId, { rating: 3, recommendation: 'hire', rationale: 'ok' });
    await submitSession(sessionId);
    const md = (await exportScorecard(sessionId, 'markdown')).text;
    expect(md).toContain('- Interviewers: Ana and Ben (one shared scorecard)');
    expect(md).toContain('[0:00] (Ben) Gave numbers');
    const csv = (await exportScorecard(sessionId, 'csv')).text;
    expect(csv).toContain('[0:00] (Ben) Gave numbers');
  });
});

describe('PANEL-5: a shared scorecard in a debrief', () => {
  it('PANEL-5, FLOW-27: a shared scorecard is one panel entry; an imported shared file keeps all its names and, with independent scoring on, stays hidden until yours is submitted', async () => {
    // Another device: Cy and Di share one scorecard.
    const other = await shared(details({ interviewerName: 'Cy', otherInterviewers: ['Di'] }));
    await finish(other.sessionId, 2);
    const planText = (await exportPlanFile(other.planId)).text;
    const sessionText = (await exportSessionFile(other.sessionId)).text;
    await db.delete();
    await db.open();
    await loadSeeds([makeTrackFile('tt', '2026.11', 4)]);
    await setIndependentScoring(true); // FLOW-27: the rule applies when independent scoring is on
    await importPlanFile(JSON.parse(planText));
    const mine = await createSessionFromPlan(other.planId, details());
    await importSessionFile(JSON.parse(sessionText));
    let view = (await loadPanel(mine))!;
    expect(view.entries).toHaveLength(2);
    const imported = view.entries.find((e) => e.session.origin === 'imported')!;
    expect(interviewersOf(imported.session)).toEqual(['Cy', 'Di']);
    expect(imported.hidden).toBe(true);
    await finish(mine, 3);
    view = (await loadPanel(mine))!;
    expect(view.panel.members.map((m) => interviewersOf(m.ref)).sort()).toEqual([
      ['Ana', 'Ben'],
      ['Cy', 'Di'],
    ]);
  });
});
