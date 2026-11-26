// TEAM-7…TEAM-14, SUM-1, SUM-3, SUM-4, SUM-5: judgements entered by hand, panel decisions, written
// summaries, panel files and the round report. Several devices are played by exporting files,
// wiping the database and importing them.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  amendEnteredJudgement,
  changePlanned,
  confirmConsent,
  createDraftInterview,
  db,
  deleteCandidateData,
  enterJudgement,
  enteredJudgementInput,
  eraseAllData,
  exportCandidateData,
  exportInvitations,
  exportPanelFile,
  exportRoundReport,
  exportScorecard,
  exportSessionFile,
  importAnyFile,
  importInvitationFile,
  importPanelFile,
  loadCandidatePanel,
  loadComparison,
  loadPanel,
  loadRound,
  loadSeeds,
  planSeveral,
  purgeExpired,
  queryAudit,
  recordDecision,
  saveForLater,
  saveWrittenSummary,
  setIndependentScoring,
  setInterviewerName,
  setOverall,
  setScore,
  startSession,
  submitSession,
  takeTheirs,
} from './index';
import { clock } from './util';
import { makeTrackFile } from '../test/fixtures';
import { roundRow } from '../domain/round';
import { medianScores } from '../domain/decision';
import { changedSinceExport } from '../domain/team';
import { dashboardModel } from '../pages/dashboard/logic';
import type { CandidateInput } from '../domain/validation';
import type { EnteredJudgementInput } from '../domain/decision';
import type { Score } from '../domain/types';

let now = Date.UTC(2026, 10, 24, 9, 0, 0);
const realNow = clock.now;
const TRACK = () => makeTrackFile('tt', '2026.11', 6);

const who = (p: Partial<CandidateInput> = {}): CandidateInput => ({
  initials: 'Ana Diaz',
  requisitionId: 'REQ-1',
  interviewerName: 'Olive Organiser',
  retentionUntil: '2027-02-22',
  ...p,
});
const sched = (p: Partial<{ date: string; time: string; expected: string[]; note: string }> = {}) => ({ date: '', time: '', expected: [], note: '', ...p });

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

/** Scores every question with `value` (3 where 1 or 4 would need a note) and submits with `rec`. */
async function score(sessionId: string, value: Score, rec: 'hire' | 'lean_no_hire' | 'strong_hire' | 'no_hire' = 'hire') {
  await confirmConsent(sessionId);
  await startSession(sessionId);
  const s = (await db.sessions.get(sessionId))!;
  const p = (await db.plans.get(s.planId))!;
  for (const q of p.questions) await setScore(sessionId, q.id, value === 1 || value === 4 ? 3 : value);
  await setOverall(sessionId, { rating: 3, recommendation: rec, rationale: 'Solid.' });
  await submitSession(sessionId);
}

const judgement = (p: Partial<EnteredJudgementInput> = {}): EnteredJudgementInput => ({ name: 'Cy Third', rating: 2, recommendation: 'lean_no_hire', rationale: 'Shallow on testing.', scores: {}, notes: {}, ...p });

beforeEach(async () => {
  now = Date.UTC(2026, 10, 24, 9, 0, 0);
  clock.now = () => now;
  await device('Olive Organiser');
});
afterEach(() => {
  clock.now = realNow;
});

/** Organiser plans Ana for Ben and Cy; Ben imports the invitation, scores 2 and sends his file; the organiser imports it. */
async function organiserWithBen() {
  const a = await plan({}, sched({ date: '2026-12-01', time: '10:00', expected: ['Ben Second', 'Cy Third'] }));
  const inv = (await exportInvitations([a.invitationId])).text;
  await device('Ben Second');
  const r = await importInvitationFile(JSON.parse(inv));
  await score(r.items[0].sessionId!, 2, 'lean_no_hire');
  const ben = (await exportSessionFile(r.items[0].sessionId!)).text;
  await device('Olive Organiser');
  const own = (await importInvitationFile(JSON.parse(inv))).items[0].sessionId!;
  await importAnyFile(JSON.parse(ben));
  return { a, own, inv, ben };
}

