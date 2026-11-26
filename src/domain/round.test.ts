// TEAM-7, TEAM-9, TEAM-12, SUM-1, SUM-2, SUM-3: the maths and words behind the Summary rows, the
// candidate page and the panel decision. Pure.
import { describe, expect, it } from 'vitest';
import { agreedScorecard, cleanDecision, decisionChanges, decisionProblems, enteredAnswers, enteredLabel, judgementProblems, medianScores } from './decision';
import { candidateDetail, outcomeOf, roundRow, scoreOf, stateOf, strengthsAndConcerns, tallyText, type RoundPanelData } from './round';
import { attendance } from './team';
import { computeScorecard } from './scoring';
import { makeAnswer, makeCategory, makePlan, makeQuestion, scored, skipped } from '../test/fixtures';
import type { Answer, PanelDecision, Session } from './types';

const catA = makeCategory({ id: 't-a', name: 'Alpha' });
const catB = makeCategory({ id: 't-b', name: 'Beta', mustHave: true });
const plan = makePlan(
  [makeQuestion({ id: 't-1', categoryId: 't-a' }), makeQuestion({ id: 't-2', categoryId: 't-a' }), makeQuestion({ id: 't-3', categoryId: 't-b' }), makeQuestion({ id: 't-4', categoryId: 't-b' })],
  [catA, catB],
);

function session(id: string, name: string, p: Partial<Session> = {}): Session {
  return {
    id,
    planId: plan.id,
    candidate: { initials: 'Ana Diaz', requisitionId: 'REQ-1', consentAt: null, retentionUntil: '2027-01-01' },
    interviewer: { name },
    interviewers: [name],
    state: 'submitted',
    currentQuestionId: null,
    timer: { accumulatedMs: 0, runningSince: null },
    overall: { rating: 3, recommendation: 'hire', rationale: 'ok' },
    createdAt: '2026-11-20T09:00:00.000Z',
    startedAt: '2026-11-20T09:00:00.000Z',
    submittedAt: '2026-11-20T10:00:00.000Z',
    origin: 'imported',
    ...p,
  };
}
const answersOf = (sid: string, scores: Array<number | null>) => scores.map((s, i) => (s == null ? makeAnswer(`t-${i + 1}`, { sessionId: sid }) : scored(`t-${i + 1}`, s as 1 | 2 | 3 | 4, { sessionId: sid })));
const entry = (s: Session, answers: Answer[] | null, hidden = false) => ({ session: s, hidden, answers: hidden ? null : answers, scorecard: hidden || !answers ? null : computeScorecard(plan, answers) });
const decision = (p: Partial<PanelDecision> = {}): PanelDecision => ({ recommendation: 'hire', rationale: 'Agreed', participants: ['Ben'], rating: null, scores: {}, recordedBy: 'Olive', recordedAt: '2026-11-21T09:00:00.000Z', ...p });

function data(p: Partial<RoundPanelData> = {}): RoundPanelData {
  return { ref: 'r1', panelKey: 'ANA DIAZ|REQ-1#fp', candidate: { initials: 'Ana Diaz', requisitionId: 'REQ-1' }, plan, trackName: 'QA', records: [], entries: [], expected: [], date: null, time: null, record: null, ...p };
}

