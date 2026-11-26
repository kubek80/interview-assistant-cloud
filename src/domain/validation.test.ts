import { describe, expect, it } from 'vitest';
import { canFinish, needsNote, validateCandidateInput, validatePlanFile, validateSessionFile, validateTrackFile } from './validation';
import { planFile, sessionFile } from './export';
import { makeAnswer, makeTrackFile, scored, skipped, workedExamplePlan } from '../test/fixtures';
import type { OverallAssessment, Session } from './types';
import compiledTrackSchema from './generated/trackSchemaValidator';

const compiledSchemaPresent = compiledTrackSchema !== null;

const overall: OverallAssessment = { rating: 3, recommendation: 'hire', rationale: 'Solid.' };

function submittedSession(planId: string): Session {
  return {
    id: 's1',
    planId,
    candidate: { initials: 'AB', requisitionId: 'R-1', consentAt: '2026-11-01T10:00:00.000Z', retentionUntil: '2027-01-30' },
    interviewer: { name: 'Pat' },
    state: 'submitted',
    currentQuestionId: null,
    timer: { accumulatedMs: 1000, runningSince: null },
    overall,
    createdAt: '2026-11-01T10:00:00.000Z',
    startedAt: '2026-11-01T10:01:00.000Z',
    submittedAt: '2026-11-01T11:00:00.000Z',
    origin: 'local',
  };
}

describe('canFinish', () => {
  const plan = workedExamplePlan();
  const complete = [scored('t-1', 4), scored('t-2', 3), scored('t-3', 2), skipped('t-4')];

  it('FLOW-22: a complete record has no problems', () => {
    expect(canFinish(plan, complete, overall)).toEqual([]);
  });

  it('FLOW-22: every question must be scored or skipped', () => {
    const problems = canFinish(plan, complete.slice(0, 3), overall);
    expect(problems).toEqual([expect.objectContaining({ code: 'unresolved', questionId: 't-4' })]);
    expect(canFinish(plan, [...complete.slice(0, 3), makeAnswer('t-4')], overall)[0].code).toBe('unresolved');
  });

  it('FLOW-16, RUB-4: a score of 1 or 4 without a note blocks finishing', () => {
    const noNote = makeAnswer('t-1', { score: 4 });
    expect(needsNote(noNote)).toBe(true);
    expect(needsNote(makeAnswer('t-1', { score: 1, notes: [{ atSec: 1, text: '  ' }] }))).toBe(true);
    expect(needsNote(makeAnswer('t-1', { score: 3 }))).toBe(false);
    const problems = canFinish(plan, [noNote, ...complete.slice(1)], overall);
    expect(problems).toEqual([expect.objectContaining({ code: 'note-required', questionId: 't-1' })]);
  });

  it('FLOW-22: overall rating, recommendation and rationale are required', () => {
    const codes = canFinish(plan, complete, { rating: null, recommendation: null, rationale: ' ' }).map((p) => p.code);
    expect(codes).toEqual(['overall-rating', 'recommendation', 'rationale']);
  });
});

