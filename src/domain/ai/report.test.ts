// AI-7, AI-10, AI-11: the AI report beside the human scorecard, and its exports.
import { describe, expect, it } from 'vitest';
import { makeAnswer, scored, skipped, workedExamplePlan } from '../../test/fixtures';
import { computeScorecard } from '../scoring';
import { scorecardCsv, scorecardMarkdown } from '../export';
import type { Session } from '../types';
import { buildAiReport, compareTicks, formatDifference, isNotCandidateQuote } from './report';
import type { AiSecondOpinion } from './types';

const plan = workedExamplePlan();
const answers = [scored('t-1', 4, { coveredKeyPoints: [0, 1] }), scored('t-2', 3), scored('t-3', 2), skipped('t-4')];
const human = computeScorecard(plan, answers);
const result: AiSecondOpinion = {
  kind: 'ai-second-opinion',
  formatVersion: 1,
  model: 'test-model',
  createdAt: '2026-11-24T10:00:00.000Z',
  transcriptHash: 'a'.repeat(64),
  planFingerprint: plan.fingerprint,
  durationMs: 1000,
  unverifiedQuoteCount: 1,
  questions: [
    { questionId: 't-1', covered: true, score: 2, coveredKeyPoints: [1, 2], redFlagsSeen: [], rationale: 'Thin answer.', quotes: [{ text: 'we test', status: 'verified', line: 2, speaker: 'Candidate' }] },
    { questionId: 't-2', covered: true, score: 3, coveredKeyPoints: [], redFlagsSeen: [0], rationale: 'Fine.', quotes: [{ text: 'tell me', status: 'verified', line: 1, speaker: 'Interviewer 1' }] },
    { questionId: 't-3', covered: false, score: null, coveredKeyPoints: [], redFlagsSeen: [], rationale: 'Not discussed.', quotes: [] },
    { questionId: 't-4', covered: true, score: 4, coveredKeyPoints: [], redFlagsSeen: [], rationale: 'Great.', quotes: [{ text: 'made up', status: 'unverified', line: null, speaker: null }] },
  ],
};

describe('AI report', () => {
  it('AI-7 AI-8 AI-10 OV-4: the AI scorecard uses the human maths on its own scores; the human scorecard and answers are not changed', () => {
    const before = JSON.stringify({ human, answers });
    const r = buildAiReport(plan, human, result, 'a'.repeat(64));
    expect(JSON.stringify({ human, answers })).toBe(before);
    // AI answered t-1 (2), t-2 (3), t-4 (4); t-3 not covered counts as skipped.
    const expected = computeScorecard(plan, [makeAnswer('t-1', { score: 2 }), makeAnswer('t-2', { score: 3 }), makeAnswer('t-3', { skipped: true, skipReason: 'x' }), makeAnswer('t-4', { score: 4 })]);
    expect(r.aiScorecard.overallPct).toBeCloseTo(expected.overallPct!, 10);
    expect(r.aiScorecard.coverage).toBeCloseTo(expected.coverage, 10);
    expect(human.overallPct).toBeCloseTo(59.72, 2);
    expect(r.outOfDate).toBe(false);
    expect(buildAiReport(plan, human, result, 'b'.repeat(64)).outOfDate).toBe(true);
    expect(buildAiReport(plan, human, result, null).outOfDate).toBe(true);
  });

  it('AI-11: differences, worth discussing (2 or more), ticks side by side and interviewer quotations flagged', () => {
    const r = buildAiReport(plan, human, result, null);
    expect(r.comparison.rows.map((x) => x.difference)).toEqual([-2, 0, null, null]);
    expect(r.comparison.worthDiscussing.map((x) => x.question.id)).toEqual(['t-1']);
    expect(compareTicks(r.comparison.rows[0], answers[0]).keyPoints.map((k) => k.agreement)).toEqual(['interviewers-only', 'both', 'ai-only', 'neither']);
    expect(isNotCandidateQuote(result.questions[1].quotes[0])).toBe(true);
    expect(isNotCandidateQuote(result.questions[0].quotes[0])).toBe(false);
    expect(isNotCandidateQuote(result.questions[3].quotes[0])).toBe(false);
    expect([2, -1, 0, null].map(formatDifference)).toEqual(['+2', '-1', '0', null]);
  });

  it('AI-11: exports add the AI under its own label; without an AI result they are unchanged', () => {
    const session = { id: 's1', candidate: { initials: 'AB', requisitionId: null }, interviewer: { name: 'Ana' }, state: 'submitted', submittedAt: '2026-11-24T10:00:00.000Z', overall: { rating: 3, recommendation: 'hire', rationale: 'ok' } } as unknown as Session;
    const r = buildAiReport(plan, human, result, 'b'.repeat(64));
    expect(scorecardMarkdown(plan, session, human, null)).toBe(scorecardMarkdown(plan, session, human));
    expect(scorecardMarkdown(plan, session, human)).not.toContain('AI second opinion');
    const md = scorecardMarkdown(plan, session, human, r);
    expect(md.indexOf('## AI second opinion (test-model), not a decision')).toBeGreaterThan(md.indexOf('_The band is advisory.'));
    expect(md).toContain('**Out of date:**');
    expect(md).toContain('| 3 | Question t-3 | 2 | Not covered | – |');
    expect(md).toContain('| 4 | Question t-4 | Skipped | 4 | – |');
    expect(md).toContain('Unverified quotations (not found in the transcript): 1');
    expect(scorecardCsv(human)).toBe(scorecardCsv(human, null));
    const [header, first] = scorecardCsv(human, r).split('\r\n');
    const cols = header.split(',');
    expect(cols.slice(20)).toEqual(expect.arrayContaining(['AI second opinion: score', 'AI second opinion: rationale']));
    expect(cols.slice(20).every((c) => c.startsWith('AI second opinion: '))).toBe(true);
    expect(first.split(',')[9]).toBe('4'); // the interviewers' score column is unchanged
    expect(first.split(',')[20]).toBe('2');
  });
});