describe('judgements entered by hand (TEAM-7, TEAM-8)', () => {
  it('TEAM-7: name, rating, recommendation and rationale are required; scores and notes are optional and only for the plan’s questions; a name with a judgement already is refused', () => {
    const ok = { name: 'Cy', rating: 2 as const, recommendation: 'hire' as const, rationale: 'Fine', scores: {}, notes: {} };
    expect(judgementProblems(ok, plan)).toEqual({});
    expect(Object.keys(judgementProblems({ ...ok, name: ' ', rating: null, recommendation: null, rationale: '' }, plan)).sort()).toEqual(['name', 'rating', 'rationale', 'recommendation']);
    expect(judgementProblems({ ...ok, scores: { 'x-9': 3 } }, plan).scores).toBeTruthy();
    expect(judgementProblems({ ...ok, scores: { 't-1': 7 as never } }, plan).scores).toBeTruthy();
    expect(judgementProblems(ok, plan, ['  cy ']).name).toMatch(/already has a judgement/);
  });

  it('TEAM-7: only questions with a score or a note are stored; unscored questions are left out like skipped ones (no percentage when none is scored)', () => {
    const a = enteredAnswers('s', plan, { scores: { 't-1': 4, 't-2': null }, notes: { 't-2': ' ran out of time ', 't-3': '' } });
    expect(a.map((x) => [x.questionId, x.score, x.notes.map((n) => n.text)])).toEqual([
      ['t-1', 4, []],
      ['t-2', null, ['ran out of time']],
    ]);
    const sc = computeScorecard(plan, a);
    expect(sc.answeredCount).toBe(1);
    expect(sc.coverage).toBeCloseTo(0.25);
    expect(computeScorecard(plan, enteredAnswers('s', plan, { scores: {}, notes: {} })).overallPct).toBeNull();
  });

  it('TEAM-8: the label says who entered it on whose behalf', () => {
    expect(enteredLabel(session('x', 'Cy Third', { origin: 'entered', enteredBy: 'Olive' }))).toBe('Entered by Olive on behalf of Cy Third');
    expect(enteredLabel(session('x', 'Cy Third'))).toBeNull();
  });
});

describe('panel decision (TEAM-9…TEAM-11)', () => {
  it('TEAM-9: recommendation and rationale are required, at least one person took part, agreed scores belong to the plan', () => {
    const ok = { recommendation: 'hire' as const, rationale: 'x', participants: ['Ben'], rating: null, scores: {} };
    expect(decisionProblems(ok, plan)).toEqual({});
    expect(Object.keys(decisionProblems({ ...ok, recommendation: null, rationale: ' ', participants: [' '] }, plan)).sort()).toEqual(['participants', 'rationale', 'recommendation']);
    expect(decisionProblems({ ...ok, participants: ['Ben', 'ben '] }, plan).participants).toBeTruthy();
    expect(decisionProblems({ ...ok, scores: { nope: 3 } }, plan).scores).toBeTruthy();
    expect(cleanDecision({ ...ok, participants: [' Ben  Ng ', 'Cy'], scores: { 't-1': 3, 't-2': null } })).toEqual({ ...ok, participants: ['Ben Ng', 'Cy'], scores: { 't-1': 3 } });
  });

  it('TEAM-9: "Start from the panel’s median" takes the median of the scores given per question, rounded half up; unscored questions stay empty', () => {
    const m = medianScores(plan, [answersOf('a', [2, 3, null, 1]), answersOf('b', [3, 3, null, 2]), [skipped('t-4')]]);
    expect(m).toEqual({ 't-1': 3, 't-2': 3, 't-4': 2 });
  });

  it('TEAM-11: decision changes are listed by field; participants compare ignoring case; agreed scores ignore key order', () => {
    const d = decision({ scores: { 't-1': 3, 't-2': 2 } });
    expect(decisionChanges(d, { ...d, participants: ['BEN'], scores: { 't-2': 2, 't-1': 3 } })).toEqual([]);
    expect(decisionChanges(d, { ...d, recommendation: 'no_hire', rating: 2 })).toEqual(['recommendation', 'rating']);
  });

  it('TEAM-12: agreed scores become a scorecard with the usual maths; none without agreed scores', () => {
    expect(agreedScorecard(plan, decision())).toBeNull();
    const sc = agreedScorecard(plan, decision({ scores: { 't-1': 4, 't-2': 4, 't-3': 4, 't-4': 4 } }))!;
    expect(sc.overallPct).toBe(100);
    expect(sc.band).toBe('strong_hire');
  });
});