describe('import validation', () => {
  it('SEC-2, DATA-4: a valid plan file passes; wrong kind, format version or tampered fingerprint fail', () => {
    const file = planFile(workedExamplePlan());
    expect(validatePlanFile(JSON.parse(JSON.stringify(file))).ok).toBe(true);
    expect(validatePlanFile({ ...file, kind: 'interview-session' }).ok).toBe(false);
    expect(validatePlanFile({ ...file, formatVersion: 99 }).ok).toBe(false);
    const tampered = { ...file, plan: { ...file.plan, categories: file.plan.categories.map((c) => ({ ...c, weight: 5 })) } };
    const r = validatePlanFile(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/fingerprint/);
  });

  it('SEC-2: an unlocked plan or malformed fields are rejected with readable errors', () => {
    const file = planFile(workedExamplePlan());
    expect(validatePlanFile({ ...file, plan: { ...file.plan, locked: false } }).ok).toBe(false);
    const r = validatePlanFile({ ...file, plan: { ...file.plan, questions: [{ id: 3 }] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/^plan\.questions\[0\]/);
    expect(validatePlanFile('nonsense').ok).toBe(false);
  });

  it('FLOW-27, SEC-2: only submitted session files are accepted', () => {
    const plan = workedExamplePlan();
    const answers = [scored('t-1', 4), scored('t-2', 3), scored('t-3', 2), skipped('t-4')];
    const file = sessionFile(plan, submittedSession(plan.id), answers);
    expect(validateSessionFile(JSON.parse(JSON.stringify(file)))).toMatchObject({ ok: true });
    const draft = sessionFile(plan, { ...submittedSession(plan.id), state: 'in_progress', submittedAt: null }, answers);
    expect(validateSessionFile(draft).ok).toBe(false);
  });

  it('PRIV-1, SEC-2: session files carry a name or initials (up to 60 characters, any script); anything else is rejected', () => {
    const plan = workedExamplePlan();
    const s = submittedSession(plan.id);
    const withName = (initials: string) => validateSessionFile(sessionFile(plan, { ...s, candidate: { ...s.candidate, initials } }, [])).ok;
    for (const ok of ['AB', 'Alice Smith', "Siobhán O’Neill-Brown", 'J. R. Tolkien', 'Zoë Ândrade', 'Иван Петров', '王小明']) expect(withName(ok), ok).toBe(true);
    for (const bad of ['', '   ', 'a'.repeat(61), 'alice@example.com', 'Ann 0412 345 678', '<b>Eve</b>', '-Ann']) expect(withName(bad), bad).toBe(false);
  });

  it('SEC-2: session answers must belong to the session and the plan', () => {
    const plan = workedExamplePlan();
    const file = sessionFile(plan, submittedSession(plan.id), [scored('t-99', 3)]);
    expect(validateSessionFile(file).ok).toBe(false);
  });

  it('SEC-2: answers ticking key points or red flags the question does not have are rejected', () => {
    const plan = workedExamplePlan();
    const ok = scored(plan.questions[0].id, 3);
    expect(validateSessionFile(sessionFile(plan, submittedSession(plan.id), [ok])).ok).toBe(true);
    const bad = { ...ok, coveredKeyPoints: [plan.questions[0].lookFor.length + 5] };
    const r = validateSessionFile(sessionFile(plan, submittedSession(plan.id), [bad]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/key point that does not exist/);
  });

  it('BANK-7, SEC-2: track files are validated, including unique ids and known categories', () => {
    expect(validateTrackFile(makeTrackFile()).ok).toBe(true);
    const bad = makeTrackFile();
    bad.questions[1].categoryId = 'nope';
    bad.questions[2].id = bad.questions[0].id;
    const r = validateTrackFile(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/unknown category[\s\S]*|duplicate question id/);
    expect(validateTrackFile({ track: {}, categories: [], questions: [] }).ok).toBe(false);
  });

  it('BANK-3, BANK-7: track files are also checked against schema/track.schema.json (compiled at build time)', () => {
    const extra = { ...makeTrackFile('tt', '2026.11'), unexpected: true };
    // additionalProperties: false in the schema; the hand-rolled checks alone would accept this.
    expect(validateTrackFile(extra).ok).toBe(!compiledSchemaPresent);
  });

  it('FLOW-7, PRIV-1, PRIV-4: candidate details need a name or initials, an interviewer and a retention date (consent comes later)', () => {
    const ok = { initials: 'AB', requisitionId: '', interviewerName: 'Pat', retentionUntil: '2027-02-01' };
    expect(validateCandidateInput(ok, '2026-11-24')).toEqual({});
    expect(validateCandidateInput({ ...ok, initials: ' Alice  Smith ' }, '2026-11-24')).toEqual({});
    expect(validateCandidateInput({ ...ok, initials: 'x'.repeat(61) }, '2026-11-24').initials).toMatch(/at most 60/);
    expect(validateCandidateInput({ ...ok, initials: 'ann@example.com' }, '2026-11-24').initials).toMatch(/letters, spaces/);
    const errs = validateCandidateInput({ ...ok, initials: ' ', interviewerName: '', retentionUntil: '2026-01-01' }, '2026-11-24');
    // Consent is not asked for here: it is confirmed on the ready screen (FLOW-7).
    expect(Object.keys(errs).sort()).toEqual(['initials', 'interviewerName', 'retentionUntil']);
  });
});