describe('judgements entered by hand (TEAM-7, TEAM-8)', () => {
  it('TEAM-7 TEAM-6: another interviewer’s judgement is entered with question scores and notes; unscored questions are left out like skipped ones; attendance and the panel pick it up', async () => {
    const { own } = await organiserWithBen();
    const view0 = (await loadPanel(own))!;
    expect(view0.attendance.toCome).toEqual(['Cy Third']);
    const plan0 = view0.plan;
    const [q1, q2, q3] = plan0.questions;
    const id = await enterJudgement(own, judgement({ scores: { [q1.id]: 4, [q2.id]: 3, [q3.id]: null }, notes: { [q1.id]: 'Great on flaky tests', [q3.id]: 'Ran out of time' } }));
    const s = (await db.sessions.get(id))!;
    expect(s).toMatchObject({ origin: 'entered', state: 'submitted', enteredBy: 'Olive Organiser', interviewer: { name: 'Cy Third' }, overall: { rating: 2, recommendation: 'lean_no_hire' } });
    const answers = await db.answers.where('sessionId').equals(id).toArray();
    expect(answers.map((a) => [a.questionId, a.score, a.notes.map((n) => n.text)])).toEqual([
      [q1.id, 4, ['Great on flaky tests']],
      [q2.id, 3, []],
      [q3.id, null, ['Ran out of time']],
    ]);
    const view = (await loadPanel(own))!;
    expect(view.attendance.toCome).toEqual([]);
    expect(view.attendance.submitted.map((x) => x.name)).toEqual(['Ben Second', 'Cy Third']);
    const cy = view.entries.find((e) => e.session.id === id)!;
    expect(cy.hidden).toBe(false);
    expect(cy.scorecard!.answeredCount).toBe(2);
    expect(cy.scorecard!.coverage).toBeLessThan(0.7); // left out like skipped questions (SCORE-6)
    expect(view.panel.members).toHaveLength(2);
    expect((await queryAudit({ actions: ['judgement.entered'] }))[0]).toMatchObject({ entityId: id, after: { onBehalfOf: 'Cy Third', questionsScored: 2, notes: 2 } });
  });

  it('TEAM-7: a judgement with no question scores is allowed; it has no percentage and is not counted in the panel score; the minimum is name, rating, recommendation and rationale', async () => {
    const { own } = await organiserWithBen();
    await expect(enterJudgement(own, judgement({ rationale: ' ' }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(enterJudgement(own, judgement({ rating: null }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(enterJudgement(own, judgement({ recommendation: null }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(enterJudgement(own, judgement({ name: ' ben  SECOND ' }))).rejects.toMatchObject({ details: [expect.stringContaining('already has a judgement')] });
    const id = await enterJudgement(own, judgement());
    const view = (await loadPanel(own))!;
    expect(view.entries.find((e) => e.session.id === id)!.scorecard!.overallPct).toBeNull();
    expect(view.panel.members).toHaveLength(1);
    expect(view.panel.median).toBeCloseTo(33.33, 1);
    const row = roundRow((await loadCandidatePanel(own))!.data);
    expect(row.score).toMatchObject({ source: 'single', members: 1 });
    expect(row.outcome).toMatchObject({ kind: 'recommendations', split: false, text: 'Lean no hire ×2' });
  });

  it('TEAM-8 AUD-4: a judgement entered by hand is labelled, corrected only with a reason, and the correction is audited with before and after', async () => {
    const { own } = await organiserWithBen();
    const q1 = (await loadPanel(own))!.plan.questions[0];
    const id = await enterJudgement(own, judgement({ scores: { [q1.id]: 2 } }));
    const input = await enteredJudgementInput(id);
    expect(input).toMatchObject({ name: 'Cy Third', rating: 2, scores: { [q1.id]: 2 } });
    await expect(amendEnteredJudgement(id, { ...input, recommendation: 'hire' }, ' ')).rejects.toMatchObject({ code: 'reason-required' });
    now += 60_000;
    await amendEnteredJudgement(id, { ...input, recommendation: 'hire', scores: { [q1.id]: 3 } }, 'Misread the paper form');
    expect((await db.sessions.get(id))!.overall.recommendation).toBe('hire');
    expect((await db.answers.get([id, q1.id]))!.score).toBe(3);
    const amended = (await queryAudit({ actions: ['session.amended'] }))[0];
    expect(amended).toMatchObject({ entityId: id, reason: 'Misread the paper form', before: { recommendation: 'lean_no_hire', scores: { [q1.id]: 2 } }, after: { recommendation: 'hire', scores: { [q1.id]: 3 } } });
    // Exports say who entered it on whose behalf.
    const md = (await exportScorecard(id, 'markdown')).text;
    expect(md).toContain('Entered by Olive Organiser on behalf of Cy Third');
    // Ordinary amend paths refuse it (it is not this device's own interview).
    await expect(amendEnteredJudgement(own, input, 'x')).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('panel decision (TEAM-9…TEAM-12)', () => {
  it('TEAM-9 TEAM-11 TEAM-12: one decision per panel; agreed scores only from "start from the median"; a change needs a reason and is audited before and after; individual scores never change', async () => {
    const { own } = await organiserWithBen();
    await enterJudgement(own, judgement({ scores: {} }));
    const cp = (await loadCandidatePanel(own))!;
    expect(cp.panelNames).toEqual(['Ben Second', 'Cy Third']);
    const before = JSON.stringify(await db.answers.toArray());
    await expect(recordDecision(own, { recommendation: 'hire', rationale: '', participants: ['Ben Second'], rating: null, scores: {} })).rejects.toMatchObject({ code: 'invalid' });
    const d = await recordDecision(own, { recommendation: 'lean_no_hire', rationale: 'Not yet senior.', participants: cp.panelNames, rating: null, scores: {} });
    expect(d).toMatchObject({ recordedBy: 'Olive Organiser', scores: {} });
    let row = roundRow((await loadCandidatePanel(own))!.data);
    expect(row.outcome).toMatchObject({ kind: 'decision', text: 'Lean no hire' });
    expect(row.score.source).toBe('single'); // no agreed scores: the figure is still the individual one
    expect(row.state).toBe('decided');
    await expect(recordDecision(own, { ...d, recommendation: 'hire' })).rejects.toMatchObject({ code: 'reason-required' });
    // "Start from the panel's median" fills agreed scores (only on that click, in the dialog).
    const med = medianScores(cp.data.plan, cp.data.entries.filter((e) => e.answers).map((e) => e.answers!));
    expect(Object.values(med).every((v) => v === 2)).toBe(true);
    now += 60_000;
    await recordDecision(own, { ...d, recommendation: 'hire', scores: { ...med, [cp.data.plan.questions[0].id]: 4 } }, 'Second look at the evidence');
    const changed = (await queryAudit({ actions: ['decision.changed'] }))[0];
    expect(changed.reason).toBe('Second look at the evidence');
    expect(changed.before).toMatchObject({ recommendation: 'lean_no_hire', scores: {} });
    expect(changed.after).toMatchObject({ recommendation: 'hire' });
    expect(Object.keys(changed.after as object).sort()).toEqual(['recommendation', 'scores']);
    expect(await db.panelRecords.count()).toBe(1);
    row = roundRow((await loadCandidatePanel(own))!.data);
    expect(row.score).toMatchObject({ source: 'agreed', label: 'Agreed scores' });
    expect(JSON.stringify(await db.answers.toArray())).toBe(before);
    // TEAM-12: the debrief and the comparison carry it.
    expect((await loadPanel(own))!.record!.decision!.recommendation).toBe('hire');
    const cmp = (await loadComparison(cp.data.plan.fingerprint!))!;
    expect([...cmp.decisions.values()][0].recommendation).toBe('hire');
  });

  it('TEAM-10: a panel decision can be recorded for a planned interview with no judgements at all', async () => {
    const a = await plan({}, sched({ expected: ['Ben Second'] }));
    await recordDecision(a.sessionId, { recommendation: 'no_hire', rationale: 'Withdrew; panel agreed not to proceed.', participants: ['Olive Organiser'], rating: null, scores: {} });
    const row = roundRow((await loadCandidatePanel(a.sessionId))!.data);
    expect(row).toMatchObject({ state: 'decided', outcome: { kind: 'decision', text: 'No hire' }, score: { source: 'none' } });
    expect(row.missing).toEqual(['Waiting for 1 judgement: Ben Second (decided anyway)']);
  });
});

describe('written summary (SUM-4)', () => {
  it('SUM-4: the written summary is saved per panel with who and when; the audit log says it was saved, never the text, once per burst of edits', async () => {
    const a = await plan();
    await saveWrittenSummary(a.sessionId, 'Strong on strategy, weak on tooling.');
    now += 60_000;
    await saveWrittenSummary(a.sessionId, 'Strong on strategy, weak on tooling. Recommend a second chat.');
    const rec = (await db.panelRecords.toArray())[0];
    expect(rec.summary).toMatchObject({ text: 'Strong on strategy, weak on tooling. Recommend a second chat.', updatedBy: 'Olive Organiser' });
    let saved = await queryAudit({ actions: ['summary.saved'] });
    expect(saved).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toContain('tooling');
    now += 11 * 60_000;
    await saveWrittenSummary(a.sessionId, 'Changed later.');
    saved = await queryAudit({ actions: ['summary.saved'] });
    expect(saved).toHaveLength(2);
  });
});

describe('Summary rows (SUM-1, SUM-2) and the organiser’s own records (TEAM-6)', () => {
  it('SUM-1 TEAM-6: an organiser who planned for others is not waited for: missing states come from the expected interviewers only', async () => {
    const { own, a } = await organiserWithBen();
    let row = roundRow((await loadRound()).find((p) => p.ref === own)!);
    expect(row.state).toBe('waiting');
    expect(row.missing[0]).toBe('Waiting for 1 judgement: Cy Third');
    expect(row.interviewers).toEqual(['Ben Second', 'Cy Third']);
    expect(row.date).toBe('2026-12-01');
    // On the Dashboard it is no longer "upcoming" for the organiser once someone has submitted.
    const m = dashboardModel(await db.sessions.toArray(), await db.plans.toArray(), await db.plannedInterviews.toArray());
    expect(m.upcoming).toHaveLength(0);
    expect(m.interviews[0].status).toBe('waiting');
    await enterJudgement(own, judgement());
    row = roundRow((await loadRound()).find((p) => p.ref === own)!);
    expect(row.state).toBe('no-decision');
    expect(row.missing).toEqual(['No panel decision yet']);
    expect(a).toBeTruthy();
  });

  it('SUM-2 SUM-6: fifty interviews in two question sets load as one row per panel, grouped by question set', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => ({ candidate: `Cand ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`, requisitionId: 'REQ-9', date: '2026-12-02', time: null, interviewers: ['Ben Second'] }));
    await planSeveral({ trackId: 'tt', sameQuestions: true, lines: lines.slice(0, 30), seed: 3 });
    await loadSeeds([TRACK(), makeTrackFile('uu', '2026.11', 6)]);
    await planSeveral({ trackId: 'uu', sameQuestions: true, lines: lines.slice(30), seed: 9 });
    const t0 = performance.now();
    const round = await loadRound();
    const rows = round.map(roundRow);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(rows).toHaveLength(50);
    expect(new Set(rows.map((r) => r.fingerprint)).size).toBe(2);
    expect(rows.every((r) => r.state === 'not-interviewed')).toBe(true);
  });
});

describe('panel files (TEAM-13)', () => {
  it('TEAM-13 TEAM-8: everything for a panel goes in one panel file (judgements incl. hand-entered, decision, summary; transcript and AI only when chosen) and imports on the hiring manager’s computer with the same figures', async () => {
    const { own } = await organiserWithBen();
    const cyId = await enterJudgement(own, judgement({ scores: {} }));
    await recordDecision(own, { recommendation: 'lean_no_hire', rationale: 'Agreed.', participants: ['Ben Second', 'Cy Third'], rating: 2, scores: {} });
    await saveWrittenSummary(own, 'Good communicator; gaps in test design.');
    const before = roundRow((await loadCandidatePanel(own))!.data);
    const f = await exportPanelFile([own], {});
    expect(f.panels).toBe(1);
    expect(f.judgements).toBe(2);
    const json = JSON.parse(f.text);
    expect(json.kind).toBe('interview-panel');
    expect(json.panels[0].shared).toBeUndefined();
    expect(json.panels[0].judgements.find((j: { session: { id: string } }) => j.session.id === cyId).session).toMatchObject({ origin: 'entered', enteredBy: 'Olive Organiser' });
    expect(f.text).not.toMatch(/"blob"|recording/i);
    expect((await queryAudit({ actions: ['export'] }))[0].after).toMatchObject({ format: 'panel-json', panels: 1, judgements: 2 });

    await device('Hana Manager');
    const r = await importPanelFile(json);
    expect(r.items[0]).toMatchObject({ added: 2, decision: 'added', summary: 'added' });
    const after = roundRow((await loadRound())[0]);
    expect(after).toMatchObject({ outcome: before.outcome, state: before.state, interviewers: before.interviewers, date: before.date, summaryText: 'Good communicator; gaps in test design.' });
    expect(after.score.pct).toBeCloseTo(before.score.pct!, 6);
    expect(after.judgements.find((j) => j.entered)!.session.enteredBy).toBe('Olive Organiser');
    // Importing the same file again changes nothing.
    const again = await importPanelFile(json);
    expect(again.items[0]).toMatchObject({ added: 0, identical: 2, decision: 'same', summary: 'same' });
  });

  it('TEAM-13: a different panel decision on import is reported, not overwritten; "take theirs" applies it with an audit entry; new judgements are added; own records are never touched', async () => {
    const { own } = await organiserWithBen();
    await recordDecision(own, { recommendation: 'hire', rationale: 'Mine.', participants: ['Olive Organiser'], rating: null, scores: {} });
    const json = JSON.parse((await exportPanelFile([own])).text);
    json.panels[0].decision = { ...json.panels[0].decision, recommendation: 'no_hire', rationale: 'Theirs.', recordedBy: 'Hana Manager' };
    json.panels[0].summary = { text: 'Their summary', updatedBy: 'Hana Manager', updatedAt: '2026-11-24T10:00:00.000Z' };
    await saveWrittenSummary(own, 'My summary');
    const r = await importPanelFile(json);
    expect(r.items[0]).toMatchObject({ decision: 'conflict', summary: 'conflict', identical: 1, own: 0 });
    expect((await db.panelRecords.toArray())[0].decision!.recommendation).toBe('hire');
    await takeTheirs(r.items[0].panelId, 'decision', r.items[0].theirs.decision!, 'Hana Manager');
    expect((await db.panelRecords.toArray())[0].decision!.recommendation).toBe('no_hire');
    expect((await queryAudit({ actions: ['decision.changed'] }))[0]).toMatchObject({ reason: 'Taken from a panel file from Hana Manager', before: { recommendation: 'hire' }, after: { recommendation: 'no_hire' } });
    expect((await db.panelRecords.toArray())[0].summary!.text).toBe('My summary');
    // The organiser's own record in a panel file from someone else is left alone.
    const ownFile = JSON.parse((await exportPanelFile([own])).text);
    await device('Ben Second');
    const benPlan = await importPanelFile(ownFile);
    expect(benPlan.items[0].added).toBe(1);
  });

  it('TEAM-13 SEC-2: a hostile or broken panel file is rejected as a whole', async () => {
    const { own } = await organiserWithBen();
    const json = JSON.parse((await exportPanelFile([own])).text);
    const bad = structuredClone(json);
    bad.panels[0].judgements[0].session.candidate.initials = 'Someone Else';
    await expect(importPanelFile(bad)).rejects.toMatchObject({ code: 'invalid-file', details: [expect.stringContaining('different candidate')] });
    const bad2 = structuredClone(json);
    bad2.panels[0].plan.questions[0].version = 99;
    await expect(importPanelFile(bad2)).rejects.toMatchObject({ code: 'invalid-file' });
    const bad3 = structuredClone(json);
    bad3.panels[0].decision = { recommendation: 'hire', rationale: 'x', participants: [], rating: null, scores: { nope: 9 }, recordedBy: 'X', recordedAt: '2026-11-24T10:00:00.000Z' };
    await expect(importPanelFile(bad3)).rejects.toMatchObject({ code: 'invalid-file' });
    expect((await importAnyFile(json)).kind).toBe('panel');
  });
});

describe('round report (SUM-5)', () => {
  it('SUM-5: the Summary view as Markdown (overview then each candidate) and CSV; each export audited', async () => {
    const { own } = await organiserWithBen();
    await enterJudgement(own, judgement({ scores: {} }));
    await recordDecision(own, { recommendation: 'lean_no_hire', rationale: 'Needs more depth.', participants: ['Ben Second', 'Cy Third'], rating: null, scores: {} });
    await saveWrittenSummary(own, 'A clear communicator.');
    const md = (await exportRoundReport([own], 'markdown', 'all roles'))!.text;
    expect(md).toContain('# Interview round summary');
    expect(md.indexOf('## Overview')).toBeLessThan(md.indexOf('## Ana Diaz · REQ-1'));
    expect(md).toContain('- Outcome: Panel decision: Lean no hire \\(recommendations: Lean no hire ×2\\)');
    expect(md).toContain('A clear communicator.');
    expect(md).toContain('Entered by Olive Organiser on behalf of Cy Third');
    const csv = (await exportRoundReport([own], 'csv'))!.text;
    expect(csv.split('\r\n')[0]).toContain('Candidate,Requisition,Role');
    expect(csv).toContain('Panel decision,Lean no hire');
    await exportRoundReport([own], 'print');
    expect((await queryAudit({ actions: ['export'] })).map((e) => (e.after as { format: string }).format).slice(0, 3)).toEqual(['round-print', 'round-csv', 'round-markdown']);
  });
});

describe('privacy (TEAM-14)', () => {
  it('TEAM-14 PRIV-5 PRIV-6: hand-entered judgements, panel decisions and summaries follow the retention purge, deletion and access requests and erase-all; changed decisions are redacted in the log', async () => {
    const { own } = await organiserWithBen();
    const cy = await enterJudgement(own, judgement({ rationale: 'Candidate said something private' }));
    await recordDecision(own, { recommendation: 'hire', rationale: 'Private reason', participants: ['Ben'], rating: null, scores: {} });
    now += 1000;
    await recordDecision(own, { recommendation: 'no_hire', rationale: 'Another private reason', participants: ['Ben'], rating: null, scores: {} }, 'rethink');
    await saveWrittenSummary(own, 'Private summary');
    const access = JSON.parse((await exportCandidateData('ana diaz', 'req-1')).text);
    expect(access.panels[0].summary.text).toBe('Private summary');
    expect(access.sessions.some((s: { session: { id: string } }) => s.session.id === cy)).toBe(true);
    await deleteCandidateData('Ana Diaz', 'REQ-1');
    expect(await db.panelRecords.count()).toBe(0);
    expect(await db.sessions.get(cy)).toBeUndefined();
    expect(JSON.stringify(await db.audit.toArray())).not.toMatch(/Private reason|Another private/);

    // Retention purge.
    const b = await plan({ initials: 'Bo Li', retentionUntil: '2026-11-30' });
    await saveWrittenSummary(b.sessionId, 'Bo summary');
    expect((await db.panelRecords.toArray())[0].retentionUntil).toBe('2026-11-30');
    await purgeExpired('2026-12-01');
    expect(await db.panelRecords.count()).toBe(0);
    // Erase all.
    const c = await plan({ initials: 'Cy Wu' });
    await saveWrittenSummary(c.sessionId, 'x');
    await eraseAllData('ERASE');
    expect(await db.panelRecords.count()).toBe(0);
  });
});

describe('leftovers', () => {
  it('TEAM-3 TEAM-2: changing a planned interview after its invitation was exported marks it changed until it is exported again', async () => {
    const a = await plan({}, sched({ date: '2026-12-01' }));
    expect(changedSinceExport((await db.plannedInterviews.get(a.invitationId))!)).toBe(false);
    await exportInvitations([a.invitationId]);
    expect(changedSinceExport((await db.plannedInterviews.get(a.invitationId))!)).toBe(false);
    now += 60_000;
    await changePlanned(a.invitationId, sched({ date: '2026-12-02' }));
    expect(changedSinceExport((await db.plannedInterviews.get(a.invitationId))!)).toBe(true);
    now += 60_000;
    await exportInvitations([a.invitationId]);
    expect(changedSinceExport((await db.plannedInterviews.get(a.invitationId))!)).toBe(false);
  });

  it('TEAM-15: "Plan several" takes a shared note and the recording option', async () => {
    const r = await planSeveral({ trackId: 'tt', sameQuestions: true, lines: [{ candidate: 'Ana Diaz', requisitionId: null, date: null, time: null, interviewers: [] }], note: 'Room 4', recordingNotice: true });
    const p = (await db.plannedInterviews.get(r.invitationIds[0]))!;
    expect(p).toMatchObject({ note: 'Room 4', recordingNotice: true });
  });

  it('FLOW-27 TEAM-7: with independent scoring on, a judgement entered here is shown but imported ones stay hidden until your own is submitted', async () => {
    const { own } = await organiserWithBen();
    await setIndependentScoring(true);
    const id = await enterJudgement(own, judgement());
    const view = (await loadPanel(own))!;
    expect(view.entries.find((e) => e.session.origin === 'imported')!.hidden).toBe(true);
    expect(view.entries.find((e) => e.session.id === id)!.hidden).toBe(false);
    const f = await exportPanelFile([own]);
    expect(f.leftOut).toBe(1);
  });
});
