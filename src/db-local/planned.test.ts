// TEAM-1…TEAM-6, TEAM-14, TEAM-15, FLOW-27: planning ahead, invitations, collecting results.
// Several devices are played by exporting files, wiping the database and importing them.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cancelPlanned,
  changePlanned,
  confirmConsent,
  continueDraft,
  createDraftInterview,
  db,
  deleteCandidateData,
  eraseAllData,
  exportCandidateData,
  exportInvitations,
  exportScorecard,
  exportSessionFile,
  importAnyFile,
  importInvitationFile,
  importSessionFile,
  isBlinded,
  loadComparison,
  loadPanel,
  loadSeeds,
  planSeveral,
  purgeExpired,
  queryAudit,
  saveForLater,
  setIndependentScoring,
  setInterviewerName,
  setOverall,
  setScore,
  startSession,
  submitSession,
  discardInterview,
} from './index';
import { clock } from './util';
import { makeTrackFile } from '../test/fixtures';
import type { CandidateInput } from '../domain/validation';
import type { InvitationFile } from '../domain/types';

let now = Date.UTC(2026, 10, 24, 9, 0, 0);
const realNow = clock.now;
const TRACK = () => makeTrackFile('tt', '2026.11', 8);

const who = (p: Partial<CandidateInput> = {}): CandidateInput => ({
  initials: 'Ana Diaz',
  requisitionId: 'REQ-1',
  interviewerName: 'Olive Organiser',
  retentionUntil: '2027-02-22',
  ...p,
});
const sched = (p: Partial<{ date: string; time: string; expected: string[]; note: string }> = {}) => ({ date: '', time: '', expected: [], note: '', ...p });

/** A fresh device with the bank loaded and an interviewer name. */
async function device(name: string) {
  await db.delete();
  await db.open();
  await loadSeeds([TRACK()]);
  await setInterviewerName(name);
}

async function plan(p: Partial<CandidateInput> = {}, s = sched()) {
  const { planId } = await createDraftInterview({ trackId: 'tt', seed: 1 });
  return saveForLater(planId, who(p), s);
}

async function score(sessionId: string, value: 1 | 2 | 3 | 4) {
  await confirmConsent(sessionId);
  await startSession(sessionId);
  const s = (await db.sessions.get(sessionId))!;
  const p = (await db.plans.get(s.planId))!;
  for (const q of p.questions) await setScore(sessionId, q.id, value === 1 || value === 4 ? 3 : value);
  await setOverall(sessionId, { rating: 3, recommendation: 'hire', rationale: 'Solid.' });
  await submitSession(sessionId);
}

beforeEach(async () => {
  now = Date.UTC(2026, 10, 24, 9, 0, 0);
  clock.now = () => now;
  await device('Olive Organiser');
});
afterEach(() => {
  clock.now = realNow;
});