describe('Summary rows (SUM-1, TEAM-12)', () => {
  it('SUM-1: agreement and split are said plainly; the decision is the outcome when there is one', () => {
    expect(tallyText([{ recommendation: 'hire', count: 2 }, { recommendation: 'lean_no_hire', count: 1 }])).toBe('Hire ×2, Lean no hire ×1');
    expect(outcomeOf(null, ['lean_no_hire', 'hire', 'hire', null])).toMatchObject({ kind: 'recommendations', split: true, text: 'Hire ×2, Lean no hire ×1', recommendation: null });
    expect(outcomeOf(null, ['hire', 'hire'])).toMatchObject({ split: false, recommendation: 'hire', text: 'Hire ×2' });
    expect(outcomeOf(null, [])).toMatchObject({ kind: 'none', rank: null });
    expect(outcomeOf(decision({ recommendation: 'no_hire' }), ['hire', 'hire'])).toMatchObject({ kind: 'decision', text: 'No hire', recommendation: 'no_hire', rank: 1, tally: [{ recommendation: 'hire', count: 2 }] });
  });

  it('TEAM-12 SUM-1: the score is the agreed scores, else the panel median, else the one interviewer, labelled which; judgements without question scores never count', () => {
    const ben = computeScorecard(plan, answersOf('b', [3, 3, 3, 3]));
    const cy = computeScorecard(plan, answersOf('c', [2, 2, 2, 2]));
    const none = computeScorecard(plan, []);
    expect(scoreOf(plan, null, []).score).toMatchObject({ source: 'none', label: 'No scores', pct: null });
    expect(scoreOf(plan, null, [{ names: ['Ben'], scorecard: ben }, { names: ['Dee'], scorecard: none }]).score).toMatchObject({ source: 'single', label: 'One interviewer (Ben)', members: 1 });
    const med = scoreOf(plan, null, [{ names: ['Ben'], scorecard: ben }, { names: ['Cy'], scorecard: cy }]).score;
    expect(med).toMatchObject({ source: 'median', label: 'Panel median of 2', band: 'lean_no_hire', spread: expect.closeTo(33.3, 1), spreadFlag: true });
    expect(med.pct).toBeCloseTo(50);
    const agreed = scoreOf(plan, decision({ scores: { 't-1': 4, 't-2': 4, 't-3': 4, 't-4': 4 } }), [{ names: ['Ben'], scorecard: ben }, { names: ['Cy'], scorecard: cy }]).score;
    expect(agreed).toMatchObject({ source: 'agreed', label: 'Agreed scores', pct: 100, band: 'strong_hire', members: 2 });
  });

  it('SUM-1: strengths and concerns come from the figure that stands for the panel (category medians for a median)', () => {
    const ben = computeScorecard(plan, answersOf('b', [4, 4, 1, 1]));
    expect(strengthsAndConcerns(ben.categories, null)).toEqual({ strengths: ['Alpha'], concerns: ['Beta'] });
    expect(strengthsAndConcerns(null, [{ name: 'Alpha', average: 3.5 }, { name: 'Beta', average: 2 }, { name: 'Gamma', average: null }])).toEqual({ strengths: ['Alpha'], concerns: ['Beta'] });
  });

  it('SUM-1 TEAM-6: what is missing: not interviewed, in progress, waiting for named people, no decision, decided (anyway)', () => {
    const exp = ['Ben', 'Cy'];
    const st = (records: Session[], d: PanelDecision | null = null) => stateOf({ decision: d, att: attendance(exp, records), records, submittedCount: records.filter((r) => r.state === 'submitted').length, date: null });
    const planned = session('o', 'Olive', { origin: 'local', state: 'planned', submittedAt: null });
    expect(st([planned])).toEqual({ state: 'not-interviewed', missing: ['Not interviewed yet'] });
    // The organiser's own ready-to-start record is not waited for (Olive is not expected).
    expect(st([planned, session('b', 'Ben')])).toEqual({ state: 'waiting', missing: ['Waiting for 1 judgement: Cy', 'No panel decision yet'] });
    expect(st([planned, session('b', 'Ben'), session('c', 'Cy', { origin: 'entered' })])).toEqual({ state: 'no-decision', missing: ['No panel decision yet'] });
    expect(st([session('b', 'Ben', { origin: 'local', state: 'in_progress', submittedAt: null })]).state).toBe('in-progress');
    expect(st([planned], decision())).toEqual({ state: 'decided', missing: ['Waiting for 2 judgements: Ben and Cy (decided anyway)'] });
  });

  it('SUM-1 FLOW-27: hidden judgements count as submitted but show no recommendation or score', () => {
    const b = session('b', 'Ben', { overall: { rating: 4, recommendation: 'strong_hire', rationale: '' } });
    const row = roundRow(data({ records: [b], entries: [entry(b, answersOf('b', [4, 4, 4, 4]), true)], expected: ['Ben'] }));
    expect(row).toMatchObject({ hidden: 1, state: 'no-decision', outcome: { kind: 'none' }, score: { source: 'none' } });
    expect(row.judgements[0]).toMatchObject({ hidden: true, recommendation: null, scorecard: null });
  });

  it('SUM-1: the date is the planned day, else the first interview day; interviewers are the expected plus anyone who submitted', () => {
    const b = session('b', 'Ben', { startedAt: '2026-11-18T09:00:00.000Z' });
    const c = session('c', 'Cy', { origin: 'entered', startedAt: null, submittedAt: '2026-11-22T09:00:00.000Z' });
    const row = roundRow(data({ records: [b, c], entries: [entry(b, answersOf('b', [3, 3, 3, 3])), entry(c, [])], expected: ['Ben', 'Dee'] }));
    expect(row.date).toBe('2026-11-18');
    expect(row.interviewers).toEqual(['Ben', 'Dee', 'Cy']);
    expect(row.judgements.map((j) => j.entered)).toEqual([false, true]);
    expect(roundRow(data({ date: '2026-12-01', time: '10:00' }))).toMatchObject({ date: '2026-12-01', time: '10:00', state: 'not-interviewed' });
  });
});