describe('planning ahead (TEAM-1, TEAM-2)', () => {
  it('TEAM-1: "Save for later" fixes the questions and creates the interview, ready to start, with its schedule, interviewers and note', async () => {
    const r = await plan({ recordingNotice: true }, sched({ date: '2026-12-01', time: '10:30', expected: ['Olive Organiser', 'Ben Second', ' ben second '], note: 'Room 4' }));
    const s = (await db.sessions.get(r.sessionId))!;
    expect(s.state).toBe('planned');
    expect(s.invitationId).toBe(r.invitationId);
    expect(s.candidate.consentAt).toBeNull();
    const p = (await db.plannedInterviews.get(r.invitationId))!;
    expect(p).toMatchObject({ date: '2026-12-01', time: '10:30', expected: ['Olive Organiser', 'Ben Second'], note: 'Room 4', recordingNotice: true, organiser: 'Olive Organiser', source: 'here', sessionId: r.sessionId });
    expect(p.candidate).toEqual({ initials: 'Ana Diaz', requisitionId: 'REQ-1' });
    const pl = (await db.plans.get(s.planId))!;
    expect(pl.locked).toBe(true);
    expect(p.fingerprint).toBe(pl.fingerprint);
    expect((await queryAudit()).map((e) => e.action)).toEqual(expect.arrayContaining(['plan.locked', 'invitation.saved']));
  });

  it('TEAM-1: with no interviewers given, the people at this machine are expected; a time needs a day; nothing is written when invalid', async () => {
    const r = await plan({ otherInterviewers: ['Cy At-This-Desk'] });
    expect((await db.plannedInterviews.get(r.invitationId))!.expected).toEqual(['Olive Organiser', 'Cy At-This-Desk']);
    const { planId } = await createDraftInterview({ trackId: 'tt', seed: 2, resume: false });
    await expect(saveForLater(planId, who(), sched({ time: '10:00' }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(saveForLater(planId, who(), sched({ note: 'x'.repeat(501) }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(saveForLater(planId, who({ initials: '' }), sched())).rejects.toMatchObject({ code: 'invalid' });
    expect(await db.plannedInterviews.count()).toBe(1);
    expect((await db.plans.get(planId))!.locked).toBe(false);
  });

  it('TEAM-2: a planned interview can be changed (date, time, interviewers, note) and cancelled until it starts; changes are audited without their text', async () => {
    const a = await plan({}, sched({ date: '2026-12-02' }));
    await changePlanned(a.invitationId, sched({ date: '2026-12-03', time: '09:00', expected: ['Ben'], note: 'Secret candidate remark' }));
    expect(await db.plannedInterviews.get(a.invitationId)).toMatchObject({ date: '2026-12-03', time: '09:00', expected: ['Ben'], note: 'Secret candidate remark' });
    const changed = (await queryAudit({ actions: ['invitation.changed'] }))[0];
    expect(changed.after).toEqual({ fields: ['date', 'time', 'expected', 'note'] });
    expect(JSON.stringify(await db.audit.toArray())).not.toContain('Secret');
    // Several for the same candidate and the same day.
    const b = await plan({}, sched({ date: '2026-12-03' }));
    expect(await db.plannedInterviews.count()).toBe(2);
    await cancelPlanned(b.invitationId);
    expect(await db.plannedInterviews.get(b.invitationId)).toBeUndefined();
    expect(await db.sessions.get(b.sessionId)).toBeUndefined();
    expect(await db.answers.where('sessionId').equals(b.sessionId).count()).toBe(0);
    // Once started: neither changed nor cancelled.
    await confirmConsent(a.sessionId);
    await startSession(a.sessionId);
    await expect(changePlanned(a.invitationId, sched())).rejects.toMatchObject({ code: 'started' });
    await expect(cancelPlanned(a.invitationId)).rejects.toMatchObject({ code: 'started' });
    expect((await queryAudit()).map((e) => e.action)).toContain('invitation.cancelled');
  });

  it('TEAM-2 FLOW-8: discarding to set up again withdraws a planned interview made here', async () => {
    const a = await plan();
    await discardInterview(a.sessionId);
    expect(await db.plannedInterviews.count()).toBe(0);
  });
});

describe('invitation files (TEAM-3, TEAM-4)', () => {
  async function organiserFile() {
    const a = await plan({}, sched({ date: '2026-12-01', time: '10:00', expected: ['Ben Second', 'Cy Third'], note: 'Bring the laptop' }));
    const b = await plan({ initials: 'Bo Li', requisitionId: null }, sched({ date: '2026-12-01', time: '14:00', expected: ['Ben Second'] }));
    const f = await exportInvitations([a.invitationId, b.invitationId]);
    return { a, b, text: f.text, f };
  }

  it('TEAM-3 TEAM-14: one file holds several planned interviews: questions, candidate and requisition, schedule, interviewers, recording, note, organiser; no scores; audited', async () => {
    const { a, text, f } = await organiserFile();
    expect(f.count).toBe(2);
    expect(f.fileName).toMatch(/^interview-invitation-[0-9a-f]{8}-\d{4}-\d{2}-\d{2}\.json$/);
    expect(f.fileName).not.toMatch(/Ana|Diaz/);
    const file = JSON.parse(text) as InvitationFile;
    expect(file.kind).toBe('interview-invitation');
    expect(file.formatVersion).toBe(1);
    expect(file.interviews).toHaveLength(2);
    const first = file.interviews[0];
    expect(first).toMatchObject({ invitationId: a.invitationId, organiser: 'Olive Organiser', date: '2026-12-01', time: '10:00', expectedInterviewers: ['Ben Second', 'Cy Third'], note: 'Bring the laptop', recordingNotice: false });
    expect(Object.keys(first.candidate).sort()).toEqual(['initials', 'requisitionId']);
    expect(first.plan.locked).toBe(true);
    expect(text).not.toMatch(/"score"|"overall"|"answers"|consentAt|sessionId/);
    const audit = (await queryAudit({ actions: ['export'] }))[0];
    expect(audit).toMatchObject({ entity: 'invitation', after: { format: 'invitation-json', interviews: 2 } });
  });

  it('TEAM-4 FLOW-29: importing on another device adds them to Upcoming for this device’s interviewer, with the same questions; re-importing updates, never duplicates', async () => {
    const { a, text } = await organiserFile();
    const fp = (await db.plannedInterviews.get(a.invitationId))!.fingerprint;
    await device('Ben Second');
    const r = await importInvitationFile(JSON.parse(text));
    expect(r.organiser).toBe('Olive Organiser');
    expect(r.items.map((i) => i.outcome)).toEqual(['added', 'added']);
    const mine = (await db.plannedInterviews.get(a.invitationId))!;
    expect(mine).toMatchObject({ source: 'invitation', fingerprint: fp, expected: ['Ben Second', 'Cy Third'], date: '2026-12-01' });
    const s = (await db.sessions.get(mine.sessionId))!;
    expect(s).toMatchObject({ state: 'planned', origin: 'local', invitationId: a.invitationId, interviewers: ['Ben Second'] });
    // Same file again: nothing new.
    expect((await importInvitationFile(JSON.parse(text))).items.map((i) => i.outcome)).toEqual(['unchanged', 'unchanged']);
    expect(await db.sessions.count()).toBe(2);
    // A changed invitation updates what has not started.
    const changed = JSON.parse(text) as InvitationFile;
    changed.interviews[0].time = '11:00';
    changed.interviews[0].note = 'Moved to 11';
    const again = await importInvitationFile(changed);
    expect(again.items[0]).toMatchObject({ outcome: 'updated', changed: ['time', 'note'] });
    expect((await db.plannedInterviews.get(a.invitationId))!.time).toBe('11:00');
    expect(await db.sessions.count()).toBe(2);
    expect((await queryAudit({ actions: ['import'] }))[0].after).toMatchObject({ updated: 1, unchanged: 1 });
  });

  it('TEAM-4: an interview already started or submitted here is left alone and reported', async () => {
    const { a, b, text } = await organiserFile();
    void b;
    await device('Ben Second');
    await importInvitationFile(JSON.parse(text));
    const mine = (await db.plannedInterviews.get(a.invitationId))!;
    await confirmConsent(mine.sessionId);
    await startSession(mine.sessionId);
    const changed = JSON.parse(text) as InvitationFile;
    changed.interviews[0].date = '2026-12-09';
    changed.interviews[1].date = '2026-12-09';
    const r = await importInvitationFile(changed);
    expect(r.items.map((i) => i.outcome)).toEqual(['started', 'updated']);
    expect((await db.plannedInterviews.get(a.invitationId))!.date).toBe('2026-12-01');
    const started = (await db.sessions.get(mine.sessionId))!;
    expect(started.state).toBe('in_progress');
    await setOverall(mine.sessionId, { rating: 3, recommendation: 'hire', rationale: 'ok' });
    for (const q of (await db.plans.get(started.planId))!.questions) await setScore(mine.sessionId, q.id, 3);
    await submitSession(mine.sessionId);
    expect((await importInvitationFile(changed)).items[0].outcome).toBe('submitted');
  });

  it('TEAM-4 SEC-2: a hostile or broken invitation file is rejected as a whole and adds nothing; text is kept as text', async () => {
    const { text } = await organiserFile();
    await device('Ben Second');
    const bad = (mutate: (f: InvitationFile & Record<string, unknown>) => void) => {
      const f = JSON.parse(text);
      mutate(f);
      return importInvitationFile(f);
    };
    await expect(bad((f) => (f.interviews[0].plan.questions[0].version = 99))).rejects.toMatchObject({ code: 'invalid-file' });
    await expect(bad((f) => (f.interviews[0].candidate.initials = 'ann@example.com'))).rejects.toMatchObject({ code: 'invalid-file' });
    await expect(bad((f) => (f.interviews[1].invitationId = f.interviews[0].invitationId))).rejects.toMatchObject({ code: 'invalid-file' });
    await expect(bad((f) => (f.interviews[0].date = '2026-02-31'))).rejects.toMatchObject({ code: 'invalid-file' });
    await expect(bad((f) => (f.interviews[0].note = 'x'.repeat(5000)))).rejects.toMatchObject({ code: 'invalid-file' });
    await expect(bad((f) => (f.interviews = []))).rejects.toMatchObject({ code: 'invalid-file' });
    await expect(bad((f) => (f.interviews = Array(51).fill(f.interviews[0])))).rejects.toMatchObject({ code: 'invalid-file' });
    await expect(bad((f) => ((f as Record<string, unknown>).kind = 'interview-plan'))).rejects.toMatchObject({ code: 'invalid-file' });
    expect(await db.plannedInterviews.count()).toBe(0);
    expect(await db.sessions.count()).toBe(0);
    // Markup is data: stored exactly as text, and unknown fields are not copied.
    const ok = JSON.parse(text);
    ok.interviews[0].note = '<img src=x onerror="alert(1)">';
    ok.interviews[0].organiser = '<script>x</script>';
    ok.interviews[0].plan.extra = 'not copied';
    ok.interviews[0].__proto__polluted = 1;
    await importInvitationFile(ok);
    const p = (await db.plannedInterviews.get(ok.interviews[0].invitationId))!;
    expect(p.note).toBe('<img src=x onerror="alert(1)">');
    expect(p.organiser).toBe('<script>x</script>');
    expect((await db.plans.get(ok.interviews[0].plan.id)) as unknown as Record<string, unknown>).not.toHaveProperty('extra');
  });

  it('TEAM-4: importing an invitation needs this device’s interviewer name', async () => {
    const { text } = await organiserFile();
    await db.delete();
    await db.open();
    await loadSeeds([TRACK()]);
    await expect(importInvitationFile(JSON.parse(text))).rejects.toMatchObject({ code: 'name-required' });
  });
});

describe('collecting results (TEAM-5, TEAM-6, FLOW-27)', () => {
  /** Organiser plans one interview for Ben and Cy; both import it, score and export their files. */
  async function round() {
    const a = await plan({}, sched({ date: '2026-12-01', expected: ['Ben Second', 'cy third'] }));
    const inv = (await exportInvitations([a.invitationId])).text;
    const files: Record<string, string> = {};
    for (const [name, value] of [['Ben Second', 2], ['Cy Third', 3]] as const) {
      await device(name);
      const r = await importInvitationFile(JSON.parse(inv));
      await score(r.items[0].sessionId!, value);
      files[name] = (await exportSessionFile(r.items[0].sessionId!)).text;
    }
    return { a, inv, files };
  }

  it('TEAM-5: interview files carry the invitation id and are matched to their interview automatically; one that matches nothing is kept and explained', async () => {
    const { a, inv, files } = await round();
    expect(JSON.parse(files['Ben Second']).session.invitationId).toBe(a.invitationId);
    // Back on the organiser's device (a fresh one that imports its own invitation).
    await device('Olive Organiser');
    await importInvitationFile(JSON.parse(inv));
    const ben = await importAnyFile(JSON.parse(files['Ben Second']));
    expect(ben).toMatchObject({ kind: 'session', interviewers: ['Ben Second'], candidate: 'Ana Diaz · REQ-1', result: { match: { kind: 'invitation', invitationId: a.invitationId }, replaced: false } });
    // Without the invitation id it is matched by candidate and questions.
    const cy = JSON.parse(files['Cy Third']);
    delete cy.session.invitationId;
    expect(await importAnyFile(cy)).toMatchObject({ result: { match: { kind: 'invitation', invitationId: a.invitationId } } });
    // Same file again replaces the copy.
    expect(await importAnyFile(JSON.parse(files['Ben Second']))).toMatchObject({ result: { replaced: true } });
    // A different candidate matches nothing but is kept.
    const other = JSON.parse(files['Ben Second']);
    other.session.id = '00000000-0000-4000-8000-0000000000aa';
    other.session.candidate.initials = 'Zed Other';
    for (const ans of other.answers) ans.sessionId = other.session.id;
    expect(await importAnyFile(other)).toMatchObject({ result: { match: { kind: 'none', reason: 'invitation-differs' } } });
    delete other.session.invitationId;
    expect(await importAnyFile(other)).toMatchObject({ result: { match: { kind: 'none', reason: 'no-interview' } } });
    expect(await db.sessions.get(other.session.id)).toBeTruthy();
  });

  it('TEAM-5: one entry point routes files by kind; anything else is refused', async () => {
    const { inv } = await round();
    await device('Dee Fourth');
    expect((await importAnyFile(JSON.parse(inv))).kind).toBe('invitation');
    await expect(importAnyFile({ kind: 'candidate-data' })).rejects.toMatchObject({ code: 'unknown-kind' });
    await expect(importAnyFile({ track: {} })).rejects.toMatchObject({ code: 'unknown-kind' });
    await expect(importAnyFile([])).rejects.toMatchObject({ code: 'unknown-kind' });
  });

  it('TEAM-6 FLOW-27: expected, submitted and still to come by name (case-insensitive); by default others’ scores show at once, with independent scoring only after your own is submitted', async () => {
    const { inv, files } = await round();
    await device('Olive Organiser');
    const r = await importInvitationFile(JSON.parse(inv));
    const own = r.items[0].sessionId!;
    let view = (await loadPanel(own))!;
    expect(view.attendance).toEqual({ expected: ['Ben Second', 'cy third'], submitted: [], toCome: ['Ben Second', 'cy third'] });
    await importSessionFile(JSON.parse(files['Ben Second']));
    view = (await loadPanel(own))!;
    expect(view.attendance.submitted).toEqual([{ name: 'Ben Second', you: false }]);
    expect(view.attendance.toCome).toEqual(['cy third']);
    // Default: independent scoring off. Ben's scores are visible although this device's own record has not started.
    expect(view.independentScoring).toBe(false);
    const ben = view.entries.find((e) => e.session.origin === 'imported')!;
    expect(ben.hidden).toBe(false);
    expect(ben.scorecard).not.toBeNull();
    expect(view.panel.members).toHaveLength(1);
    expect(await isBlinded(ben.session)).toBe(false);
    await expect(exportScorecard(ben.session.id, 'markdown')).resolves.toBeTruthy();
    expect((await loadComparison(view.plan.fingerprint!))!.rows).toHaveLength(1);
    // Turned on: hidden until this device's own record is submitted (and the change is audited).
    await setIndependentScoring(true);
    expect((await loadPanel(own))!.entries.find((e) => e.session.origin === 'imported')!.hidden).toBe(true);
    expect(await isBlinded(ben.session)).toBe(true);
    expect((await loadComparison(view.plan.fingerprint!))!.rows).toHaveLength(0);
    await expect(exportScorecard(ben.session.id, 'markdown')).rejects.toMatchObject({ code: 'blinded' });
    await importSessionFile(JSON.parse(files['Cy Third']));
    await score(own, 3);
    view = (await loadPanel(own))!;
    expect(view.entries.every((e) => !e.hidden)).toBe(true);
    // A submitted person who was not expected is simply listed as submitted.
    expect(view.attendance.submitted.map((s) => s.name).sort()).toEqual(['Ben Second', 'Cy Third', 'Olive Organiser']);
    expect(view.attendance.toCome).toEqual([]);
    expect((await queryAudit({ actions: ['device.independent_scoring'] }))[0].after).toEqual({ on: true });
  });

  it('PRIV-1 FLOW-29: names typed differently on two devices (case, spaces) still group into one panel', async () => {
    const { inv, files } = await round();
    await device('Olive Organiser');
    const r = await importInvitationFile(JSON.parse(inv));
    const odd = JSON.parse(files['Ben Second']);
    odd.session.candidate.initials = '  ana   DIAZ ';
    odd.session.candidate.requisitionId = 'req-1';
    delete odd.session.invitationId;
    expect(await importAnyFile(odd)).toMatchObject({ result: { match: { kind: 'invitation' } } });
    expect((await loadPanel(r.items[0].sessionId!))!.entries).toHaveLength(2);
  });
});

describe('privacy of planned interviews (TEAM-14)', () => {
  it('TEAM-14 PRIV-5 PRIV-6: planned interviews follow the retention purge, deletion and access requests and erase-all', async () => {
    const a = await plan({}, sched({ note: 'Note about Ana' }));
    await plan({ initials: 'Bo Li', retentionUntil: '2026-12-01' });
    const access = JSON.parse((await exportCandidateData('ana diaz', 'req-1')).text);
    expect(access.plannedInterviews).toHaveLength(1);
    expect(access.plannedInterviews[0]).toMatchObject({ id: a.invitationId, note: 'Note about Ana' });
    expect(access.audit.some((e: { action: string }) => e.action === 'invitation.saved')).toBe(true);
    await purgeExpired('2026-12-02');
    expect((await db.plannedInterviews.toArray()).map((p) => p.candidate.initials)).toEqual(['Ana Diaz']);
    await deleteCandidateData('Ana Diaz', 'REQ-1');
    expect(await db.plannedInterviews.count()).toBe(0);
    await plan();
    await eraseAllData('ERASE');
    expect(await db.plannedInterviews.count()).toBe(0);
  });
});

describe('plan several (TEAM-15)', () => {
  const lines = [
    { candidate: 'Ana Diaz', requisitionId: 'REQ-1', date: '2026-12-01', time: '09:00', interviewers: ['Ben', 'Cy'] },
    { candidate: 'Bo Li', requisitionId: 'REQ-1', date: '2026-12-01', time: '10:00', interviewers: [] },
    { candidate: 'Chen Wu', requisitionId: null, date: null, time: null, interviewers: ['Ben'] },
  ];

  it('TEAM-15: one planned interview per line; by default all share one question set (one comparison code)', async () => {
    const r = await planSeveral({ trackId: 'tt', sameQuestions: true, lines, seed: 3 });
    expect(r.invitationIds).toHaveLength(3);
    expect(r.planIds).toHaveLength(1);
    const planned = await db.plannedInterviews.toArray();
    expect(new Set(planned.map((p) => p.fingerprint)).size).toBe(1);
    const byName = new Map(planned.map((p) => [p.candidate.initials, p]));
    expect(byName.get('Ana Diaz')).toMatchObject({ date: '2026-12-01', time: '09:00', expected: ['Ben', 'Cy'] });
    expect(byName.get('Bo Li')!.expected).toEqual(['Olive Organiser']);
    expect(await db.sessions.where('state').equals('planned').count()).toBe(3);
    // They export together in one invitation file.
    expect(JSON.parse((await exportInvitations(r.invitationIds)).text).interviews).toHaveLength(3);
  });

  it('TEAM-15: "a separate draw for each" gives each its own question set; a bad line makes nothing', async () => {
    const r = await planSeveral({ trackId: 'tt', sameQuestions: false, lines, seed: 3 });
    expect(r.planIds).toHaveLength(3);
    await db.delete();
    await device('Olive Organiser');
    await expect(planSeveral({ trackId: 'tt', sameQuestions: true, lines: [...lines, { ...lines[0], time: '10:00', date: null }] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(planSeveral({ trackId: 'tt', sameQuestions: true, lines: [lines[0], { ...lines[1], candidate: '<b>' }] })).rejects.toMatchObject({ code: 'invalid' });
    expect(await db.plannedInterviews.count()).toBe(0);
    expect(await db.sessions.count()).toBe(0);
  });
});

describe('the New interview screen still continues as before', () => {
  it('FLOW-33 TEAM-1: Continue makes an interview with no invitation', async () => {
    const { planId } = await createDraftInterview({ trackId: 'tt', seed: 1 });
    const { sessionId } = await continueDraft(planId, who());
    expect((await db.sessions.get(sessionId))!.invitationId).toBeUndefined();
    expect(await db.plannedInterviews.count()).toBe(0);
  });
});