describe('candidate page (SUM-3)', () => {
  it('SUM-3: strongest (3+) and weakest (2 or less) answers with each interviewer’s notes; flagged and skipped questions; categories per interviewer with the panel figure', () => {
    const b = session('b', 'Ben');
    const c = session('c', 'Cy');
    const bAns = [scored('t-1', 4, { sessionId: 'b', notes: [{ atSec: 1, text: 'Great example' }] }), scored('t-2', 3, { sessionId: 'b', flagged: true }), scored('t-3', 1, { sessionId: 'b', notes: [{ atSec: 2, text: 'Wrong' }] }), skipped('t-4')].map((a) => ({ ...a, sessionId: 'b' }));
    const cAns = answersOf('c', [4, 2, 2, 2]);
    const d = candidateDetail(data({ entries: [entry(b, bAns), entry(c, cAns)] }));
    expect(d.columns.map((x) => x.label)).toEqual(['Ben', 'Cy']);
    expect(d.strongest.map((h) => [h.questionId, h.score])).toEqual([['t-1', 4]]);
    expect(d.strongest[0].by).toEqual([
      { names: ['Ben'], score: 4, notes: ['Great example'] },
      { names: ['Cy'], score: 4, notes: ['evidence'] },
    ]);
    expect(d.weakest.map((h) => [h.questionId, h.score])).toEqual([['t-3', 1.5], ['t-4', 2]]);
    expect(d.flagged).toEqual([{ index: 1, text: 'Question t-2', by: ['Ben'] }]);
    expect(d.skipped).toEqual([{ index: 3, text: 'Question t-4', by: 'Ben', reason: 'Out of time' }]);
    expect(d.categories.map((x) => [x.name, x.averages, x.figure])).toEqual([
      ['Alpha', [3.5, 3], 3.25],
      ['Beta', [1, 2], 1.5],
    ]);
    // With agreed scores, the agreed column comes first and is the panel figure.
    const agreed = candidateDetail(data({ entries: [entry(b, bAns)], record: { decision: decision({ scores: { 't-3': 3 } }) } as never }));
    expect(agreed.columns[0]).toEqual({ label: 'Agreed', source: 'agreed' });
    expect(agreed.strongest.map((h) => h.questionId)).toEqual(['t-1', 't-2', 't-3']);
  });
});
